#!/usr/bin/env python3
"""
collab.py — 多人共享批注服务（零第三方依赖，仅标准库）

html-studio 的「批注」默认是单机的：批注存在浏览器本地，靠侧栏 ⬇/⬆ 导 JSON 交换。
想让大家在同一份稿子上实时看到彼此的批注，就起这个服务：

    python3 collab.py --dir ~/Desktop/reports
    python3 collab.py --dir ~/Desktop/reports --port 8899 --passcode 你的口令

它做三件事：
  1. 静态服务指定目录里的 HTML，并在 </body> 前注入批注引擎（页面打开就带批注）
  2. 提供 /api/state、/api/stream(SSE)、/api/op —— 批注实时同步
  3. 权限：只有作者本人能「标记已解决 / 删除」自己的批注（按浏览器身份令牌校验）

数据落在 <dir>/../data 或 --data 指定目录，一个文档一个 json，可直接备份/进 Git。
"""
from __future__ import annotations

import argparse
import base64
import gzip
import json
import mimetypes
import os
import queue
import re
import secrets
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(HERE)  # skills/html-annotate

def _find_engine():
    """引擎真源优先级：skill 自带 lib/ > 仓库 extension/lib/（兼容老目录）。"""
    for p in (os.path.join(ROOT_DIR, "lib", "annotator.js"),
              os.path.join(ROOT_DIR, "extension", "lib", "annotator.js")):
        if os.path.isfile(p):
            return p
    return os.path.join(ROOT_DIR, "lib", "annotator.js")

ENGINE_PATH = _find_engine()

COMPRESSIBLE = re.compile(r"\.(html?|js|mjs|css|json|svg|txt|map)$", re.I)
MIME = {
    ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8", ".mjs": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
    ".svg": "image/svg+xml", ".webp": "image/webp", ".ico": "image/x-icon",
    ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
}


# ─────────────────────────── 数据与权限 ───────────────────────────

def safe_name(s: str) -> str:
    """保留 unicode 字母数字（中文文件名可用），其余替换成下划线。"""
    s = re.sub(r"[^\w\-\u4e00-\u9fff]+", "_", str(s or "default"), flags=re.UNICODE)
    return (s[:120] or "default")


