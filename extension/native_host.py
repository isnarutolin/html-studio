#!/usr/bin/env python3
"""
HTML Studio native messaging host.

Chrome 扩展通过 native messaging（stdin/stdout，4 字节小端长度前缀 + JSON）调用本程序，
由它负责真正的磁盘读写：保存、自动备份、撤销、备份列表、图片落盘。

协议:
    请求 {"op": "...", ...}
    响应 {"ok": true, ...} 或 {"ok": false, "error": "..."}
"""

import base64
import datetime
import difflib
import hashlib
import json
import os
import re
import sys
import traceback

VERSION = "1.0.0"
HOME = os.path.realpath(os.path.expanduser("~"))
STATE_DIR = os.path.join(HOME, ".html-studio")
BACKUP_ROOT = os.path.join(STATE_DIR, "backups")
LOG_PATH = os.path.join(STATE_DIR, "host.log")
HTML_EXT = (".html", ".htm", ".xhtml")
MAX_INCOMING = 256 * 1024 * 1024  # 256MB 上限，防止异常消息


# --------------------------------------------------------------------------- #
# 工具
# --------------------------------------------------------------------------- #
def log(msg):
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        if os.path.exists(LOG_PATH) and os.path.getsize(LOG_PATH) > 512 * 1024:
            with open(LOG_PATH, "rb") as f:
                tail = f.read()[-128 * 1024:]
            with open(LOG_PATH, "wb") as f:
                f.write(tail)
        stamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(f"[{stamp}] {msg}\n")
    except Exception:  # noqa: BLE001
        pass


def now_stamp():
    return datetime.datetime.now().strftime("%Y%m%d-%H%M%S")


