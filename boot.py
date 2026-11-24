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
import threading
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
APPID = "YGxKevin.LifeOS"                         # 工作列身分：桌面捷徑、看板視窗、釘選的圖示都用這個，才會合在一起


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
    """打開看板視窗；Windows 上回傳幫視窗換工作列身分的執行緒（呼叫的人如果馬上要結束，先 join 它）"""
    url = "http://127.0.0.1:%d/" % port
    if WIN:
        pf = [os.environ.get(k) for k in ("ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA")]
        for exe in [os.path.join(p, r"Microsoft\Edge\Application\msedge.exe") for p in pf if p] + \
                   [os.path.join(p, r"Google\Chrome\Application\chrome.exe") for p in pf if p]:
            if os.path.isfile(exe):               # 用 Edge／Chrome 的 App 視窗開（沒有網址列，像一般程式）
                subprocess.Popen([exe, "--app=" + url], creationflags=NO_WINDOW)
                t = threading.Thread(target=taskbar_watch, args=(port, 20, 0.3), daemon=True)
                t.start()
                return t
        os.startfile(url)
    else:
        import webbrowser
        webbrowser.open(url)
    return None


"""Windows 工作列（11/24）：Edge／Chrome 的 --app 視窗，工作列身分是瀏覽器的（例如 MSEdge.127.0.0.1_/），
而且沒有「重新開啟的指令」和圖示，所以釘選到工作列會變成 Edge 的圖示。
這裡把那個視窗的身分換成 APPID，並給它重新開啟的指令（pythonw boot.py --open）、名稱（視窗標題，例如 KEVIN//OS）、
圖示（伺服器照名稱畫的 app.ico，存在 data/）。釘選後點圖示會先開伺服器再開視窗，新視窗換好身分就併進同一個圖示。
桌面捷徑也設成同一個 APPID。視窗屬性用 SHGetPropertyStoreForWindow，別的程式的視窗也能設（Windows 11 測過）。"""
if WIN:
    import ctypes
    import uuid
    from ctypes import wintypes

    class _GUID(ctypes.Structure):
        _fields_ = [("b", ctypes.c_ubyte * 16)]

    class _PKEY(ctypes.Structure):
        _fields_ = [("fmtid", _GUID), ("pid", ctypes.c_uint32)]

    class _PV(ctypes.Structure):                  # PROPVARIANT（64 位元是 24 bytes）
        _fields_ = [("vt", ctypes.c_ushort), ("r1", ctypes.c_ushort), ("r2", ctypes.c_ushort), ("r3", ctypes.c_ushort),
                    ("p", ctypes.c_void_p), ("p2", ctypes.c_void_p)]

    def _guid(s):
        g = _GUID()
        ctypes.memmove(ctypes.byref(g), uuid.UUID(s).bytes_le, 16)
        return g

    _IID_PS = _guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")          # IPropertyStore
    _FMT = "9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"                    # PKEY_AppUserModel_*
    K_CMD, K_ICON, K_NAME, K_ID = 2, 3, 4, 5
    _sh, _ole, _u32 = ctypes.windll.shell32, ctypes.windll.ole32, ctypes.windll.user32
    _sh.SHGetPropertyStoreForWindow.argtypes = [wintypes.HWND, ctypes.POINTER(_GUID), ctypes.POINTER(ctypes.c_void_p)]
    _sh.SHGetPropertyStoreFromParsingName.argtypes = [wintypes.LPCWSTR, ctypes.c_void_p, ctypes.c_int, ctypes.POINTER(_GUID), ctypes.POINTER(ctypes.c_void_p)]
    _ENUM = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    _u32.EnumWindows.argtypes = [_ENUM, wintypes.LPARAM]
    _u32.IsWindowVisible.argtypes = [wintypes.HWND]
    _u32.GetClassNameW.argtypes = _u32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]

    def _vcall(obj, i, *types):
        vt = ctypes.cast(obj, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p)))[0]
        return ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_void_p, *types)(vt[i])

    class _Store:
        """IPropertyStore：get／put 字串、commit、close"""
        def __init__(self, p):
            self.p = p

        def get(self, pid):
            v = _PV()
            if _vcall(self.p, 5, ctypes.POINTER(_PKEY), ctypes.POINTER(_PV))(self.p, ctypes.byref(_PKEY(_guid(_FMT), pid)), ctypes.byref(v)) != 0:
                return ""
            s = ctypes.wstring_at(v.p) if v.vt == 31 and v.p else ""
            _ole.PropVariantClear(ctypes.byref(v))
            return s

        def put(self, pid, s):
            b = ctypes.create_unicode_buffer(s)
            v = _PV()
            v.vt, v.p = 31, ctypes.addressof(b)     # VT_LPWSTR；SetValue 會自己複製一份
            return _vcall(self.p, 6, ctypes.POINTER(_PKEY), ctypes.POINTER(_PV))(self.p, ctypes.byref(_PKEY(_guid(_FMT), pid)), ctypes.byref(v)) == 0

        def close(self, commit=True):
            if commit:
                _vcall(self.p, 7)(self.p)
            _vcall(self.p, 2)(self.p)

    def _win_store(h):
        p = ctypes.c_void_p()
        return _Store(p) if _sh.SHGetPropertyStoreForWindow(h, ctypes.byref(_IID_PS), ctypes.byref(p)) == 0 and p.value else None

    def _file_store(path):
        p = ctypes.c_void_p()
        return _Store(p) if _sh.SHGetPropertyStoreFromParsingName(path, None, 2, ctypes.byref(_IID_PS), ctypes.byref(p)) == 0 and p.value else None   # 2＝可寫

    def _desktop():
        b = ctypes.create_unicode_buffer(260)
        return b.value if ctypes.windll.shell32.SHGetFolderPathW(None, 0x10, None, 0, b) == 0 else None   # CSIDL_DESKTOPDIRECTORY


