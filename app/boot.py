"""LIFE//OS 啟動器（Windows 版；Mac 上也能跑，測試用）。

資料夾長這樣：
  boot.py        這支：開伺服器、套用下載好的更新、新版開不起來就退回舊版、打開看板視窗
  runtime/       Python（免安裝版）
  app/           看板程式（自動更新只換這裡）
  data/          你的資料 data.json、每日備份 backups/、紀錄 logs/（更新不會動到）

用法：pythonw boot.py --open（開看板；伺服器沒開就先開）　--stop（關掉伺服器）
伺服器結束代碼 75＝新版已經下載到 app.next/：換上新版再開。換上後 20 秒內就結束（開不起來）→ 退回 app.prev/，
並把那一版記進 data/update-skip.txt，之後不再裝它。
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
APP, NEXT, PREV = (os.path.join(HERE, n) for n in ("app", "app.next", "app.prev"))
DATA = os.path.join(HERE, "data")
LOGS = os.path.join(DATA, "logs")
CFG = os.path.join(DATA, "kos.json")
WIN = os.name == "nt"
NO_WINDOW = 0x08000000 if WIN else 0
RESTART = 75


def log(msg):
    try:
        os.makedirs(LOGS, exist_ok=True)
        with open(os.path.join(LOGS, "boot.log"), "a", encoding="utf-8") as f:
            f.write(time.strftime("%Y-%m-%d %H:%M:%S ") + msg + "\n")
    except OSError:
        pass


def alert(msg):
    if WIN:
        import ctypes
        ctypes.windll.user32.MessageBoxW(None, msg, "LIFE//OS", 0x30)
    else:
        print(msg, file=sys.stderr)


def cfg_get():
    try:
        with open(CFG, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def cfg_set(**kw):
    c = cfg_get()
    c.update(kw)
    os.makedirs(DATA, exist_ok=True)
    with open(CFG, "w", encoding="utf-8") as f:
        json.dump(c, f, ensure_ascii=False, indent=1)


def ours(port):
    """這個 port 上跑的是不是看板伺服器"""
    try:
        with urllib.request.urlopen("http://127.0.0.1:%d/api/rev" % port, timeout=1.5) as r:
            return "code" in json.loads(r.read())
    except Exception:
        return False


def port_free(port):
    s = socket.socket()
    try:
        if WIN:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        s.bind(("127.0.0.1", port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def retry(fn, *a):
    """Windows 上資料夾裡有檔案剛好被打開（防毒、檔案總管預覽）時改名會失敗，等一下再試"""
    for i in range(20):
        try:
            return fn(*a)
        except OSError:
            if i == 19:
                raise
            time.sleep(0.5)


def apply_next():
    """app.next/ 下載完整（有 .ready）就換上：app → app.prev，app.next → app。回傳新版本號"""
    ready = os.path.join(NEXT, ".ready")
    if not os.path.isfile(ready):
        if os.path.isdir(NEXT):
            shutil.rmtree(NEXT, ignore_errors=True)   # 下載到一半的不要
        return None
    with open(ready, encoding="utf-8") as f:
        ver = f.read().strip()
    shutil.rmtree(PREV, ignore_errors=True)
    retry(os.rename, APP, PREV)
    try:
        retry(os.rename, NEXT, APP)
    except OSError:
        retry(os.rename, PREV, APP)
        raise
    os.remove(os.path.join(APP, ".ready"))
    log("更新到 " + ver)
    return ver


def rollback(ver):
    log("新版 %s 開不起來，退回上一版" % ver)
    bad = os.path.join(HERE, "app.bad")
    shutil.rmtree(bad, ignore_errors=True)
    retry(os.rename, APP, bad)
    retry(os.rename, PREV, APP)
    with open(os.path.join(DATA, "update-skip.txt"), "a", encoding="utf-8") as f:
        f.write(ver + "\n")


def self_update():
    """新版的 app/boot.py 跟這支不一樣 → 換掉這支（下次啟動生效）"""
    src, me = os.path.join(APP, "boot.py"), os.path.abspath(__file__)
    try:
        with open(src, "rb") as a, open(me, "rb") as b:
            if a.read() == b.read():
                return
        shutil.copy2(src, me + ".new")
        os.replace(me + ".new", me)
        log("啟動器已更新")
    except OSError:
        pass


def open_ui(port):
    url = "http://127.0.0.1:%d/" % port
    if WIN:
        pf = [os.environ.get(k) for k in ("ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA")]
        for exe in [os.path.join(p, r"Microsoft\Edge\Application\msedge.exe") for p in pf if p] + \
                   [os.path.join(p, r"Google\Chrome\Application\chrome.exe") for p in pf if p]:
            if os.path.isfile(exe):               # 用 Edge／Chrome 的 App 視窗開（沒有網址列，像一般程式）
                subprocess.Popen([exe, "--app=" + url], creationflags=NO_WINDOW)
                return
        os.startfile(url)
    else:
        import webbrowser
        webbrowser.open(url)


def make_shortcut():
    """第一次開：桌面放一個捷徑（直接開 pythonw，不會閃黑色視窗）"""
    if not WIN or cfg_get().get("shortcut"):
        return
    q = lambda s: s.replace("'", "''")
    pyw = os.path.join(os.path.dirname(sys.executable), "pythonw.exe")
    ps = ("$d=[Environment]::GetFolderPath('Desktop');$s=(New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $d 'LIFE OS.lnk'));"
          "$s.TargetPath='%s';$s.Arguments='\"%s\" --open';$s.WorkingDirectory='%s';$s.IconLocation='%s';$s.Description='LIFE//OS';$s.Save()"
          % (q(pyw), q(os.path.abspath(__file__)), q(HERE), q(os.path.join(HERE, "icon.ico"))))
    try:
        subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps], creationflags=NO_WINDOW, timeout=60, check=True)
        cfg_set(shortcut=True)
        log("桌面捷徑已建立")
    except Exception as e:
        log("建立桌面捷徑失敗：%s" % e)


class Lock:
    """同時只能有一個啟動器在管伺服器"""
    def __init__(self):
        os.makedirs(DATA, exist_ok=True)
        self.f = open(os.path.join(DATA, "boot.lock"), "a+")

    def take(self):
        try:
            if WIN:
                import msvcrt
                self.f.seek(0)
                msvcrt.locking(self.f.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except OSError:
            return False


def wait_up(port, sec=15):
    end = time.time() + sec
    while time.time() < end:
        if ours(port):
            return True
        time.sleep(0.25)
    return False


def main():
    want_open = "--open" in sys.argv
    if "\\Temp\\" in HERE and ".zip" in HERE.lower():
        return alert("請先在壓縮檔上按右鍵 →「全部解壓縮」，再開啟解壓縮後資料夾裡的「開啟看板」。")
    port = int(cfg_get().get("port") or 4173)

    if "--stop" in sys.argv:
        try:
            urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:%d/api/quit" % port, data=b"", method="POST"), timeout=3)
        except Exception:
            pass
        return

    lock = Lock()
    if not lock.take():                           # 已經有啟動器在跑：等伺服器好了打開視窗就好
        if want_open and wait_up(port):
            open_ui(port)
        return
    if ours(port):
        if want_open:
            open_ui(port)
        return
    if not port_free(port):                       # 被別的程式佔走了：換一個，記起來
        port = next((p for p in range(4174, 4300) if port_free(p)), None)
        if not port:
            return alert("找不到可以用的連接埠（4173–4299 都被佔用）。")
        cfg_set(port=port)

    if os.path.isdir(os.path.join(LOGS)):
        sl = os.path.join(LOGS, "server.log")
        if os.path.exists(sl) and os.path.getsize(sl) > 2 * 1024 * 1024:
            os.replace(sl, sl + ".old")
    make_shortcut()
    applied = apply_next()
    if applied:
        self_update()
    fails, opened = 0, False
    while True:
        os.makedirs(LOGS, exist_ok=True)
        t0 = time.time()
        with open(os.path.join(LOGS, "server.log"), "a", encoding="utf-8") as out:
            p = subprocess.Popen([sys.executable, os.path.join(APP, "server.py"), "--port", str(port), "--data", DATA],
                                 cwd=APP, env=dict(os.environ, KOS_BOOT="1", PYTHONIOENCODING="utf-8"),
                                 stdout=out, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, creationflags=NO_WINDOW)
            if want_open and not opened:
                if wait_up(port):
                    open_ui(port)
                    opened = True
            rc = p.wait()
        log("伺服器結束，代碼 %s，跑了 %d 秒" % (rc, time.time() - t0))
        if rc == RESTART:
            applied = apply_next()
            if applied:
                self_update()
            fails = 0
            continue
        if applied and rc != 0 and time.time() - t0 < 20 and os.path.isdir(PREV):
            rollback(applied)
            applied = None
            continue
        applied = None
        if rc == 0:
            return                                # 正常關閉（關閉看板）
        fails += 1
        if fails >= 5:
            return alert("看板伺服器一直開不起來，紀錄在 data\\logs\\server.log。")
        time.sleep(min(30, 2 ** fails))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log("啟動器錯誤：%r" % e)
        alert("LIFE//OS 啟動失敗：%s" % e)
