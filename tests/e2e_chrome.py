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
import functools
import glob
import json
import os
import re
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

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

    def fire(self, method, params=None, session=None):
        """只发不等回复 —— 用于会弹出 confirm/prompt、把 JS 卡住的表达式。"""
        self._id += 1
        msg = {"id": self._id, "method": method, "params": params or {}}
        if session:
            msg["sessionId"] = session
        self.ws.send(msg)
        return self._id

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


def accept_dialog(cdp, session=None, prompt_text=None, tries=25):
    """把弹出来的 confirm/prompt 点掉（confirm → 确定；prompt → 填 prompt_text）。"""
    for _ in range(tries):
        params = {"accept": True}
        if prompt_text is not None:
            params["promptText"] = prompt_text
        r = cdp.call("Page.handleJavaScriptDialog", params, session, timeout=6)
        if not r.get("error"):
            return True
        time.sleep(0.2)
    return False


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
                '<div id="deck">'
                '<section class="slide" style="height:110px"><h2 style="width:40%;margin:0">第一页</h2></section>'
                '<section class="slide" style="height:110px"><h2 style="width:40%;margin:0">第二页</h2></section>'
                '<section class="slide" style="height:110px"><h2 style="width:40%;margin:0">第三页</h2></section>'
                '</div>\n'
                '<svg viewBox="0 0 28 12"><line x1="2" y1="6" x2="22" y2="6" '
                'stroke="#1976d2"/></svg>\n'
                '<script>window.__clicks=0;'
                'document.addEventListener("click",function(){window.__clicks++});'
                '</script>\n</body></html>\n')

    # 本地起一个 http 站点：模拟「别人把一个 html 分享给我」的场景
    site_dir = os.path.join(work, "site")
    os.makedirs(site_dir, exist_ok=True)
    with open(os.path.join(site_dir, "remote.html"), "w", encoding="utf-8") as f:
        f.write('<!DOCTYPE html>\n<html lang="zh-CN"><head><meta charset="utf-8">'
                '<title>远程</title>'
                '<link rel="stylesheet" href="style.css">'
                '</head>\n<body><h1>远程标题</h1>'
                '<p><img src="pic.svg" alt=""></p>\n</body></html>\n')
    with open(os.path.join(site_dir, "style.css"), "w", encoding="utf-8") as f:
        f.write('body{font-family:sans-serif}\n')
    with open(os.path.join(site_dir, "pic.svg"), "w", encoding="utf-8") as f:
        f.write('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">'
                '<rect width="10" height="10" fill="#1976d2"/></svg>\n')

    handler = functools.partial(SimpleHTTPRequestHandler, directory=site_dir)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    web_port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    web_url = f"http://127.0.0.1:{web_port}/remote.html"
    downloads = os.path.join(os.path.expanduser("~"), "Downloads")
    os.makedirs(downloads, exist_ok=True)
    remote_local = os.path.join(downloads, f"127.0.0.1-remote.html")
    for stale in (remote_local,):
        if os.path.exists(stale):
            os.remove(stale)

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

        def wait(expr, sec=12, session=None):
            end = time.time() + sec
            while time.time() < end:
                if cdp.ev(expr, session or sess) is True:
                    return True
                time.sleep(0.35)
            return False

        ok("content script 注入本地 html", wait(f"!!{SH} && !!{SH}.shadowRoot"))
        ok("✎ 圆钮出现", cdp.ev(f"!!{SH}.shadowRoot.querySelector('.fab')", sess) is True)
        ok("默认不可编辑", cdp.ev("document.body.getAttribute('contenteditable')", sess) is None)

        cdp.ev(f"{SH}.shadowRoot.querySelector('.fab').click()", sess)
        ok("点 ✎ 进入编辑", wait("document.body.getAttribute('contenteditable')==='true'"))
        ok("点 ✎ 不触发页面的点击监听",
           cdp.ev("window.__clicks", sess) == 0, cdp.ev("window.__clicks", sess))
        ok("工具条出现", cdp.ev(f"!!{SH}.shadowRoot.querySelector('.bar')", sess) is True)

        tag = cdp.ev("""(()=>{const el=document.querySelector('h1');if(!el)return null;
            el.textContent='改过的标题 ★E2E★';
            el.dispatchEvent(new Event('input',{bubbles:true}));return el.tagName;})()""", sess)
        ok("改文字", tag == "H1", tag)
        ok("出现未保存橙点", wait(f"!!{SH}.shadowRoot.querySelector('.dot.show')", 6))

        clicks_before = cdp.ev("window.__clicks", sess)
        cdp.ev(f"{SH}.shadowRoot.querySelector('[data-a=\"save\"]').click()", sess)
        saved = False
        for _ in range(25):
            time.sleep(0.4)
            if "★E2E★" in open(page, encoding="utf-8").read():
                saved = True
                break
        ok("经 native messaging 真实落盘", saved, f"{os.path.getsize(page)} bytes")
        ok("点保存不触发页面的点击监听（不会翻页/跳转）",
           cdp.ev("window.__clicks", sess) == clicks_before,
           f"{clicks_before} → {cdp.ev('window.__clicks', sess)}")

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

        # ---------------- 字体 / 字号 ----------------
        cdp.ev("""(()=>{const h=document.querySelector('h1');const r=document.createRange();
            r.selectNodeContents(h);const s=getSelection();s.removeAllRanges();s.addRange(r);
            return true;})()""", sess)
        cdp.ev(f"""(()=>{{const b=[...{SH}.shadowRoot.querySelectorAll('.bar button')]
            .find(x=>x.textContent==='Aa');b.click();return !!b;}})()""", sess)
        ok("Aa 面板打开",
           cdp.ev(f"!!{SH}.shadowRoot.querySelector('.pop[data-pop=\"font\"]')", sess) is True)

        cdp.ev(f"""(()=>{{const sels={SH}.shadowRoot.querySelectorAll('.pop[data-pop="font"] select');
            sels[1].value='32';sels[1].dispatchEvent(new Event('change'));return true;}})()""", sess)
        fs = cdp.ev("""(()=>{const s=document.querySelector('h1 span[style*="font-size"]');
            return s?getComputedStyle(s).fontSize:null})()""", sess)
        ok("字号应用到选中文字", fs == "32px", fs)

        cdp.ev(f"""(()=>{{const f={SH}.shadowRoot
            .querySelectorAll('.pop[data-pop="font"] select')[0];
            f.value='Georgia, "Songti SC", serif';f.dispatchEvent(new Event('change'));
            return true;}})()""", sess)
        ff = cdp.ev("""(()=>{const s=document.querySelector('h1 span[style*="font-family"]');
            return s?s.getAttribute('style'):null})()""", sess)
        ok("字体应用到选中文字", "Georgia" in (ff or ""), ff)
        ok("改字体不会弄丢之前的字号", "32px" in (ff or ""), ff)
        ok("字体字号不改动其他标签结构",
           cdp.ev("document.querySelectorAll('h1').length", sess) == 1,
           cdp.ev("document.querySelectorAll('h1').length", sess))
        cdp.ev(f"{SH}.shadowRoot.querySelectorAll('.pop').forEach(n=>n.remove())", sess)
        # 局部选区：只包住选中的那几个字，其余不动
        cdp.ev("""(()=>{const p=document.querySelector('p');const t=p.firstChild;
            const r=document.createRange();r.setStart(t,0);r.setEnd(t,2);
            const s=getSelection();s.removeAllRanges();s.addRange(r);return true})()""", sess)
        cdp.ev(f"""(()=>{{[...{SH}.shadowRoot.querySelectorAll('.bar button')]
            .find(x=>x.textContent==='Aa').click();return true}})()""", sess)
        cdp.ev(f"""(()=>{{const sels={SH}.shadowRoot.querySelectorAll('.pop[data-pop="font"] select');
            sels[1].value='40';sels[1].dispatchEvent(new Event('change'));return true}})()""", sess)
        part = cdp.ev("""(()=>{const p=document.querySelector('p');
            return {html:p.innerHTML, text:p.textContent}})()""", sess)
        ok("局部选区只包住选中的字",
           isinstance(part, dict) and part.get("text") == "一段要改的文字"
           and "font-size:40px" in (part.get("html") or "").replace(" ", "")
           and (part.get("html") or "").count("<span") == 1, part)
        cdp.ev(f"{SH}.shadowRoot.querySelectorAll('.pop').forEach(n=>n.remove())", sess)

        # ---------------- 拖动模块 ----------------
        cdp.ev(f"""(()=>{{[...{SH}.shadowRoot.querySelectorAll('.bar button')]
            .find(x=>x.textContent==='移动').click();return true}})()""", sess)
        ok("进入移动模式",
           cdp.ev("document.documentElement.classList.contains('hs-move-mode')", sess) is True)
        ok("移动模式下关掉文字编辑",
           cdp.ev("document.body.getAttribute('contenteditable')", sess) == "false")

        coords = cdp.ev("""(()=>{const s=[...document.querySelectorAll('#deck > .slide')];
            const a=s[1].getBoundingClientRect(), b=s[0].getBoundingClientRect();
            return {x1:Math.round(a.left+a.width*0.8),y1:Math.round(a.top+10),
                    x2:Math.round(b.left+b.width*0.8),y2:Math.round(b.top+10)};})()""", sess)
        cdp.ev(f"""(()=>{{const c={json.dumps(coords)};
          const common={{bubbles:true,cancelable:true,composed:true,pointerId:1,
                        pointerType:'mouse',isPrimary:true}};
          const hit=(x,y)=>document.elementFromPoint(x,y);
          const fire=(ty,x,y,buttons)=>hit(x,y).dispatchEvent(
            new PointerEvent(ty,Object.assign({{clientX:x,clientY:y,buttons:buttons}},common)));
          fire('pointerdown',c.x1,c.y1,1);
          fire('pointermove',c.x1,c.y1-6,1);
          fire('pointermove',c.x2,c.y2,1);
          fire('pointerup',c.x2,c.y2,0);
          return true}})()""", sess)
        order = cdp.ev("[...document.querySelectorAll('#deck > .slide h2')]"
                       ".map(x=>x.textContent)", sess)
        ok("拖动后顺序变化", bool(order) and order[0] == "第二页", order)

        # Cmd+Z 撤销拖动（脚本改的 DOM，浏览器自带撤销追不到，扩展自己记了一份）
        cdp.ev("""(()=>{document.dispatchEvent(new KeyboardEvent('keydown',
            {key:'z',metaKey:true,bubbles:true,cancelable:true}));return true})()""", sess)
        undone = cdp.ev("[...document.querySelectorAll('#deck > .slide h2')]"
                        ".map(x=>x.textContent)", sess)
        ok("Cmd+Z 撤销拖动", undone == ["第一页", "第二页", "第三页"], undone)

        # 再拖一次，供后面的删页用例使用
        cdp.ev(f"""(()=>{{const c={json.dumps(coords)};
          const common={{bubbles:true,cancelable:true,composed:true,pointerId:1,
                        pointerType:'mouse',isPrimary:true}};
          const hit=(x,y)=>document.elementFromPoint(x,y);
          const fire=(ty,x,y,buttons)=>hit(x,y).dispatchEvent(
            new PointerEvent(ty,Object.assign({{clientX:x,clientY:y,buttons:buttons}},common)));
          fire('pointerdown',c.x1,c.y1,1);
          fire('pointermove',c.x1,c.y1-6,1);
          fire('pointermove',c.x2,c.y2,1);
          fire('pointerup',c.x2,c.y2,0);
          return true}})()""", sess)
        ok("拖动的元素数量不变",
           cdp.ev("document.querySelectorAll('#deck > .slide').length", sess) == 3,
           cdp.ev("document.querySelectorAll('#deck > .slide').length", sess))
        ok("拖动不留幽灵节点",
           cdp.ev("document.querySelectorAll('[data-hs-drag]').length", sess) == 0)
        cdp.ev(f"""(()=>{{[...{SH}.shadowRoot.querySelectorAll('.bar button')]
            .find(x=>x.textContent==='移动').click();return true}})()""", sess)
        ok("退出移动模式",
           cdp.ev("!document.documentElement.classList.contains('hs-move-mode')", sess) is True)

        # ---------------- 删除某一页 ----------------
        cdp.ev(f"""(()=>{{[...{SH}.shadowRoot.querySelectorAll('.bar button')]
            .find(x=>x.textContent==='页面').click();return true}})()""", sess)
        rows = cdp.ev(f"{SH}.shadowRoot.querySelectorAll('.pop[data-pop=\"pages\"] .pop-row').length",
                      sess)
        ok("识别出 3 页", rows == 3, rows)

        cdp.call("Page.enable", session=sess)
        cdp.fire("Runtime.evaluate", {
            "expression": f"""(()=>{{const w={SH}.shadowRoot.querySelector('.pop[data-pop="pages"]');
                w.querySelector('.pop-row button').click();return true}})()""",
            "returnByValue": True,
        }, sess)
        ok("删除时 confirm 弹窗", accept_dialog(cdp, sess))
        time.sleep(0.8)
        left = cdp.ev("document.querySelectorAll('#deck > .slide').length", sess)
        ok("删掉一页（剩 2 页）", left == 2, left)
        ok("删的是第 1 页",
           cdp.ev("[...document.querySelectorAll('#deck > .slide h2')].map(x=>x.textContent).join(',')",
                  sess) == "第一页,第三页",
           cdp.ev("[...document.querySelectorAll('#deck > .slide h2')].map(x=>x.textContent).join(',')",
                  sess))
        cdp.ev(f"{SH}.shadowRoot.querySelectorAll('.pop').forEach(n=>n.remove())", sess)

        # ---------------- 本地文件：另存为副本 ----------------
        copy_path = os.path.join(work, "copy.html")
        cdp.call("Page.enable", session=sess)
        cdp.ev(f"""(()=>{{[...{SH}.shadowRoot.querySelectorAll('.bar button')]
            .find(x=>x.textContent==='⋯').click();return true}})()""", sess)
        cdp.fire("Runtime.evaluate", {
            "expression": f"""(()=>{{const w={SH}.shadowRoot.querySelector('.pop[data-pop="more"]');
                [...w.querySelectorAll('button')].find(b=>b.textContent.startsWith('另存为')).click();
                return true}})()""",
            "returnByValue": True,
        }, sess)
        ok("另存为弹出路径输入", accept_dialog(cdp, sess, prompt_text=copy_path))
        copied = False
        for _ in range(25):
            time.sleep(0.3)
            if os.path.exists(copy_path):
                copied = True
                break
        ok("另存为生成了副本", copied, copy_path)
        copy_txt = open(copy_path, encoding="utf-8").read() if copied else ""
        flat = copy_txt.replace(" ", "")
        ok("副本带着改动一起走",
           "font-size:32px" in flat and "font-family:Georgia" in flat,
           re.search(r"<h1>.{0,80}", copy_txt).group(0) if re.search(r"<h1>.{0,80}", copy_txt) else "")
        ok("副本无编辑器残留",
           "__html_studio_host__" not in copy_txt and "contenteditable" not in copy_txt.lower())

        copy_mtime = os.path.getmtime(copy_path) if copied else 0
        time.sleep(0.1)
        cdp.fire("Runtime.evaluate", {
            "expression": f"""(()=>{{const w={SH}.shadowRoot.querySelector('.pop[data-pop="more"]');
                [...w.querySelectorAll('button')].find(b=>b.textContent.startsWith('另存为')).click();
                return true}})()""",
            "returnByValue": True,
        }, sess)
        accept_dialog(cdp, sess, prompt_text=copy_path)
        time.sleep(1.0)
        ok("另存为不覆盖已存在的文件",
           os.path.exists(copy_path) and os.path.getmtime(copy_path) == copy_mtime,
           f"{copy_mtime} → {os.path.getmtime(copy_path) if os.path.exists(copy_path) else 'gone'}")
        cdp.ev(f"{SH}.shadowRoot.querySelectorAll('.pop').forEach(n=>n.remove())", sess)

        # ---------------- 网页（http）→ 保存成本地文件 ----------------
        tr = cdp.call("Target.createTarget", {"url": web_url})
        sr = cdp.call("Target.attachToTarget",
                      {"targetId": tr["result"]["targetId"], "flatten": True})["result"]["sessionId"]
        cdp.call("Runtime.enable", session=sr)
        ok("网页上自动出现 ✎",
           wait(f"!!{SH}.shadowRoot.querySelector('.fab')", 20, sr))

        cdp.ev(f"{SH}.shadowRoot.querySelector('.fab').click()", sr)
        ok("网页上进入编辑", wait("document.body.getAttribute('contenteditable')==='true'", 10))
        t_before = cdp.ev(f"({SH}.shadowRoot.querySelector('.toast')||{{}}).textContent||''", sr)
        ok("提示首次保存在 Downloads", "Downloads" in (t_before or ""), t_before)
        cdp.ev("""(()=>{const el=document.querySelector('h1');
            el.textContent='★REMOTE★ 改过的网页标题';
            el.dispatchEvent(new Event('input',{bubbles:true}));return true})()""", sr)

        cdp.ev(f"{SH}.shadowRoot.querySelector('[data-a=\"save\"]').click()", sr)
        remote_saved = False
        for _ in range(30):
            time.sleep(0.4)
            if os.path.exists(remote_local) and "★REMOTE★" in open(remote_local, encoding="utf-8").read():
                remote_saved = True
                break
        ok("网页改动落成了本地 html", remote_saved, remote_local)

        if remote_saved:
            rtxt = open(remote_local, encoding="utf-8").read()
            ok("相对 CSS 转成绝对地址", f"http://127.0.0.1:{web_port}/style.css" in rtxt,
               [l for l in rtxt.splitlines() if "style.css" in l][:1])
            ok("相对图片转成绝对地址", f"http://127.0.0.1:{web_port}/pic.svg" in rtxt,
               [l for l in rtxt.splitlines() if "pic.svg" in l][:1])
            ok("网页落盘同样无编辑器残留",
               "__html_studio_host__" not in rtxt and "contenteditable" not in rtxt.lower()
               and "hs-move-mode" not in rtxt)
            r_toast = cdp.ev(f"({SH}.shadowRoot.querySelector('.toast')||{{}}).textContent||''", sr)
            ok("网页保存提示包含落盘路径", remote_local.split("/")[-1] in (r_toast or ""), r_toast)

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
        httpd.shutdown()
        for p in (remote_local,):
            try:
                os.remove(p)
            except OSError:
                pass
        shutil.rmtree(os.path.join(STATE_DIR, "backups", "Downloads", "127.0.0.1-remote.html.bak"),
                      ignore_errors=True)

    print("\n".join(PASS))
    print("\n".join(FAIL))
    print(f"\n{len(PASS)}/{len(PASS) + len(FAIL)}")
    return 0 if not FAIL else 1


if __name__ == "__main__":
    sys.exit(main())
