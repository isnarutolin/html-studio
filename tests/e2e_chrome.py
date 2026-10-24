#!/usr/bin/env python3
"""
端到端测试：用真实 Chrome 加载本扩展，走一遍「点 ✎ → 改字 → 点保存 → 校验落盘」。

特点：
  - 用独立的临时 profile，不动你正在用的 Chrome
  - 不 mock 任何东西：真实 content script → 真实 background → 真实 native messaging → 真实写盘
  - 只通过 DOM 交互驱动（content script 跑在隔离世界，主世界拿不到它的变量）

前置：
  python3 extension/install.py        # native host 必须已注册
  Chrome 已安装（默认 /Applications/Google Chrome.app）

用法：
  python3 tests/e2e_chrome.py
"""

import base64
import glob
import json
import os
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
EXT_DIR = os.path.join(REPO, "extension")
STATE_DIR = os.path.join(os.path.expanduser("~"), ".html-studio")

CHROME_CANDIDATES = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
]

PASS, FAIL = [], []


def ok(name, cond, extra=""):
    (PASS if cond else FAIL).append(
        f"{'PASS' if cond else 'FAIL'} | {name}" + (f" | {extra}" if extra else ""))


# --------------------------------------------------------------------------- #
# 极简 WebSocket / CDP 客户端（只用标准库）
# --------------------------------------------------------------------------- #
class WS:
    def __init__(self, url):
        rest = url[5:]
        host_port, path = rest.split("/", 1)
        host, port = host_port.split(":")
        self.s = socket.create_connection((host, int(port)), timeout=20)
        key = base64.b64encode(os.urandom(16)).decode()
        self.s.sendall(
            f"GET /{path} HTTP/1.1\r\nHost: {host_port}\r\nUpgrade: websocket\r\n"
            f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n".encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            buf += self.s.recv(4096)

    def send(self, obj):
        data = json.dumps(obj).encode()
        header = bytearray([0x81])
        n = len(data)
        mask = os.urandom(4)
        if n < 126:
            header.append(0x80 | n)
        elif n < 65536:
            header.append(0x80 | 126)
            header += struct.pack(">H", n)
        else:
            header.append(0x80 | 127)
            header += struct.pack(">Q", n)
        header += mask
        self.s.sendall(bytes(header) + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    def _read(self, n):
        buf = b""
        while len(buf) < n:
            c = self.s.recv(n - len(buf))
            if not c:
                raise ConnectionError("socket closed")
            buf += c
        return buf

    def recv(self):
        while True:
            b1, b2 = self._read(2)
            op, ln = b1 & 0x0F, b2 & 0x7F
            if ln == 126:
                ln = struct.unpack(">H", self._read(2))[0]
            elif ln == 127:
                ln = struct.unpack(">Q", self._read(8))[0]
            payload = self._read(ln)
            if op == 1:
                return json.loads(payload.decode())
            if op == 8:
                raise ConnectionError("ws closed")


class CDP:
    def __init__(self, ws_url):
        self.ws = WS(ws_url)
        self._id = 0

    def call(self, method, params=None, session=None, timeout=30):
        self._id += 1
        mid = self._id
        msg = {"id": mid, "method": method, "params": params or {}}
        if session:
            msg["sessionId"] = session
        self.ws.send(msg)
        end = time.time() + timeout
        while time.time() < end:
            r = self.ws.recv()
            if r.get("id") == mid:
                return r
        return {"error": "timeout"}

    def ev(self, expr, session=None, timeout=30):
        r = self.call("Runtime.evaluate",
                      {"expression": expr, "awaitPromise": True, "returnByValue": True},
                      session, timeout)
        res = r.get("result") or {}
        if "exceptionDetails" in res:
            ex = res["exceptionDetails"]
            return {"__err": (ex.get("exception") or {}).get("description") or ex.get("text")}
        return (res.get("result") or {}).get("value")


# --------------------------------------------------------------------------- #
def find_chrome():
    for p in CHROME_CANDIDATES:
        if os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    sys.exit("找不到 Chrome / Chromium，可编辑 CHROME_CANDIDATES 指定路径")


def real_host_manifests():
    """把用户已注册的 host manifest 复制进临时 profile —— 名字无关，避免硬编码。"""
    pats = [
        os.path.expanduser("~/Library/Application Support/*/NativeMessagingHosts/*.json"),
        os.path.expanduser("~/Library/Application Support/*/*/NativeMessagingHosts/*.json"),
        os.path.expanduser("~/.config/*/NativeMessagingHosts/*.json"),
    ]
    out = []
    for pat in pats:
        out += glob.glob(pat)
    return out


def main():
    chrome = find_chrome()
    manifests = real_host_manifests()
    if not manifests:
        sys.exit("没找到已注册的 native host，先运行：python3 extension/install.py")

    # 必须放在 $HOME 内且路径不含隐藏目录 —— native host 只允许写这类位置
    work = tempfile.mkdtemp(prefix="html-studio-e2e-", dir=os.path.expanduser("~"))
    profile = os.path.join(work, "profile")
    page = os.path.join(work, "page.html")
    port = 9461

    os.makedirs(os.path.join(profile, "NativeMessagingHosts"), exist_ok=True)
    for m in manifests:
        shutil.copy(m, os.path.join(profile, "NativeMessagingHosts", os.path.basename(m)))

    with open(page, "w", encoding="utf-8") as f:
        f.write('<!DOCTYPE html>\n<html lang="zh-CN"><head><meta charset="utf-8">'
                '<title>e2e</title></head>\n'
                '<body><h1>原标题</h1><p>一段要改的文字</p>\n'
                '<svg viewBox="0 0 28 12"><line x1="2" y1="6" x2="22" y2="6" '
                'stroke="#1976d2"/></svg>\n</body></html>\n')

    proc = subprocess.Popen(
        [chrome, "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run",
         "--no-default-browser-check", f"--user-data-dir={profile}",
         f"--remote-debugging-port={port}", "--enable-unsafe-extension-debugging",
         "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    ws_url = None
    for _ in range(70):
        try:
            ws_url = json.load(urllib.request.urlopen(
                f"http://127.0.0.1:{port}/json/version", timeout=1))["webSocketDebuggerUrl"]
            break
        except Exception:  # noqa: BLE001
            time.sleep(0.4)
    if not ws_url:
        proc.kill()
        sys.exit(f"Chrome 调试端口 {port} 没起来")

    try:
        cdp = CDP(ws_url)
        r = cdp.call("Extensions.loadUnpacked", {"path": EXT_DIR})
        ext_id = (r.get("result") or {}).get("id")
        if not ext_id:
            print("加载扩展失败:", json.dumps(r, ensure_ascii=False)[:400])
            return 1
        ok("扩展加载成功", True, ext_id)

        t = cdp.call("Target.createTarget", {"url": "file://" + page})
        sess = cdp.call("Target.attachToTarget",
                        {"targetId": t["result"]["targetId"], "flatten": True}
                        )["result"]["sessionId"]
        cdp.call("Runtime.enable", session=sess)
        time.sleep(2.5)

        SH = "document.getElementById('__html_studio_host__')"

        def wait(expr, sec=12):
            end = time.time() + sec
            while time.time() < end:
                if cdp.ev(expr, sess) is True:
                    return True
                time.sleep(0.35)
            return False

        ok("content script 注入本地 html", wait(f"!!{SH} && !!{SH}.shadowRoot"))
        ok("✎ 圆钮出现", cdp.ev(f"!!{SH}.shadowRoot.querySelector('.fab')", sess) is True)
        ok("默认不可编辑", cdp.ev("document.body.getAttribute('contenteditable')", sess) is None)

        cdp.ev(f"{SH}.shadowRoot.querySelector('.fab').click()", sess)
        ok("点 ✎ 进入编辑", wait("document.body.getAttribute('contenteditable')==='true'"))
        ok("工具条出现", cdp.ev(f"!!{SH}.shadowRoot.querySelector('.bar')", sess) is True)

        tag = cdp.ev("""(()=>{const el=document.querySelector('h1');if(!el)return null;
            el.textContent='改过的标题 ★E2E★';
            el.dispatchEvent(new Event('input',{bubbles:true}));return el.tagName;})()""", sess)
        ok("改文字", tag == "H1", tag)
        ok("出现未保存橙点", wait(f"!!{SH}.shadowRoot.querySelector('.dot.show')", 6))

        cdp.ev(f"{SH}.shadowRoot.querySelector('[data-a=\"save\"]').click()", sess)
        saved = False
        for _ in range(25):
            time.sleep(0.4)
            if "★E2E★" in open(page, encoding="utf-8").read():
                saved = True
                break
        ok("经 native messaging 真实落盘", saved, f"{os.path.getsize(page)} bytes")

        disk = open(page, encoding="utf-8").read()
        ok("落盘无编辑器残留",
           "__html_studio_host__" not in disk and "contenteditable" not in disk.lower())
        ok("SVG 自闭合保留", "<line" in disk and "</line>" not in disk)
        ok("橙点消失", cdp.ev(f"!{SH}.shadowRoot.querySelector('.dot.show')", sess) is True)
        toast = cdp.ev(f"({SH}.shadowRoot.querySelector('.toast')||{{}}).textContent||''", sess)
        ok("提示已保存", "已保存" in (toast or ""), toast)

        bak = os.path.join(STATE_DIR, "backups", os.path.relpath(work, os.path.expanduser("~")),
                           "page.html.bak")
        ok("备份已生成", os.path.isdir(bak) and bool(os.listdir(bak)),
           os.listdir(bak)[0] if os.path.isdir(bak) and os.listdir(bak) else bak)

        # 自检页
        t2 = cdp.call("Target.createTarget", {"url": f"chrome-extension://{ext_id}/help.html"})
        s2 = cdp.call("Target.attachToTarget",
                      {"targetId": t2["result"]["targetId"], "flatten": True})["result"]["sessionId"]
        cdp.call("Runtime.enable", session=s2)
        time.sleep(3)
        states = cdp.ev("""(()=>{const g=id=>document.getElementById(id).className.replace('card','').trim();
            return {c1:g('c1'),c2:g('c2'),c3:g('c3')};})()""", s2)
        ok("自检页三项通过", isinstance(states, dict) and all(
            v == 'ok' for v in (states or {}).values()), states)
    finally:
        proc.terminate()
        try:
            proc.wait(6)
        except Exception:  # noqa: BLE001
            proc.kill()
        shutil.rmtree(work, ignore_errors=True)
        shutil.rmtree(os.path.join(STATE_DIR, "backups",
                                   os.path.relpath(work, os.path.expanduser("~"))), ignore_errors=True)

    print("\n".join(PASS))
    print("\n".join(FAIL))
    print(f"\n{len(PASS)}/{len(PASS) + len(FAIL)}")
    return 0 if not FAIL else 1


if __name__ == "__main__":
    sys.exit(main())
