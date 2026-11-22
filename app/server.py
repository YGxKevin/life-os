#!/usr/bin/env python3
"""LIFE//OS Life Dashboard 本機伺服器。

- 提供看板網頁（這個資料夾內的靜態檔）
- GET  /api/state  讀取 data.json（還沒有資料時回傳 null）
- PUT  /api/state  把看板目前的資料寫回 data.json（每天第一次寫入前，先備份到 backups/）
- GET  /api/rev    只回傳目前的版本號與存檔時間（給多裝置同步用，很輕）
- GET  /api/sounds 列出 sounds/ 資料夾裡的音檔（音效庫：把 mp3/wav/ogg/m4a 丟進去就會出現在音色清單）
- GET  /api/update 版本與自動更新狀態；POST /api/update 立刻檢查更新（只有 Windows 版、由 boot.py 啟動時才會更新）
- POST /api/quit   關掉伺服器（boot.py 啟動時才有，給「關閉看板」用）

多裝置：每次存檔都會蓋上版本號 _rev 與時間戳 _savedAt。
裝置存檔時要附上它載入時的版本號；如果這期間別的裝置已經存過（版本號對不上），
就回 409 拒絕，避免用舊資料把別人剛存的蓋掉。

只聽 127.0.0.1，不直接對外開放。要給手機／其他電腦用，請用 Tailscale Serve 轉進來
（見「部署到常駐Mac.command」）。用法：python3 server.py [port] [--port N] [--data 資料夾]
--data：data.json 和 backups/ 放哪裡（預設跟程式同一個資料夾）。Windows 版放在程式旁邊的 data/，更新程式不會動到它。
"""
import argparse
import datetime
import gzip
import hashlib
import io
import ipaddress
import json
import os
import shutil
import socket
import ssl
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

for _n in ("stdout", "stderr"):                    # pythonw（Windows 沒有主控台）時 sys.stderr 是 None，寫 log 會出錯
    if getattr(sys, _n) is None:
        setattr(sys, _n, open(os.devnull, "w", encoding="utf-8"))

ROOT = os.path.realpath(os.path.dirname(os.path.abspath(__file__)))
_ap = argparse.ArgumentParser(add_help=False)
_ap.add_argument("pos_port", nargs="?", type=int)
_ap.add_argument("--port", type=int)
_ap.add_argument("--data")
ARGS, _ = _ap.parse_known_args()
PORT = ARGS.port or ARGS.pos_port or int(os.environ.get("KOS_PORT") or 4173)
DATA_DIR = os.path.realpath(ARGS.data or os.environ.get("KOS_DATA") or ROOT)
DATA = os.path.join(DATA_DIR, "data.json")
BACKUPS = os.path.join(DATA_DIR, "backups")
SOUNDS = os.path.join(ROOT, "sounds")
AUDIO_EXT = (".mp3", ".wav", ".ogg", ".m4a")
MAX_BODY = 20 * 1024 * 1024
KEEP_BACKUPS = 30
LOCK = threading.RLock()                           # 讀寫 data.json 都要拿鎖：Windows 上檔案正被讀的時候不能換掉
TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
         ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".txt": "text/plain; charset=utf-8",
         ".woff2": "font/woff2", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".m4a": "audio/mp4",
         ".png": "image/png", ".ico": "image/x-icon"}
ZIP_EXT = (".html", ".js", ".css", ".svg", ".txt")
STATIC_CACHE = {}   # 路徑 → (etag, 原始內容, gzip 內容)

# 允許的網址主機名：本機、Tailscale 的 *.ts.net 名稱與 100.64.0.0/10 位址。
# 其他名稱一律拒絕（擋掉惡意網頁用假網域打本機 API）。要額外放行可設環境變數 KOS_ALLOWED_HOSTS=a,b
TAILNET = ipaddress.ip_network("100.64.0.0/10")
EXTRA_HOSTS = {h.strip().lower() for h in os.environ.get("KOS_ALLOWED_HOSTS", "").split(",") if h.strip()}


def read_state():
    """回傳 data.json 的內容；檔案不存在回傳 None；格式壞掉丟 ValueError。"""
    with LOCK:
        if not os.path.exists(DATA):
            return None
        with open(DATA, "r", encoding="utf-8") as f:
            return json.load(f)


def replace_file(src, dst):
    """os.replace；Windows 上目的檔剛好被防毒軟體或備份程式打開時會失敗，等一下再試。"""
    for i in range(20):
        try:
            return os.replace(src, dst)
        except PermissionError:
            if i == 19:
                raise
            time.sleep(0.1)