_TB_LOCK = threading.Lock()                       # 開視窗後的快速檢查和一直跑的檢查不要同時改


def brand_icon(port):
    """伺服器照目前名稱畫的 app.ico 存到 data/（檔名帶內容的雜湊：換名字就是新檔名，Windows 的圖示快取才會換）。
    失敗就用上次的（沒有上次就用安裝時的 icon.ico）"""
    try:
        import hashlib
        with urllib.request.urlopen("http://127.0.0.1:%d/app.ico" % port, timeout=3) as r:
            data = r.read()
        p = os.path.join(DATA, "icon-%s.ico" % hashlib.sha1(data).hexdigest()[:8])
        if not os.path.isfile(p):
            with open(p + ".part", "wb") as f:
                f.write(data)
            os.replace(p + ".part", p)
        return p
    except Exception:
        last = (cfg_get().get("sc") or {}).get("icon")
        return last if last and os.path.isfile(last) else os.path.join(HERE, "icon.ico")


def relaunch_cmd():
    return '"%s" "%s" --open' % (os.path.join(os.path.dirname(sys.executable), "pythonw.exe"), os.path.abspath(__file__))


def taskbar_watch(port, until=None, every=3.0):
    """找看板的 App 視窗（Chrome_WidgetWin_1、瀏覽器給的身分裡有 127.0.0.1_）換成 APPID。
    until＝幾秒後停（None＝一直看，跟著伺服器的啟動器跑；EnumWindows 每 3 秒一次，開銷可以忽略）。
    標題（名稱）變了就更新釘選用的名稱和圖示"""
    try:
        _ole.CoInitializeEx(None, 2)
        end = time.time() + until if until else None
        icon, cmd, named = None, relaunch_cmd(), {}
        while end is None or time.time() < end:
            hs = []
            _u32.EnumWindows(_ENUM(lambda h, _l: hs.append(h) or True), 0)
            with _TB_LOCK:
                for h in hs:
                    if not h or not _u32.IsWindowVisible(h):
                        continue
                    c = ctypes.create_unicode_buffer(64)
                    _u32.GetClassNameW(h, c, 64)
                    if c.value != "Chrome_WidgetWin_1":
                        continue
                    st = _win_store(h)
                    if not st:
                        continue
                    try:
                        cur = st.get(K_ID)
                        if cur != APPID and "127.0.0.1_" not in cur:
                            st.close(False)
                            continue
                        t = ctypes.create_unicode_buffer(256)
                        _u32.GetWindowTextW(h, t, 256)
                        title = t.value if t.value.endswith("//OS") else ""
                        if cur == APPID and h not in named:   # 別的啟動器已經換好了：記下標題，之後改名再更新
                            named[h] = title
                        if cur == APPID and named[h] == title:
                            st.close(False)
                            if until and title:
                                end = 0
                            continue
                        if icon is None or (h in named and named[h] != title):
                            icon = brand_icon(port)
                            shortcut_icon(icon)
                        st.put(K_ID, APPID)
                        st.put(K_CMD, cmd)
                        st.put(K_NAME, title or "LIFE OS")
                        st.put(K_ICON, icon + ",0")
                        st.close()
                        named[h] = title
                        if until and title:           # 開視窗後的快速檢查：換好、標題也出來了就收工
                            end = 0
                    except Exception as e:
                        log("工作列身分設定失敗：%r" % e)
                        st.close(False)
            if len(named) > 50:
                named.clear()
            time.sleep(every)
    except Exception as e:
        log("工作列檢查停止：%r" % e)