def read_text(path):
    with open(path, "rb") as f:
        raw = f.read()
    for enc in ("utf-8", "utf-8-sig", "gb18030", "latin-1"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", "replace")


def write_text(path, text):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = path + ".htmlstudio.tmp"
    with open(tmp, "wb") as f:
        f.write(text.encode("utf-8"))
    os.replace(tmp, path)


def safe_target(path, must_exist=None):
    """只允许操作用户主目录下的 html 文件，且不碰任何隐藏目录/文件。"""
    if not isinstance(path, str) or not path.strip():
        raise ValueError("路径为空")
    p = os.path.realpath(os.path.expanduser(path.strip()))
    if not p.lower().endswith(HTML_EXT):
        raise ValueError("只支持 html 文件: " + os.path.basename(p))
    if not (p == HOME or p.startswith(HOME + os.sep)):
        raise ValueError("只允许操作主目录内的文件: " + p)
    rel = os.path.relpath(p, HOME)
    for seg in rel.split(os.sep):
        if seg.startswith("."):
            raise ValueError("不允许操作隐藏目录/文件: " + rel)
    if must_exist is True and not os.path.isfile(p):
        raise ValueError("文件不存在: " + p)
    if must_exist is False and os.path.exists(p):
        raise ValueError("已存在同名文件: " + p)
    return p


def backup_dir_for(real_path):
    rel = os.path.relpath(real_path, HOME)
    return os.path.join(BACKUP_ROOT, rel + ".bak")


def make_backup(real_path):
    if not os.path.isfile(real_path):
        return None
    bdir = backup_dir_for(real_path)
    os.makedirs(bdir, exist_ok=True)
    name = f"{os.path.basename(real_path)}.{now_stamp()}.html"
    i = 1
    while os.path.exists(os.path.join(bdir, name)):
        name = f"{os.path.basename(real_path)}.{now_stamp()}-{i}.html"
        i += 1
    with open(real_path, "rb") as src, open(os.path.join(bdir, name), "wb") as dst:
        dst.write(src.read())
    return name


def list_backups(real_path):
    bdir = backup_dir_for(real_path)
    if not os.path.isdir(bdir):
        return []
    out = []
    for fn in os.listdir(bdir):
        full = os.path.join(bdir, fn)
        if not os.path.isfile(full):
            continue
        st = os.stat(full)
        out.append({
            "name": fn,
            "size": st.st_size,
            "mtime": int(st.st_mtime),
            "when": datetime.datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d %H:%M:%S"),
        })
    out.sort(key=lambda x: -x["mtime"])
    return out


def read_backup(real_path, name):
    if not isinstance(name, str) or "/" in name or "\\" in name or name.startswith("."):
        raise ValueError("非法备份名")
    bdir = os.path.realpath(backup_dir_for(real_path))
    full = os.path.realpath(os.path.join(bdir, name))
    if not full.startswith(bdir + os.sep) or not os.path.isfile(full):
        raise ValueError("备份不存在: " + name)
    return read_text(full)


def diff_stat(old, new):
    added = removed = 0
    for line in difflib.unified_diff(
        (old or "").splitlines(), (new or "").splitlines(), n=0, lineterm=""
    ):
        if line.startswith("+") and not line.startswith("+++"):
            added += 1
        elif line.startswith("-") and not line.startswith("---"):
            removed += 1
    return added, removed


def normalize(html, old):
    """沿用原文件的收尾换行习惯。"""
    if old.endswith("\n") and not html.endswith("\n"):
        return html + "\n"
    return html


# --------------------------------------------------------------------------- #
# 业务
# --------------------------------------------------------------------------- #
def op_ping(req):
    return {
        "ok": True,
        "version": VERSION,
        "home": HOME,
        "backupRoot": BACKUP_ROOT,
    }


def op_save(req, must_exist=True):
    real = safe_target(req.get("path"), must_exist=must_exist)
    html = req.get("html")
    if not isinstance(html, str):
        raise ValueError("缺少 html 内容")
    if not html.strip():
        raise ValueError("拒绝保存空内容（保护原文件）")

    old = read_text(real) if os.path.exists(real) else ""
    body = normalize(html, old) if old else html
    backup = make_backup(real)
    write_text(real, body)
    added, removed = diff_stat(old, body)
    return {
        "ok": True,
        "path": real,
        "backup": backup,
        "added": added,
        "removed": removed,
        "bytes": len(body.encode("utf-8")),
        "savedAt": int(datetime.datetime.now().timestamp()),
    }


def op_backups(req):
    real = safe_target(req.get("path"), must_exist=True)
    return {"ok": True, "path": real, "backups": list_backups(real)}


def op_restore(req):
    real = safe_target(req.get("path"), must_exist=True)
    html = read_backup(real, req.get("backup"))
    make_backup(real)  # 恢复前也备份，恢复可再撤销
    write_text(real, html)
    return {"ok": True, "path": real, "restored": req.get("backup")}


def op_undo_last(req):
    real = safe_target(req.get("path"), must_exist=True)
    backups = list_backups(real)
    if not backups:
        raise ValueError("没有可撤销的备份")
    html = read_backup(real, backups[0]["name"])
    make_backup(real)
    write_text(real, html)
    return {"ok": True, "path": real, "restored": backups[0]["name"]}


def op_upload(req):
    real = safe_target(req.get("path"), must_exist=True)
    dataurl = req.get("dataUrl") or ""
    m = re.match(r"^data:(image/[a-zA-Z0-9.+-]+);base64,(.+)$", dataurl, re.S)
    if not m:
        raise ValueError("只支持图片 dataUrl")
    mime, b64 = m.group(1), m.group(2)
    ext = {
        "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif",
        "image/webp": ".webp", "image/svg+xml": ".svg", "image/bmp": ".bmp",
        "image/avif": ".avif",
    }.get(mime, ".png")
    raw = base64.b64decode(b64)
    if len(raw) > 20 * 1024 * 1024:
        raise ValueError("图片超过 20MB")
    adir = os.path.join(os.path.dirname(real), "assets")
    os.makedirs(adir, exist_ok=True)
    digest = hashlib.sha1(raw).hexdigest()[:12]
    name = f"img-{now_stamp()}-{digest}{ext}"
    with open(os.path.join(adir, name), "wb") as f:
        f.write(raw)
    return {"ok": True, "src": "assets/" + name, "bytes": len(raw)}


def op_info(req):
    path = req.get("path")
    try:
        real = safe_target(path)
        exists = os.path.isfile(real)
        st = os.stat(real) if exists else None
        return {
            "ok": True,
            "path": real,
            "exists": exists,
            "size": st.st_size if st else 0,
            "backups": len(list_backups(real)) if exists else 0,
        }
    except Exception as e:  # noqa: BLE001
        return {"ok": True, "path": path, "exists": False, "error": str(e), "backups": 0}


OPS = {
    "ping": op_ping,
    "info": op_info,
    "save": lambda r: op_save(r, must_exist=True),
    "save-as": lambda r: op_save(r, must_exist=False),
    "backups": op_backups,
    "restore": op_restore,
    "undo-last": op_undo_last,
    "upload": op_upload,
}


def dispatch(req):
    if not isinstance(req, dict):
        return {"ok": False, "error": "请求必须是 JSON 对象"}
    op = req.get("op")
    fn = OPS.get(op)
    if not fn:
        return {"ok": False, "error": f"未知操作: {op}"}
    return fn(req)


# --------------------------------------------------------------------------- #
# native messaging I/O
# --------------------------------------------------------------------------- #
def read_message():
    raw_len = sys.stdin.buffer.read(4)
    if len(raw_len) < 4:
        return None
    n = int.from_bytes(raw_len, "little")
    if n <= 0 or n > MAX_INCOMING:
        raise ValueError(f"消息长度异常: {n}")
    data = sys.stdin.buffer.read(n)
    if len(data) < n:
        raise ValueError("消息被截断")
    return json.loads(data.decode("utf-8"))


def write_message(obj):
    data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(len(data).to_bytes(4, "little"))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def main():
    try:
        req = read_message()
    except Exception as e:  # noqa: BLE001
        write_message({"ok": False, "error": f"解析请求失败: {e}"})
        return
    if req is None:
        return
    try:
        resp = dispatch(req)
    except Exception as e:  # noqa: BLE001
        log(f"op={req.get('op')} path={req.get('path')} ERROR {e}\n{traceback.format_exc()}")
        resp = {"ok": False, "error": str(e)}
    try:
        write_message(resp)
    except Exception as e:  # noqa: BLE001
        log(f"写响应失败: {e}")


if __name__ == "__main__":
    main()