def local_version():
    try:
        with open(os.path.join(ROOT, "VERSION"), encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return ""


class Updater:
    """自動更新（Windows 版）：從 GitHub 最新的 release 抓 app.zip，核對 sha256，解到 app.next/，
    再結束伺服器（代碼 75）讓 boot.py 換上新版重開。新版開不起來，boot.py 會退回舊版並記下這一版不再裝。
    只有程式資料夾裡有 update.json、而且是 boot.py 啟動的（KOS_BOOT=1）才會動；Mac 上的正式主機不會自己更新。"""
    EVERY = 6 * 3600
    RESTART = 75

    def __init__(self):
        self.lock = threading.Lock()
        self.status, self.latest, self.error, self.checked = "idle", "", "", 0
        self.server = None
        self.exit_code = 0
        self.last_write = 0.0
        try:
            with open(os.path.join(ROOT, "update.json"), encoding="utf-8") as f:
                cfg = json.load(f)
        except (OSError, ValueError):
            cfg = {}
        self.api = cfg.get("api") or ("https://api.github.com/repos/%s/releases/latest" % cfg["repo"] if cfg.get("repo") else "")
        self.enabled = bool(self.api) and os.environ.get("KOS_BOOT") == "1"

    def info(self):
        return {"version": local_version(), "updatable": self.enabled, "status": self.status, "latest": self.latest,
                "error": self.error, "checked": int(self.checked)}

    @staticmethod
    def _ctx():
        ctx = ssl.create_default_context()
        if sys.platform == "darwin" and os.path.exists("/etc/ssl/cert.pem"):   # python.org 的 Mac 版沒帶憑證
            ctx.load_verify_locations("/etc/ssl/cert.pem")
        return ctx

    def _get(self, url, limit=40 * 1024 * 1024):
        req = urllib.request.Request(url, headers={"User-Agent": "LifeOS-Updater", "Accept": "application/vnd.github+json, */*"})
        with urllib.request.urlopen(req, timeout=30, context=self._ctx() if url.startswith("https") else None) as r:
            data = r.read(limit + 1)
        if len(data) > limit:
            raise ValueError("檔案太大")
        return data

    def _skipped(self):
        try:
            with open(os.path.join(DATA_DIR, "update-skip.txt"), encoding="utf-8") as f:
                return {x.strip() for x in f if x.strip()}
        except OSError:
            return set()

    def check(self):
        if not self.enabled:
            return self.info()
        with self.lock:
            if self.status == "staged":
                return self.info()
            try:
                rel = json.loads(self._get(self.api, 2 * 1024 * 1024))
                tag = str(rel.get("tag_name") or "").lstrip("v")
                self.latest, self.checked, self.error = tag, time.time(), ""
                if not tag or tag == local_version():
                    self.status = "latest"
                elif tag in self._skipped():
                    self.status = "skipped"
                else:
                    assets = {a.get("name"): a.get("browser_download_url") for a in rel.get("assets") or []}
                    if not assets.get("app.zip") or not assets.get("app.zip.sha256"):
                        raise ValueError("release 少了 app.zip")
                    want = self._get(assets["app.zip.sha256"], 4096).decode("ascii", "replace").split()[0].lower()
                    data = self._get(assets["app.zip"])
                    if hashlib.sha256(data).hexdigest() != want:
                        raise ValueError("app.zip 的 sha256 不符")
                    self._stage(data, tag)
                    self.status = "staged"
                    threading.Thread(target=self._restart_when_idle, daemon=True).start()
            except (urllib.error.URLError, socket.timeout, ConnectionError, ssl.SSLError) as e:
                self.status, self.error = "offline", str(getattr(e, "reason", e))
            except Exception as e:               # 任何問題都不能讓看板停掉：記下來，下次再試
                self.status, self.error = "error", str(e)
            return self.info()

    def _stage(self, data, tag):
        nxt = os.path.join(os.path.dirname(ROOT), "app.next")
        shutil.rmtree(nxt, ignore_errors=True)
        base = os.path.realpath(nxt)
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            for name in z.namelist():
                t = os.path.realpath(os.path.join(nxt, name))
                if t != base and not t.startswith(base + os.sep):
                    raise ValueError("app.zip 裡有不安全的路徑")
            z.extractall(nxt)
        with open(os.path.join(nxt, "VERSION"), encoding="utf-8") as f:
            if f.read().strip() != tag:
                raise ValueError("app.zip 的版本號和 release 不一致")
        for n in ("index.html", "app.js", "style.css", "server.py"):
            if not os.path.isfile(os.path.join(nxt, n)):
                raise ValueError("app.zip 少了 " + n)
        if os.path.isdir(SOUNDS):                # 自己丟進 sounds/ 的音檔留著
            os.makedirs(os.path.join(nxt, "sounds"), exist_ok=True)
            for n in os.listdir(SOUNDS):
                if not os.path.exists(os.path.join(nxt, "sounds", n)):
                    shutil.copy2(os.path.join(SOUNDS, n), os.path.join(nxt, "sounds", n))
        if not os.path.exists(os.path.join(nxt, "update.json")) and os.path.exists(os.path.join(ROOT, "update.json")):
            shutil.copy2(os.path.join(ROOT, "update.json"), os.path.join(nxt, "update.json"))
        with open(os.path.join(nxt, ".ready"), "w", encoding="utf-8") as f:
            f.write(tag)

    def _restart_when_idle(self):
        """等 20 秒沒有存檔再重開（重開約 1 秒，看板會自己重連、換新版）"""
        while time.time() - self.last_write < 20:
            time.sleep(2)
        self.exit_code = self.RESTART
        if self.server:
            self.server.shutdown()

    def loop(self):
        time.sleep(20)
        while True:
            self.check()
            time.sleep(self.EVERY if self.status != "offline" else 1800)


UPDATER = Updater()


CODE_FILES = ("index.html", "app.js", "style.css")


def code_ver():
    """程式版本：三個程式檔的修改時間＋大小。部署新版它就變，前端看到變了會自己重新載入。"""
    parts = []
    for n in CODE_FILES:
        try:
            st = os.stat(os.path.join(ROOT, n))
            parts.append("%x-%x" % (st.st_mtime_ns, st.st_size))
        except OSError:
            parts.append("-")
    return hashlib.md5("|".join(parts).encode()).hexdigest()[:10]


def meta(state):
    state = state or {}
    return {"rev": int(state.get("_rev") or 0), "savedAt": state.get("_savedAt") or "", "by": state.get("_by") or ""}


class Handler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"                  # 連線重複用，不用每個請求重新握手
    timeout = 75                                   # 閒置的連線自己斷，不佔著執行緒

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, fmt, *args):  # 只記錄寫入與錯誤
        if self.command != "GET" or (len(args) > 1 and str(args[1]) >= "400"):
            super().log_message(fmt, *args)

    def _host_ok(self):
        host = (self.headers.get("Host") or "").strip().lower()
        if host.startswith("["):                      # IPv6：[::1]:4173
            host = host[1:].split("]")[0]
        elif host.count(":") == 1:                    # name:port
            host = host.split(":")[0]
        if host in ("localhost", "127.0.0.1", "::1") or host in EXTRA_HOSTS or host.endswith(".ts.net"):
            return True
        try:
            return ipaddress.ip_address(host) in TAILNET
        except ValueError:
            return False

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if code >= 400:                                # 出錯時可能還沒讀完對方送來的內容：這條連線不再重複用
            self.send_header("Connection", "close")
            self.close_connection = True
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _static(self, path):
        """靜態檔：ETag（沒變回 304）、文字檔 gzip（壓好的留在記憶體）。字型／音效幾乎不會變 → 瀏覽器快取 30 天；
        html／js／css 每次用 ETag 問一下有沒有新版（改了程式重新整理就生效）。"""
        rel = urllib.parse.unquote(path).lstrip("/") or "index.html"
        if rel == "favicon.ico" and not os.path.isfile(os.path.join(ROOT, rel)):
            rel = "icon.png"                           # 瀏覽器會自己來要 /favicon.ico
        p = os.path.realpath(os.path.join(ROOT, rel))
        if not p.startswith(ROOT + os.sep) or not os.path.isfile(p):
            return self._json(404, {"error": "not found"})
        st = os.stat(p)
        ext = os.path.splitext(p)[1].lower()
        etag = '"%x-%x"' % (st.st_mtime_ns, st.st_size)
        is_index = rel == "index.html"
        if is_index:                                   # index.html 裡的 app.js／style.css 帶上版本號，換版一定抓新檔
            ver = code_ver()
            etag = '"i-%s"' % ver
        cache = "public, max-age=2592000" if ext in (".woff2",) + AUDIO_EXT else "no-cache"
        if ext == ".json":
            cache = "no-store"
        if self.headers.get("If-None-Match") == etag:
            self.send_response(304)
            self.send_header("ETag", etag)
            self.send_header("Cache-Control", cache)
            self.end_headers()
            return
        hit = STATIC_CACHE.get(p)
        if not hit or hit[0] != etag:
            with open(p, "rb") as f:
                raw = f.read()
            if is_index:
                raw = raw.replace(b'src="app.js"', b'src="app.js?v=' + ver.encode() + b'"').replace(b'href="style.css"', b'href="style.css?v=' + ver.encode() + b'"')
            hit = (etag, raw, gzip.compress(raw, 9) if ext in ZIP_EXT else None)
            if ext in ZIP_EXT or ext == ".woff2":
                STATIC_CACHE[p] = hit
        body = hit[1]
        self.send_response(200)
        self.send_header("Content-Type", TYPES.get(ext, "application/octet-stream"))
        if hit[2] is not None:
            self.send_header("Vary", "Accept-Encoding")
            if "gzip" in (self.headers.get("Accept-Encoding") or ""):
                body = hit[2]
                self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("ETag", etag)
        self.send_header("Cache-Control", cache)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path.startswith("/api/"):
            if not self._host_ok():
                return self._json(403, {"error": "forbidden host"})
            if path == "/api/update":
                return self._json(200, UPDATER.info())
            if path == "/api/sounds":
                names = []
                if os.path.isdir(SOUNDS):
                    names = sorted(n for n in os.listdir(SOUNDS) if n.lower().endswith(AUDIO_EXT) and not n.startswith("."))
                return self._json(200, names)
            if path in ("/api/state", "/api/rev"):
                try:
                    state = read_state()
                except ValueError:
                    return self._json(500, {"error": "data.json 格式壞了，請從 backups/ 還原"})
                return self._json(200, state if path == "/api/state" else dict(meta(state), code=code_ver()))
            return self._json(404, {"error": "not found"})
        return self._static(path)

    do_HEAD = do_GET

    def _write_state(self):
        path = self.path.split("?")[0]
        if path in ("/api/update", "/api/quit"):
            if not self._host_ok():
                return self._json(403, {"error": "forbidden host"})
            if path == "/api/update":
                return self._json(200, UPDATER.check())
            if os.environ.get("KOS_BOOT") != "1":
                return self._json(404, {"error": "not found"})
            self._json(200, {"ok": True})
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return
        if path != "/api/state":
            return self._json(404, {"error": "not found"})
        if not self._host_ok():
            return self._json(403, {"error": "forbidden host"})
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY:
            return self._json(413, {"error": "bad size"})
        try:
            state = json.loads(self.rfile.read(length).decode("utf-8"))
        except ValueError:
            return self._json(400, {"error": "bad json"})
        if not isinstance(state, dict) or not isinstance(state.get("projects"), list):
            return self._json(400, {"error": "bad state"})

        with LOCK:
            try:
                current = read_state()
            except ValueError:
                return self._json(500, {"error": "data.json 格式壞了，請從 backups/ 還原"})
            cur = meta(current)
            if current is not None and int(state.get("_rev") or 0) != cur["rev"]:
                # 這個裝置手上的是舊版本：別的裝置已經存過了，拒絕覆寫
                return self._json(409, dict(cur, error="conflict"))

            UPDATER.last_write = time.time()
            if current is not None:
                os.makedirs(BACKUPS, exist_ok=True)
                backup = os.path.join(BACKUPS, "data-%s.json" % datetime.date.today().strftime("%Y%m%d"))
                if not os.path.exists(backup):
                    shutil.copy2(DATA, backup)
                    old = sorted(n for n in os.listdir(BACKUPS) if n.startswith("data-") and n.endswith(".json"))
                    for name in old[:-KEEP_BACKUPS]:
                        os.remove(os.path.join(BACKUPS, name))

            state["_rev"] = cur["rev"] + 1
            state["_savedAt"] = datetime.datetime.now().isoformat(timespec="seconds")
            os.makedirs(DATA_DIR, exist_ok=True)
            tmp = DATA + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(state, f, ensure_ascii=False, indent=1)
            replace_file(tmp, DATA)
            return self._json(200, dict(meta(state), ok=True))

    do_PUT = _write_state
    do_POST = _write_state


class Server(ThreadingHTTPServer):
    allow_reuse_address = os.name != "nt"          # Windows 的 SO_REUSEADDR 會讓兩個程式搶同一個 port，改用獨佔

    def server_bind(self):
        if os.name == "nt":
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


if __name__ == "__main__":
    server = Server(("127.0.0.1", PORT), Handler)
    print("LIFE//OS Life Dashboard → http://localhost:%d/  data: %s" % (PORT, DATA_DIR), flush=True)
    UPDATER.server = server
    if UPDATER.enabled:
        threading.Thread(target=UPDATER.loop, daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    server.server_close()
    sys.exit(UPDATER.exit_code)