class Store:
    """批注数据 + 身份绑定，全部落盘。"""

    def __init__(self, data_dir: str):
        self.dir = data_dir
        self.lock = threading.RLock()
        self.docs: dict[str, list] = {}
        self._mtimes: dict[str, float] = {}   # 用于跨进程一致：文件被别的进程改过就重载
        self.identities: dict[str, str] = {}
        os.makedirs(self.dir, exist_ok=True)
        self._ident_path = os.path.join(self.dir, "identity.json")
        try:
            with open(self._ident_path, encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                self.identities = data
        except Exception:
            self.identities = {}

    # ---- 文档 ----
    def _doc_path(self, doc: str) -> str:
        return os.path.join(self.dir, safe_name(doc) + ".json")

    def _mtime(self, doc: str) -> float:
        try:
            return os.stat(self._doc_path(doc)).st_mtime
        except OSError:
            return 0.0

    def load(self, doc: str) -> list:
        """同一份 JSON 可能被多个服务（8899 批注服务 / 7788 网页版）同时读写，
        所以缓存必须按文件 mtime 失效，否则两边会互相覆盖。"""
        with self.lock:
            disk_m = self._mtime(doc)
            if doc in self.docs and self._mtimes.get(doc) == disk_m:
                return self.docs[doc]
            anns: list = []
            try:
                with open(self._doc_path(doc), encoding="utf-8") as f:
                    raw = json.load(f)
                if isinstance(raw.get("annotations"), list):
                    anns = raw["annotations"]
            except Exception:
                pass
            self.docs[doc] = anns
            self._mtimes[doc] = disk_m
            return anns

    def persist(self, doc: str) -> None:
        with self.lock:
            payload = {"doc": doc, "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
                       "annotations": self.docs.get(doc, [])}
            try:
                tmp = self._doc_path(doc) + ".tmp"
                with open(tmp, "w", encoding="utf-8") as f:
                    json.dump(payload, f, ensure_ascii=False, indent=2)
                os.replace(tmp, self._doc_path(doc))
                self._mtimes[doc] = self._mtime(doc)
            except Exception as e:
                print(f"[persist] 写入失败: {e}", file=sys.stderr)

    # ---- 操作 ----
    @staticmethod
    def apply_op(anns: list, op: dict) -> None:
        kind = op.get("type")
        find = lambda i: next((a for a in anns if a.get("id") == i), None)  # noqa: E731
        if kind == "add":
            a = op.get("annotation")
            if a and not find(a.get("id")):
                anns.append(a)
        elif kind == "reply":
            a = find(op.get("id"))
            if a is not None:
                a.setdefault("replies", [])
                r = op.get("reply") or {}
                if not any(x.get("id") == r.get("id") for x in a["replies"]):
                    a["replies"].append(r)
        elif kind == "status":
            a = find(op.get("id"))
            if a is not None:
                a["status"] = op.get("status")
        elif kind == "delete":
            idx = next((i for i, a in enumerate(anns) if a.get("id") == op.get("id")), -1)
            if idx >= 0:
                anns.pop(idx)

    # ---- 身份 ----
    def name_of_token(self, token: str):
        return self.identities.get(token)

    def token_of_name(self, name: str):
        for t, n in self.identities.items():
            if n == name:
                return t
        return None

    def claim_name(self, token: str, name: str):
        """把署名绑定到浏览器令牌；成功返回 None，失败返回错误文案。"""
        name = (name or "").strip()
        if not name:
            return "缺少署名，请刷新页面后重试"
        if not token:
            return "缺少身份标识，请刷新页面后重试（需允许本站 cookie）"
        with self.lock:
            owner = self.token_of_name(name)
            if owner and owner != token:
                return f"「{name}」这个署名已被别人占用，请点标题栏改成别的名字"
            if not owner:
                self.identities[token] = name
                try:
                    with open(self._ident_path, "w", encoding="utf-8") as f:
                        json.dump(self.identities, f, ensure_ascii=False, indent=2)
                except Exception:
                    pass
        return None

    def check_permission(self, anns: list, op: dict, token: str):
        """只有作者本人能标记已解决 / 删除。绝不隐式绑定（否则拿到链接就能认领别人的批注）。"""
        if op.get("type") not in ("status", "delete"):
            return None
        a = next((x for x in anns if x.get("id") == op.get("id")), None)
        if a is None:
            return None
        owner = str((a.get("author") or {}).get("name") or "").strip()
        mine = self.name_of_token(token)
        if not mine:
            return "你还没在这份稿子留过批注，不能操作别人的批注（先发一条批注完成身份登记）"
        if mine != owner:
            verb = "删除" if op.get("type") == "delete" else "标记已解决"
            return f"只有作者本人（{owner}）可以{verb}别人的批注"
        return None


class Hub:
    """SSE 订阅者管理。"""

    def __init__(self):
        self.lock = threading.Lock()
        self.subs: dict[str, set[queue.Queue]] = {}

    def subscribe(self, doc: str) -> queue.Queue:
        q: queue.Queue = queue.Queue()
        with self.lock:
            self.subs.setdefault(doc, set()).add(q)
        return q

    def unsubscribe(self, doc: str, q: queue.Queue) -> None:
        with self.lock:
            s = self.subs.get(doc)
            if s:
                s.discard(q)
                if not s:
                    self.subs.pop(doc, None)

    def presence(self, doc: str) -> int:
        with self.lock:
            return len(self.subs.get(doc, ()))

    def broadcast(self, doc: str, payload: dict) -> None:
        with self.lock:
            targets = list(self.subs.get(doc, ()))
        for q in targets:
            try:
                q.put_nowait(payload)
            except Exception:
                pass


# ─────────────────────────── 服务器 ───────────────────────────

def doc_id_for(pathname: str) -> str:
    s = urllib.parse.unquote(pathname)
    s = re.sub(r"^/+", "", s)
    s = re.sub(r"\.html?$", "", s, flags=re.I)
    s = re.sub(r"[^\w\-\u4e00-\u9fff]+", "_", s, flags=re.UNICODE).strip("_")
    return s or "index"


def escape_html(s: str) -> str:
    return (str(s or "").replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;").replace('"', "&quot;"))


class Handler(BaseHTTPRequestHandler):
    server_version = "html-studio-collab"
    protocol_version = "HTTP/1.1"

    # 由 serve() 注入
    root = "."
    store: Store = None  # type: ignore
    hub: Hub = None  # type: ignore
    auth_user = "review"
    auth_pass = ""
    inject = True
    engine = ""
    verbose = True
    _pending_cookie = None

    # ---------- 工具 ----------
    def log_message(self, fmt, *args):
        if self.verbose:
            sys.stderr.write("  %s\n" % (fmt % args))

    def _auth_ok(self) -> bool:
        if not self.auth_pass:
            return True
        header = self.headers.get("Authorization", "")
        if not header.lower().startswith("basic "):
            return False
        try:
            raw = base64.b64decode(header[6:].strip()).decode("utf-8", "replace")
        except Exception:
            return False
        expected = f"{self.auth_user}:{self.auth_pass}"
        return secrets.compare_digest(raw, expected)

    def _challenge(self):
        body = ("<!doctype html><meta charset=utf-8><title>需要口令</title>"
                "<body style=\"font:15px/1.7 -apple-system,'PingFang SC',sans-serif;"
                "max-width:520px;margin:90px auto;padding:0 24px;color:#1c1410\">"
                "<h2>需要访问口令</h2><p>这份评审稿是受保护的，请输入口令。"
                "<br><span style='color:#888;font-size:13px'>用户名 review</span></p></body>").encode()
        self.send_response(401)
        self.send_header("WWW-Authenticate", 'Basic realm="HTML Studio Collab", charset="UTF-8"')
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _cookie(self, name: str):
        raw = self.headers.get("Cookie", "")
        for part in raw.split(";"):
            if "=" in part:
                k, v = part.split("=", 1)
                if k.strip() == name:
                    return urllib.parse.unquote(v.strip())
        return None

    def _send(self, code: int, body: bytes, ctype: str, extra: dict | None = None):
        accepts_gzip = "gzip" in (self.headers.get("Accept-Encoding") or "").lower()
        headers = {"Content-Type": ctype, "Cache-Control": "no-cache",
                   "Access-Control-Allow-Origin": "*"}
        if extra:
            headers.update(extra)
        if self._pending_cookie:
            headers["Set-Cookie"] = self._pending_cookie
            self._pending_cookie = None
        if accepts_gzip and len(body) > 1024:
            base_type = ctype.split(";")[0].strip()
            if (base_type.startswith("text/")
                    or base_type in ("application/json", "application/javascript", "image/svg+xml")):
                body = gzip.compress(body, 6)
                headers["Content-Encoding"] = "gzip"
                headers["Vary"] = "Accept-Encoding"
        headers["Content-Length"] = str(len(body))
        self.send_response(code)
        for k, v in headers.items():
            self.send_header(k, v)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj, ensure_ascii=False).encode(), "application/json; charset=utf-8")

    def _token(self) -> str:
        """取身份令牌，没有就发一个（HttpOnly，防 JS 读取）。"""
        token = self._cookie("anno_id")
        if not token:
            token = "t_" + secrets.token_hex(16)
            self._pending_cookie = f"anno_id={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000"
        return token

    # ---------- 注入 ----------
    def _inject_engine(self, html: str, doc: str):
        if not self.inject or not self.engine:
            return html
        if re.search(r"HtmlAnnotator|data-anno-self|annotator(\.min)?\.js", html):
            return html
        engine = self.engine
        # 扩展副本带「手动初始化」开关，服务端注入的页面需要自动初始化
        engine = engine.replace("window.__ANNO_DISABLE_AUTOINIT__ = true;", "")
        engine = re.sub(r"</script", r"<\\/script", engine, flags=re.I)
        meta = ("<script>(function(){try{var m=document.createElement('meta');"
                "m.setAttribute('name','anno-doc-id');m.setAttribute('content',"
                + json.dumps(doc) + ");"
                "(document.head||document.documentElement).appendChild(m);}catch(e){}})();</script>\n")
        tag = "\n<!-- html-studio collab: 自动注入批注 -->\n" + meta + \
              '<script data-anno-self="1" data-doc-id="' + escape_html(doc) + '">\n' + engine + "\n</script>\n"
        if re.search(r"</body>", html, re.I):
            return re.sub(r"</body>", lambda m: tag + "</body>", html, count=1, flags=re.I)
        return html + tag

    # ---------- 路由 ----------
    def do_OPTIONS(self):
        self.send_response(204)
        for k, v in (("Access-Control-Allow-Origin", "*"),
                     ("Access-Control-Allow-Methods", "GET,POST,OPTIONS"),
                     ("Access-Control-Allow-Headers", "Content-Type")):
            self.send_header(k, v)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        if not self._auth_ok():
            return self._challenge()
        self._pending_cookie = None
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)
        doc = (query.get("doc") or ["default"])[0]
        token = self._token()

        if path == "/api/health":
            return self._json({"ok": True, "docs": list(self.store.docs),
                               "inject": self.inject and bool(self.engine), "root": self.root})
        if path == "/api/state":
            anns = self.store.load(doc)
            return self._json({"doc": doc, "annotations": anns,
                               "presence": self.hub.presence(doc)})
        if path == "/api/stream":
            return self._stream(doc)
        if path in ("/", "/index.html") and not os.path.isfile(os.path.join(self.root, "index.html")):
            return self._send(200, self._directory_page().encode(), "text/html; charset=utf-8")
        return self._static(path, query)

    def _stream(self, doc: str):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache, no-transform")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        q = self.hub.subscribe(doc)
        try:
            self.wfile.write(b"retry: 3000\n\n")
            self.wfile.flush()
            anns = self.store.load(doc)
            self._sse_write({"type": "sync", "doc": doc, "annotations": anns})
            self._sse_write({"type": "presence", "count": self.hub.presence(doc), "doc": doc})
            self.hub.broadcast(doc, {"type": "presence", "count": self.hub.presence(doc), "doc": doc})
            last = time.time()
            while True:
                try:
                    payload = q.get(timeout=25)
                    self._sse_write(payload)
                except queue.Empty:
                    self.wfile.write(b": hb\n\n")
                    self.wfile.flush()
                if time.time() - last > 3600:
                    break
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            self.hub.unsubscribe(doc, q)
            self.hub.broadcast(doc, {"type": "presence", "count": self.hub.presence(doc), "doc": doc})

    def _sse_write(self, payload: dict):
        self.wfile.write(b"data: " + json.dumps(payload, ensure_ascii=False).encode() + b"\n\n")
        self.wfile.flush()

    def do_POST(self):
        if not self._auth_ok():
            return self._challenge()
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != "/api/op":
            return self._json({"ok": False, "error": "not found"}, 404)
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw.decode("utf-8") or "{}")
        except Exception:
            return self._json({"ok": False, "error": "请求体不是合法 JSON"}, 400)

        op = payload.get("op") or {}
        doc = payload.get("doc") or (urllib.parse.parse_qs(parsed.query).get("doc") or ["default"])[0]
        if not op.get("type"):
            return self._json({"ok": False, "error": "缺少 op"}, 400)
        token = self._cookie("anno_id") or ""

        anns = self.store.load(doc)
        denied = self.store.check_permission(anns, op, token)
        if denied:
            return self._json({"ok": False, "error": denied}, 403)

        claim_err = None
        if op.get("type") == "add":
            claim_err = self.store.claim_name(token, (op.get("annotation") or {}).get("author", {}).get("name"))
        elif op.get("type") == "reply":
            claim_err = self.store.claim_name(token, (op.get("reply") or {}).get("author", {}).get("name"))
        if claim_err:
            return self._json({"ok": False, "error": claim_err}, 409)

        self.store.apply_op(anns, op)
        self.store.persist(doc)
        self.hub.broadcast(doc, {"type": "op", "doc": doc, "op": op})
        return self._json({"ok": True})

    # ---------- 静态文件 ----------
    def _static(self, path: str, query: dict):
        rel = urllib.parse.unquote(path)
        fp = os.path.normpath(os.path.join(self.root, rel.lstrip("/")))
        if not fp.startswith(os.path.normpath(self.root)):
            return self._json({"error": "forbidden"}, 403)
        if os.path.isdir(fp):
            fp = os.path.join(fp, "index.html")
        if not os.path.isfile(fp) and not os.path.splitext(fp)[1]:
            alt = fp + ".html"
            if os.path.isfile(alt):
                fp = alt        # 少写扩展名也能打开，docId 仍按请求路径算
        if not os.path.isfile(fp):
            return self._send(404, self._not_found(path).encode(), "text/html; charset=utf-8")
        ext = os.path.splitext(fp)[1].lower()
        ctype = MIME.get(ext) or mimetypes.guess_type(fp)[0] or "application/octet-stream"
        try:
            with open(fp, "rb") as f:
                data = f.read()
        except OSError as e:
            return self._send(500, str(e).encode(), "text/plain; charset=utf-8")
        if ext in (".html", ".htm") and (query.get("anno") or [None])[0] != "off":
            html = self._inject_engine(data.decode("utf-8", "replace"), doc_id_for(path))
            return self._send(200, html.encode(), "text/html; charset=utf-8")
        return self._send(200, data, ctype)

    def _html_files(self):
        try:
            names = [n for n in os.listdir(self.root) if re.search(r"\.html?$", n, re.I)]
            return sorted(names, key=lambda n: -os.path.getmtime(os.path.join(self.root, n)))
        except OSError:
            return []

    def _not_found(self, path: str):
        items = "".join(
            f'<li><a href="/{urllib.parse.quote(n)}">{escape_html(n)}</a></li>' for n in self._html_files()
        ) or "<li>（空）</li>"
        return ("<!doctype html><html lang=zh><head><meta charset=utf-8>"
                "<title>404 · 找不到这份稿子</title>"
                "<style>body{font:15px/1.7 -apple-system,'PingFang SC',sans-serif;max-width:620px;"
                "margin:80px auto;padding:0 24px;color:#1c1410}code{background:#f3f3f5;padding:2px 6px;"
                "border-radius:4px;font-size:13px}a{color:#d8000f}</style></head><body>"
                "<h2>找不到这份稿子</h2>"
                f"<p>请求路径：<code>{escape_html(path)}</code></p>"
                f"<p>目录里现有：</p><ul>{items}</ul>"
                '<p><a href="/">← 回目录页</a></p></body></html>')

    def _directory_page(self):
        rows = "".join(
            f'<li><a href="/{urllib.parse.quote(n)}">{escape_html(n)}</a>'
            f'<code>docId: {doc_id_for("/" + n)}</code></li>' for n in self._html_files()
        ) or "<li>（空）</li>"
        return ("<!doctype html><html lang=zh><head><meta charset=utf-8>"
                "<meta name=viewport content='width=device-width,initial-scale=1'>"
                "<title>批注服务器 · 目录</title>"
                "<style>body{font:15px/1.6 -apple-system,'PingFang SC',sans-serif;max-width:760px;"
                "margin:60px auto;padding:0 24px;color:#1c1410}h1{font-size:24px}"
                ".hint{color:#888;font-size:13px;margin-bottom:24px}ul{list-style:none;padding:0}"
                "li{padding:14px 0;border-bottom:1px solid #eee}a{color:#d8000f;text-decoration:none;"
                "font-weight:600;font-size:17px}a:hover{text-decoration:underline}"
                "code{display:block;color:#999;font-size:12px;margin-top:4px}</style></head><body>"
                "<h1>批注服务器</h1>"
                f"<div class=hint>把任意 HTML 丢进 <code style='display:inline'>{escape_html(self.root)}</code>，"
                "打开即带批注 + 实时协作。</div>"
                f"<ul>{rows}</ul></body></html>")


