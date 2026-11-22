#!/usr/bin/env python3
"""LIFE//OS Life Dashboard 本機伺服器。

- 提供看板網頁（這個資料夾內的靜態檔）
- GET  /api/state  讀取 data.json（還沒有資料時回傳 null）
- PUT  /api/state  把看板目前的資料寫回 data.json（每天第一次寫入前，先備份到 backups/）
- GET  /api/rev    只回傳目前的版本號與存檔時間（給多裝置同步用，很輕）
- GET  /api/sounds 列出 sounds/ 資料夾裡的音檔（音效庫：把 mp3/wav/ogg/m4a 丟進去就會出現在音色清單）
- GET  /api/update 版本與自動更新狀態；POST /api/update 立刻檢查更新（只有 Windows 版、由 boot.py 啟動時才會更新）
- POST /api/quit   關掉伺服器（boot.py 啟動時才有，給「關閉看板」用）
- GET  /api/lan    手機連線狀態；POST /api/lan {"on": true/false} 開關（只有電腦本機能改，改完自動重開）；GET /api/lan/qr.svg 手機掃的 QR code
  手機連線（只有 Windows 版）：開了就聽所有網卡，同一個 Wi-Fi 的手機掃 QR code 進來。網址帶一組鑰匙 ?k=，
  第一次進來換成 cookie；沒有鑰匙的一律擋掉（同一個 Wi-Fi 的其他人看不到資料）。關掉再打開會換新鑰匙，舊手機要重掃。

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
import hmac
import secrets
from http.cookies import SimpleCookie
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

NET_FILE = os.path.join(DATA_DIR, "kos-net.json")
try:
    with open(NET_FILE, encoding="utf-8") as _f:
        NET = json.load(_f)
except (OSError, ValueError):
    NET = {}
LAN_OK = os.environ.get("KOS_BOOT") == "1"          # 只有 Windows 版（boot.py 啟動）能開手機連線；Mac 上用 Tailscale
LAN_ON = LAN_OK and bool(NET.get("lan")) and len(str(NET.get("key") or "")) >= 12


def lan_ip():
    """這台電腦在區網的位址（UDP connect 不會真的送封包，只是問系統走哪張網卡）"""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        ip = s.getsockname()[0]
    except OSError:
        ip = ""
    finally:
        s.close()
    return "" if ip.startswith("127.") or ip.startswith("0.") else ip


def lan_info(local):
    ip = lan_ip() if LAN_ON else ""
    return {"available": LAN_OK, "local": local, "on": LAN_ON, "ip": ip,
            "url": "http://%s:%d/?k=%s" % (ip, PORT, NET["key"]) if (LAN_ON and ip and local) else ""}


# ── QR code（手機連線用）：位元組模式、錯誤更正 M、版本 1–9（最多約 180 字）。照 QR 規格自己寫，不用任何套件 ──
_QR_EC = {1: (10, [16]), 2: (16, [28]), 3: (26, [44]), 4: (18, [32, 32]), 5: (24, [43, 43]), 6: (16, [27] * 4),
          7: (18, [31] * 4), 8: (22, [38, 38, 39, 39]), 9: (22, [36, 36, 36, 37, 37])}
_QR_ALIGN = {1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46]}


def _gf_mul(x, y):
    z = 0
    for i in range(7, -1, -1):
        z = (z << 1) ^ ((z >> 7) * 0x11D)
        z ^= ((y >> i) & 1) * x
    return z & 0xFF


def _rs(data, degree):
    div = [0] * (degree - 1) + [1]
    root = 1
    for _ in range(degree):
        for j in range(degree):
            div[j] = _gf_mul(div[j], root)
            if j + 1 < degree:
                div[j] ^= div[j + 1]
        root = _gf_mul(root, 2)
    res = [0] * degree
    for b in data:
        f = b ^ res.pop(0)
        res.append(0)
        for i in range(degree):
            res[i] ^= _gf_mul(div[i], f)
    return res


def qr_matrix(text):
    """回傳 [[bool]]（True＝黑），找不到放得下的版本丟 ValueError"""
    data = text.encode("utf-8")
    for ver in range(1, 10):
        ecl, blocks = _QR_EC[ver]
        cap = sum(blocks)
        if 4 + 8 + len(data) * 8 <= cap * 8:
            break
    else:
        raise ValueError("太長了")
    bits = [0, 1, 0, 0] + [(len(data) >> i) & 1 for i in range(7, -1, -1)]
    for b in data:
        bits += [(b >> i) & 1 for i in range(7, -1, -1)]
    bits += [0] * min(4, cap * 8 - len(bits))
    bits += [0] * (-len(bits) % 8)
    words = [int("".join(map(str, bits[i:i + 8])), 2) for i in range(0, len(bits), 8)]
    pad = 0xEC
    while len(words) < cap:
        words.append(pad)
        pad ^= 0xEC ^ 0x11
    chunks, k = [], 0
    for n in blocks:
        chunks.append(words[k:k + n])
        k += n
    eccs = [_rs(c, ecl) for c in chunks]
    final = []
    for i in range(max(blocks)):
        for c in chunks:
            if i < len(c):
                final.append(c[i])
    for i in range(ecl):
        for e in eccs:
            final.append(e[i])

    size = 17 + 4 * ver
    mod = [[False] * size for _ in range(size)]
    fn = [[False] * size for _ in range(size)]

    def setf(x, y, v):
        mod[y][x] = v
        fn[y][x] = True

    for i in range(size):
        setf(6, i, i % 2 == 0)
        setf(i, 6, i % 2 == 0)
    for cx, cy in ((3, 3), (size - 4, 3), (3, size - 4)):
        for dy in range(-4, 5):
            for dx in range(-4, 5):
                x, y = cx + dx, cy + dy
                if 0 <= x < size and 0 <= y < size:
                    setf(x, y, max(abs(dx), abs(dy)) not in (2, 4))
    al = _QR_ALIGN[ver]
    for i, ay in enumerate(al):
        for j, ax in enumerate(al):
            if (i == 0 and j == 0) or (i == 0 and j == len(al) - 1) or (i == len(al) - 1 and j == 0):
                continue
            for dy in range(-2, 3):
                for dx in range(-2, 3):
                    setf(ax + dx, ay + dy, max(abs(dx), abs(dy)) != 1)

    def draw_format(mask):
        d = (0 << 3) | mask                            # 錯誤更正 M 的格式碼是 00
        rem = d
        for _ in range(10):
            rem = (rem << 1) ^ ((rem >> 9) * 0x537)
        b = ((d << 10) | rem) ^ 0x5412
        bit = lambda i: (b >> i) & 1 == 1
        for i in range(6):
            setf(8, i, bit(i))
        setf(8, 7, bit(6))
        setf(8, 8, bit(7))
        setf(7, 8, bit(8))
        for i in range(9, 15):
            setf(14 - i, 8, bit(i))
        for i in range(8):
            setf(size - 1 - i, 8, bit(i))
        for i in range(8, 15):
            setf(8, size - 15 + i, bit(i))
        setf(8, size - 8, True)

    draw_format(0)
    if ver >= 7:
        rem = ver
        for _ in range(12):
            rem = (rem << 1) ^ ((rem >> 11) * 0x1F25)
        b = (ver << 12) | rem
        for i in range(18):
            v = (b >> i) & 1 == 1
            a, c = size - 11 + i % 3, i // 3
            setf(a, c, v)
            setf(c, a, v)

    i = 0
    nbits = len(final) * 8
    right = size - 1
    while right >= 1:
        if right == 6:
            right = 5
        for vert in range(size):
            for j in range(2):
                x = right - j
                y = size - 1 - vert if ((right + 1) & 2) == 0 else vert
                if not fn[y][x] and i < nbits:
                    mod[y][x] = (final[i >> 3] >> (7 - (i & 7))) & 1 == 1
                    i += 1
        right -= 2

    masks = [lambda x, y: (x + y) % 2 == 0, lambda x, y: y % 2 == 0, lambda x, y: x % 3 == 0, lambda x, y: (x + y) % 3 == 0,
             lambda x, y: (x // 3 + y // 2) % 2 == 0, lambda x, y: x * y % 2 + x * y % 3 == 0,
             lambda x, y: (x * y % 2 + x * y % 3) % 2 == 0, lambda x, y: ((x + y) % 2 + x * y % 3) % 2 == 0]

    def apply(m):
        for y in range(size):
            for x in range(size):
                if not fn[y][x] and masks[m](x, y):
                    mod[y][x] = not mod[y][x]

    def penalty():
        p = 0
        lines = [row for row in mod] + [[mod[y][x] for y in range(size)] for x in range(size)]
        for ln in lines:
            run = 1
            for k in range(1, size + 1):
                if k < size and ln[k] == ln[k - 1]:
                    run += 1
                else:
                    if run >= 5:
                        p += run - 2
                    run = 1
            s = "".join("1" if v else "0" for v in ln)
            p += 40 * (s.count("10111010000") + s.count("00001011101"))
        for y in range(size - 1):
            for x in range(size - 1):
                if mod[y][x] == mod[y][x + 1] == mod[y + 1][x] == mod[y + 1][x + 1]:
                    p += 3
        dark = sum(v for row in mod for v in row)
        p += abs(dark * 20 - size * size * 10) // (size * size) * 10
        return p

    best, best_p = 0, None
    for m in range(8):
        apply(m)
        draw_format(m)
        pt = penalty()
        if best_p is None or pt < best_p:
            best, best_p = m, pt
        apply(m)                                       # 再套一次＝還原
    apply(best)
    draw_format(best)
    return mod


def qr_svg(text):
    m = qr_matrix(text)
    n = len(m) + 8
    path = "".join("M%d %dh1v1h-1z" % (x + 4, y + 4) for y, row in enumerate(m) for x, v in enumerate(row) if v)
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %d %d" shape-rendering="crispEdges">'
            '<rect width="%d" height="%d" fill="#fff"/><path d="%s" fill="#000"/></svg>' % (n, n, n, n, path))


# ── 圖示：64×64 像素畫，照名稱的第一個字畫（Safari 網頁 App、Edge 視窗、分頁小圖示都用這個）──
# 上面一行小字 //OS、中間大字母（黃＋洋紅陰影）、下面看板的分格進度條。名稱第一個字不是英文／數字就畫 //。
# 不用任何影像套件（Windows 版的 Python 沒有），自己寫 PNG。
_G = """
A ..###.. .##.##. ##...## ##...## ####### ##...## ##...##
B ######. ##...## ##...## ######. ##...## ##...## ######.
C ..####. .##..## ##..... ##..... ##..... .##..## ..####.
D #####.. ##..##. ##...## ##...## ##...## ##..##. #####..
E ####### ##..... ##..... ######. ##..... ##..... #######
F ####### ##..... ##..... ######. ##..... ##..... ##.....
G ..##### .##.... ##..... ##..### ##...## .##..## ..#####
H ##...## ##...## ##...## ####### ##...## ##...## ##...##
I ######. ..##... ..##... ..##... ..##... ..##... ######.
J ....### .....## .....## .....## ##...## ##...## .#####.
K ##...## ##..##. ##.##.. ####... ##.##.. ##..##. ##...##
L ##..... ##..... ##..... ##..... ##..... ##..... #######
M ##...## ###.### ####### ####### ##.#.## ##...## ##...##
N ##...## ###..## ####.## ##.#### ##..### ##...## ##...##
O .#####. ##...## ##...## ##...## ##...## ##...## .#####.
P ######. ##...## ##...## ######. ##..... ##..... ##.....
Q .#####. ##...## ##...## ##...## ##.#### ##..##. .###.##
R ######. ##...## ##...## #####.. ##.###. ##..### ##...##
S .#####. ##...## ##..... .#####. .....## ##...## .#####.
T ######. ..##... ..##... ..##... ..##... ..##... ..##...
U ##...## ##...## ##...## ##...## ##...## ##...## .#####.
V ##...## ##...## ##...## ###.### .#####. ..###.. ...#...
W ##...## ##...## ##.#.## ####### ####### ###.### ##...##
X ##...## ###.### .#####. ..###.. .#####. ###.### ##...##
Y ##..##. ##..##. ##..##. .####.. ..##... ..##... ..##...
Z ####### ....### ...###. ..###.. .###... ###.... #######
0 .#####. ##...## ##..### ##.#.## ###..## ##...## .#####.
1 ..##... .###... ..##... ..##... ..##... ..##... ######.
2 .#####. ##...## ....### ..####. .###... ###.... #######
3 ####### ....##. ...##.. ..####. .....## ##...## .#####.
4 ...###. ..####. .##.##. ##..##. ####### ....##. ....##.
5 ######. ##..... ######. .....## .....## ##...## .#####.
6 ..####. .##.... ##..... ######. ##...## ##...## .#####.
7 ####### ##...## ....##. ...##.. ..##... ..##... ..##...
8 .#####. ##...## ##...## .#####. ##...## ##...## .#####.
9 .#####. ##...## ##...## .###### .....## ....##. .####..
/ .....## ....##. ...##.. ..##... .##.... ##..... ##.....
"""
GLYPHS = {ln[0]: ln[2:].split() for ln in _G.strip().splitlines()}
ICON_SIZES = {"icon.png": 64, "favicon.ico": 64, "apple-touch-icon.png": 512, "icon-512.png": 512}
_ICON_CACHE = {}


def icon_letter(brand):
    c = (str(brand or "").strip() or "LIFE")[0].upper()
    return c if c in GLYPHS and c != "/" else "/"


def icon_pixels(letter):
    """回傳 64×64 的 [[(r,g,b)]]"""
    n, bg0, bg1, grid = 64, (22, 19, 43), (7, 6, 13), (44, 39, 86)
    cyan, mag, yel = (0, 240, 255), (255, 42, 109), (252, 238, 10)
    px = []
    for y in range(n):
        t = y / (n - 1)
        base = tuple(round(bg0[k] * (1 - t) + bg1[k] * t) for k in range(3))
        line = tuple(round(base[k] * 0.78 + grid[k] * 0.22) for k in range(3))
        px.append([line if (x % 8 == 4 or y % 8 == 4) else base for x in range(n)])

    def put(x, y, w, h, c):
        for j in range(max(0, y), min(n, y + h)):
            for i in range(max(0, x), min(n, x + w)):
                px[j][i] = c

    def glyph(ch, x, y, s, c, shadow=None, off=1):
        for col, d in ((shadow, off), (c, 0)):
            if col:
                for j, row in enumerate(GLYPHS[ch]):
                    for i, v in enumerate(row):
                        if v == "#":
                            put(x + i * s + d, y + j * s + d, s, s, col)

    for k, ch in enumerate("//OS"):                    # 上面一行小字
        glyph(ch, 17 + k * 8, 8, 1, cyan)
    if letter == "/":
        glyph("/", 9, 21, 3, yel, mag, 2)
        glyph("/", 31, 21, 3, yel, mag, 2)
    else:
        glyph(letter, 17, 19, 4, yel, mag, 2)
    for i in range(8):                                 # 分格進度條：亮 5 格
        put(12 + i * 5, 52, 4, 3, yel if i < 5 else grid)
    return px


def png_bytes(px, scale):
    import struct
    import zlib
    raw = bytearray()
    for row in px:
        line = b"\x00" + b"".join(bytes(c) * scale for c in row)
        raw += line * scale
    w = len(px[0]) * scale

    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, w, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b""))


def icon_png(letter, size):
    key = (letter, size)
    if key not in _ICON_CACHE:
        _ICON_CACHE[key] = png_bytes(icon_pixels(letter), max(1, size // 64))
    return _ICON_CACHE[key]


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

    def _local(self):
        return self.client_address[0] in ("127.0.0.1", "::1")

    def _gate(self):
        """手機連線的鑰匙：本機（含 Tailscale Serve 轉進來的）直接過；其他來源要有 cookie，或網址帶對的 ?k= 換成 cookie"""
        if self._local():
            return True
        if LAN_ON:
            key = NET["key"]
            c = SimpleCookie()
            try:
                c.load(self.headers.get("Cookie") or "")
            except Exception:
                pass
            if "kos_key" in c and hmac.compare_digest(c["kos_key"].value, key):
                return True
            k = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query).get("k")
            if k and hmac.compare_digest(k[0], key):
                self.send_response(302)
                self.send_header("Location", "/")
                self.send_header("Set-Cookie", "kos_key=%s; Max-Age=315360000; Path=/; HttpOnly; SameSite=Lax" % key)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return False
        body = ('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">'
                '<body style="background:#07060d;color:#dcd9f5;font:18px sans-serif;padding:32px;line-height:1.6">'
                '連不上：請在電腦的看板按右上角齒輪 →「手機」，用手機相機重新掃 QR code。</body>').encode("utf-8")
        self.send_response(403)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.close_connection = True
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)
        return False

    def _host_ok(self):
        host = (self.headers.get("Host") or "").strip().lower()
        if host.startswith("["):                      # IPv6：[::1]:4173
            host = host[1:].split("]")[0]
        elif host.count(":") == 1:                    # name:port
            host = host.split(":")[0]
        if host in ("localhost", "127.0.0.1", "::1") or host in EXTRA_HOSTS or host.endswith(".ts.net"):
            return True
        try:
            ip = ipaddress.ip_address(host)
            return ip in TAILNET or (LAN_ON and ip.is_private)   # 手機連線：用區網位址連進來
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

    def _icon(self, rel):
        """圖示照目前的名稱畫（改名後重新整理就換）；ETag＝字母＋尺寸"""
        try:
            letter = icon_letter((read_state() or {}).get("brand"))
        except ValueError:
            letter = "/"
        size = ICON_SIZES[rel]
        etag = '"ic-%s-%d"' % (ord(letter), size)
        if self.headers.get("If-None-Match") == etag:
            self.send_response(304)
            self.send_header("ETag", etag)
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            return
        body = icon_png(letter, size)
        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("ETag", etag)
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _static(self, path):
        """靜態檔：ETag（沒變回 304）、文字檔 gzip（壓好的留在記憶體）。字型／音效幾乎不會變 → 瀏覽器快取 30 天；
        html／js／css 每次用 ETag 問一下有沒有新版（改了程式重新整理就生效）。"""
        rel = urllib.parse.unquote(path).lstrip("/") or "index.html"
        if rel in ICON_SIZES:
            return self._icon(rel)
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
        if not self._gate():
            return
        path = self.path.split("?")[0]
        if path.startswith("/api/"):
            if not self._host_ok():
                return self._json(403, {"error": "forbidden host"})
            if path == "/api/lan":
                return self._json(200, lan_info(self._local()))
            if path == "/api/lan/qr.svg":
                info = lan_info(self._local())
                if not info["url"]:
                    return self._json(404, {"error": "not on"})
                body = qr_svg(info["url"]).encode()
                self.send_response(200)
                self.send_header("Content-Type", "image/svg+xml")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                return self.wfile.write(body) if self.command != "HEAD" else None
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
        if not self._gate():
            return
        path = self.path.split("?")[0]
        if path == "/api/lan":
            if not (self._host_ok() and self._local() and LAN_OK):
                return self._json(403, {"error": "只有電腦本機能改"})
            try:
                on = bool(json.loads(self.rfile.read(min(int(self.headers.get("Content-Length") or 0), 1000)) or b"{}").get("on"))
            except ValueError:
                return self._json(400, {"error": "bad json"})
            NET.update(lan=on, key=secrets.token_urlsafe(12) if on else "")   # 每次打開換一組新鑰匙
            with open(NET_FILE + ".tmp", "w", encoding="utf-8") as f:
                json.dump(NET, f)
            replace_file(NET_FILE + ".tmp", NET_FILE)
            self._json(200, {"ok": True, "restart": True})
            UPDATER.exit_code = UPDATER.RESTART                  # 重開才能換聽的網卡（boot.py 收到 75 會馬上再開）
            threading.Timer(0.3, self.server.shutdown).start()
            return
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
    try:
        server = Server(("0.0.0.0" if LAN_ON else "127.0.0.1", PORT), Handler)
    except OSError:
        LAN_ON = False
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
