#!/usr/bin/env python3
"""
HTML Studio - 本地 HTML 直接编辑服务器

用法:
    python3 server.py                  # 工作目录默认 ~/html-studio，端口 7788
    python3 server.py --dir ~/Downloads --port 8000
"""

import argparse
import base64
import datetime
import difflib
import hashlib
import json
import mimetypes
import os
import re
import sys
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
UI_PATH = os.path.join(HERE, "ui.html")

SKIP_DIRS = {
    ".git", ".svn", "node_modules", ".edits", "__pycache__", ".venv", "venv",
    "dist", "build", ".idea", ".vscode", "Library", "Applications", ".Trash",
    "Pictures", "Music", "Movies", "Public", ".cache", ".npm", ".agents",
    ".npm-global", ".docker", ".ssh", ".config",
}
HTML_EXT = {".html", ".htm"}
MAX_FILES = 4000
MAX_DEPTH = 6


def now_stamp():
    return datetime.datetime.now().strftime("%Y%m%d-%H%M%S")


class App:
    def __init__(self, root):
        self.root = os.path.abspath(os.path.expanduser(root))
        os.makedirs(self.root, exist_ok=True)

    # ---------- path helpers ----------
    @property
    def work(self):
        d = os.path.join(self.root, ".edits")
        os.makedirs(d, exist_ok=True)
        return d

    def real(self, rel):
        rel = urllib.parse.unquote(rel or "").replace("\\", "/").strip()
        rel = rel.lstrip("/")
        p = os.path.abspath(os.path.join(self.root, rel))
        if p != self.root and not p.startswith(self.root + os.sep):
            raise ValueError("路径越界: " + rel)
        return p

    def rel_of(self, abspath):
        return os.path.relpath(abspath, self.root).replace(os.sep, "/")

    # ---------- files ----------
    def list_files(self):
        out = []
        root_len = len(self.root) + 1
        for dirpath, dirnames, filenames in os.walk(self.root):
            depth = dirpath.count(os.sep) - self.root.count(os.sep)
            dirnames[:] = sorted(
                d for d in dirnames
                if d not in SKIP_DIRS and not d.startswith(".") and depth < MAX_DEPTH
            )
            for fn in filenames:
                if os.path.splitext(fn)[1].lower() not in HTML_EXT:
                    continue
                full = os.path.join(dirpath, fn)
                try:
                    st = os.stat(full)
                except OSError:
                    continue
                rel = full[root_len:].replace(os.sep, "/")
                out.append({
                    "path": rel,
                    "name": fn,
                    "dir": os.path.dirname(rel).replace(os.sep, "/"),
                    "size": st.st_size,
                    "mtime": int(st.st_mtime),
                })
                if len(out) >= MAX_FILES:
                    return sorted(out, key=lambda x: -x["mtime"])
        out.sort(key=lambda x: -x["mtime"])
        return out

    @staticmethod
    def normalize(html, old):
        """保留原文件的收尾换行习惯，避免每次保存都改掉最后一行。"""
        if old.endswith("\n") and not html.endswith("\n"):
            return html + "\n"
        return html

    def read_text(self, abspath):
        with open(abspath, "rb") as f:
            raw = f.read()
        for enc in ("utf-8", "utf-8-sig", "gb18030", "latin-1"):
            try:
                return raw.decode(enc)
            except UnicodeDecodeError:
                continue
        return raw.decode("utf-8", "replace")

    def backup(self, relpath):
        src = self.real(relpath)
        if not os.path.exists(src):
            return None
        bdir = os.path.join(self.work, "backups", os.path.dirname(relpath))
        os.makedirs(bdir, exist_ok=True)
        base = os.path.basename(relpath)
        stem, ext = os.path.splitext(base)
        name = f"{stem}.{now_stamp()}{ext}"
        i = 1
        while os.path.exists(os.path.join(bdir, name)):
            name = f"{stem}.{now_stamp()}-{i}{ext}"
            i += 1
        with open(os.path.join(bdir, name), "wb") as f:
            f.write(open(src, "rb").read())
        return name

    def list_backups(self, relpath):
        bdir = os.path.join(self.work, "backups", os.path.dirname(relpath))
        base = os.path.splitext(os.path.basename(relpath))[0]
        if not os.path.isdir(bdir):
            return []
        out = []
        for fn in os.listdir(bdir):
            if not fn.startswith(base + "."):
                continue
            full = os.path.join(bdir, fn)
            st = os.stat(full)
            out.append({"name": fn, "mtime": int(st.st_mtime), "size": st.st_size})
        out.sort(key=lambda x: -x["mtime"])
        return out

    def read_backup(self, relpath, name):
        if "/" in name or "\\" in name or name.startswith("."):
            raise ValueError("非法备份名")
        bdir = os.path.join(self.work, "backups", os.path.dirname(relpath))
        full = os.path.abspath(os.path.join(bdir, name))
        if not full.startswith(os.path.abspath(bdir)):
            raise ValueError("非法备份名")
        return self.read_text(full)