def _make_lnk(lnk, icon):
    q = lambda s: s.replace("'", "''")
    pyw = os.path.join(os.path.dirname(sys.executable), "pythonw.exe")
    ps = ("$s=(New-Object -ComObject WScript.Shell).CreateShortcut('%s');"
          "$s.TargetPath='%s';$s.Arguments='\"%s\" --open';$s.WorkingDirectory='%s';$s.IconLocation='%s';$s.Description='LIFE//OS';$s.Save()"
          % (q(lnk), q(pyw), q(os.path.abspath(__file__)), q(HERE), q(icon)))
    subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps], creationflags=NO_WINDOW, timeout=60, check=True)
    _ole.CoInitializeEx(None, 2)
    st = _file_store(lnk)                         # 捷徑也設同一個工作列身分（從桌面捷徑釘選、開出來的視窗才會合在一起）
    if st:
        st.put(K_ID, APPID)
        st.close()


def make_shortcut(icon=None):
    """桌面放一個捷徑（直接開 pythonw，不會閃黑色視窗）。記住建立時資料夾在哪裡：
    資料夾被搬走（例如從「下載」搬到「文件」），捷徑會指到舊位置打不開，下次從「開啟看板」打開就重建。
    kos.json 的 sc＝{dir, icon}：舊版（只有 shortcut）升上來時，捷徑還在才補上工作列身分，被刪掉的不再建回來"""
    if not WIN:
        return
    c = cfg_get()
    sc = c.get("sc") or {}
    icon = icon or sc.get("icon") or os.path.join(HERE, "icon.ico")
    if sc.get("dir") == HERE and sc.get("icon") == icon:
        return
    d = _desktop()
    if not d:
        return
    lnk = os.path.join(d, "LIFE OS.lnk")
    if (sc or c.get("shortcut") == HERE) and sc.get("dir", c.get("shortcut")) == HERE and not os.path.isfile(lnk):
        return cfg_set(sc={"dir": HERE, "icon": icon})            # 使用者自己刪掉的：不建回來
    try:
        _make_lnk(lnk, icon)
        cfg_set(shortcut=HERE, sc={"dir": HERE, "icon": icon})
        log("桌面捷徑已建立：" + HERE)
    except Exception as e:
        log("建立桌面捷徑失敗：%s" % e)


def shortcut_icon(icon):
    """名稱換了（圖示換了）→ 桌面捷徑的圖示跟著換"""
    if (cfg_get().get("sc") or {}).get("icon") != icon:
        make_shortcut(icon)


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
            t = open_ui(port)
            t and t.join()
        return
    if ours(port):
        if want_open:
            t = open_ui(port)
            t and t.join()
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
    if WIN:                                       # 跟著伺服器一直看：不管視窗是誰開的（釘選、捷徑），都換成看板的工作列身分
        threading.Thread(target=taskbar_watch, args=(port,), daemon=True).start()
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