# ─────────────────────────── 启动 ───────────────────────────

def lan_ips():
    import socket
    ips = []
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None):
            ip = info[4][0]
            if ":" not in ip and not ip.startswith("127.") and ip not in ips:
                ips.append(ip)
    except Exception:
        pass
    return ips


def serve(directory: str, port: int, passcode: str, data_dir: str, inject: bool, quiet: bool):
    root = os.path.abspath(os.path.expanduser(directory))
    os.makedirs(root, exist_ok=True)
    engine = ""
    if inject and os.path.isfile(ENGINE_PATH):
        with open(ENGINE_PATH, encoding="utf-8") as f:
            engine = f.read()
    elif inject:
        print(f"[warn] 找不到批注引擎 {ENGINE_PATH}，自动注入已关闭", file=sys.stderr)

    Handler.root = root
    Handler.store = Store(os.path.abspath(os.path.expanduser(data_dir)))
    Handler.hub = Hub()
    Handler.auth_pass = passcode or ""
    Handler.inject = inject
    Handler.engine = engine
    Handler.verbose = not quiet

    httpd = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    httpd.daemon_threads = True
    print("\n  HTML Studio · 共享批注服务已启动")
    print("  ──────────────────────────────")
    print(f"  目录:  {root}")
    print(f"  注入:  {'开（任何 HTML 自动带批注）' if engine else '关'}")
    print(f"  口令:  {'开（用户名 review）' if Handler.auth_pass else '关'}")
    print(f"  数据:  {Handler.store.dir}")
    print(f"  本机:  http://localhost:{port}/")
    for ip in lan_ips():
        print(f"  同事:  http://{ip}:{port}/   （同一局域网）")
    print("  公网:  用隧道，例如 bore local %d --to bore.pub" % port)
    print("  Ctrl+C 停止\n")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  已停止")
    finally:
        httpd.server_close()


def main():
    ap = argparse.ArgumentParser(
        description="HTML Studio 共享批注服务：静态服务 + 实时协作 + 作者权限，零第三方依赖")
    ap.add_argument("--dir", "-d", default=".", help="要服务的目录（放你的 HTML）")
    ap.add_argument("--port", "-p", type=int, default=8899, help="端口，默认 8899")
    ap.add_argument("--passcode", default="", help="访问口令（HTTP Basic 认证，用户名为 review）")
    ap.add_argument("--code-file", default="", help="从文件读取口令（内容即口令）")
    ap.add_argument("--data", default=os.path.join(ROOT_DIR, "data"), help="批注数据目录")
    ap.add_argument("--no-inject", action="store_true", help="不自动注入批注引擎")
    ap.add_argument("--quiet", action="store_true", help="不打访问日志")
    args = ap.parse_args()

    passcode = args.passcode
    if not passcode and args.code_file and os.path.isfile(args.code_file):
        with open(args.code_file, encoding="utf-8") as f:
            passcode = f.read().strip()
    serve(args.dir, args.port, passcode, args.data, not args.no_inject, args.quiet)


if __name__ == "__main__":
    main()