def make_diff(old, new, limit=6000):
    a = (old or "").splitlines()
    b = (new or "").splitlines()
    rows = []
    for line in difflib.unified_diff(a, b, "before", "after", n=2, lineterm=""):
        if line.startswith("+++") or line.startswith("---"):
            continue
        if line.startswith("@@"):
            rows.append(["@", line])
        elif line.startswith("+"):
            rows.append(["+", line[1:]])
        elif line.startswith("-"):
            rows.append(["-", line[1:]])
        else:
            rows.append([" ", line[1:] if line.startswith(" ") else line])
        if len(rows) > limit:
            rows.append(["@", f"... 差异过大，已截断（共 {len(a)} → {len(b)} 行）"])
            break
    return rows


APP = None


class Handler(BaseHTTPRequestHandler):
    server_version = "HTMLStudio/1.0"
    protocol_version = "HTTP/1.1"

    # ---------- plumbing ----------
    def log_message(self, fmt, *args):
        if os.environ.get("HTML_STUDIO_VERBOSE"):
            super().log_message(fmt, *args)

    def _send(self, code, body=b"", ctype="application/json; charset=utf-8", extra=None):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store, max-age=0")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def json(self, obj, code=200):
        self._send(code, json.dumps(obj, ensure_ascii=False), "application/json; charset=utf-8")

    def err(self, msg, code=400):
        self.json({"ok": False, "error": str(msg)}, code)

    def body_json(self):
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        return json.loads(self.rfile.read(n).decode("utf-8"))

    # ---------- GET ----------
    def do_GET(self):
        try:
            self.route_get()
        except FileNotFoundError as e:
            self.err(f"文件不存在: {e}", 404)
        except Exception as e:  # noqa: BLE001
            self.err(e, 500)

    def route_get(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        qs = urllib.parse.parse_qs(parsed.query)

        if path in ("/", "/index.html"):
            with open(UI_PATH, "rb") as f:
                return self._send(200, f.read(), "text/html; charset=utf-8")

        if path == "/api/state":
            home = os.path.expanduser("~")
            quick = [{"label": "主目录", "dir": home}]
            for sub in ("Downloads", "Desktop", "Documents"):
                d = os.path.join(home, sub)
                if os.path.isdir(d):
                    quick.append({"label": sub, "dir": d})
            return self.json({
                "ok": True,
                "root": APP.root,
                "home": home,
                "quick": quick,
                "files": APP.list_files(),
            })

        if path == "/api/backups":
            rel = (qs.get("path") or [""])[0]
            return self.json({"ok": True, "backups": APP.list_backups(rel)})

        if path == "/api/diff-backup":
            rel = (qs.get("path") or [""])[0]
            name = (qs.get("name") or [""])[0]
            old = APP.read_backup(rel, name)
            new = APP.read_text(APP.real(rel))
            return self.json({"ok": True, "diff": make_diff(old, new)})

        if path.startswith("/files/"):
            rel = path[len("/files/"):]
            full = APP.real(rel)
            if not os.path.isfile(full):
                raise FileNotFoundError(rel)
            ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
            if ctype.startswith("text/") or ctype in ("application/javascript", "image/svg+xml"):
                ctype += "; charset=utf-8"
            with open(full, "rb") as f:
                return self._send(200, f.read(), ctype)

        return self.err("not found", 404)

    # ---------- POST ----------
    def do_POST(self):
        try:
            self.route_post()
        except Exception as e:  # noqa: BLE001
            self.err(e, 500)

    def route_post(self):
        path = urllib.parse.urlparse(self.path).path
        data = self.body_json()

        if path == "/api/root":
            d = os.path.abspath(os.path.expanduser(str(data.get("dir") or "")))
            if not os.path.isdir(d):
                return self.err("目录不存在: " + d)
            APP.root = d
            return self.json({"ok": True, "root": APP.root, "files": APP.list_files()})

        if path == "/api/save":
            rel = str(data.get("path") or "").strip()
            html = data.get("html")
            if not rel or html is None:
                return self.err("缺少 path 或 html")
            full = APP.real(rel)
            if not os.path.exists(full):
                return self.err("文件不存在，请先新建: " + rel, 404)
            old = APP.read_text(full)
            body = APP.normalize(html, old)
            bak = APP.backup(rel)
            with open(full, "wb") as f:
                f.write(body.encode("utf-8"))
            return self.json({
                "ok": True,
                "path": rel,
                "backup": bak,
                "savedAt": int(datetime.datetime.now().timestamp()),
                "diff": make_diff(old, body),
            })

        if path == "/api/restore":
            rel = str(data.get("path") or "").strip()
            name = str(data.get("backup") or "").strip()
            old = APP.read_backup(rel, name)
            full = APP.real(rel)
            APP.backup(rel)  # 恢复前也备份一次，恢复可撤销
            with open(full, "wb") as f:
                f.write(old.encode("utf-8"))
            return self.json({"ok": True, "html": old})

        if path == "/api/create":
            rel = str(data.get("path") or "").strip().replace("\\", "/").lstrip("/")
            html = data.get("html") or ""
            if not rel:
                return self.err("缺少文件名")
            if not rel.lower().endswith((".html", ".htm")):
                rel += ".html"
            full = APP.real(rel)
            if os.path.exists(full):
                return self.err("已存在同名文件: " + rel)
            os.makedirs(os.path.dirname(full) or APP.root, exist_ok=True)
            with open(full, "wb") as f:
                f.write(html.encode("utf-8"))
            return self.json({"ok": True, "path": rel, "files": APP.list_files()})

        if path == "/api/upload":
            rel = str(data.get("path") or "").strip()
            dataurl = str(data.get("dataUrl") or "")
            m = re.match(r"^data:(image/[a-zA-Z0-9.+-]+);base64,(.+)$", dataurl, re.S)
            if not m:
                return self.err("只支持图片 dataUrl")
            mt, b64 = m.group(1), m.group(2)
            ext = {
                "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif",
                "image/webp": ".webp", "image/svg+xml": ".svg", "image/bmp": ".bmp",
            }.get(mt, mimetypes.guess_extension(mt) or ".png")
            raw = base64.b64decode(b64)
            if len(raw) > 20 * 1024 * 1024:
                return self.err("图片超过 20MB")
            digest = hashlib.sha1(raw).hexdigest()[:12]
            page_dir = os.path.dirname(APP.real(rel)) if rel else APP.root
            adir = os.path.join(page_dir, "assets")
            os.makedirs(adir, exist_ok=True)
            fname = f"img-{now_stamp()}-{digest}{ext}"
            with open(os.path.join(adir, fname), "wb") as f:
                f.write(raw)
            return self.json({"ok": True, "src": "assets/" + fname, "bytes": len(raw)})

        return self.err("not found", 404)


def main():
    global APP
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default=os.path.expanduser("~"))
    ap.add_argument("--port", type=int, default=7788)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--no-browser", action="store_true", help="启动时不自动打开浏览器")
    args = ap.parse_args()

    APP = App(args.dir)
    url = f"http://{args.host}:{args.port}"
    try:
        srv = ThreadingHTTPServer((args.host, args.port), Handler)
    except OSError as e:
        print(f"❌ 端口 {args.port} 启动失败: {e}", file=sys.stderr)
        print(f"   多半是已经有一个 HTML Studio 在跑了，直接打开 {url} 试试；", file=sys.stderr)
        print(f"   或换个端口: python3 server.py --port {args.port + 1}", file=sys.stderr)
        return 1
    print(f"HTML Studio  →  {url}")
    print(f"工作目录     →  {APP.root}")
    print("Ctrl+C 退出\n")
    if not args.no_browser:
        import threading
        import webbrowser
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")
    return 0


if __name__ == "__main__":
    sys.exit(main())
