#!/usr/bin/env python3
"""
注册 / 卸载 HTML Studio 的 native messaging host。

    python3 install.py                  # 安装（自动找已装的 Chromium 系浏览器）
    python3 install.py --check          # 体检：注册状态 + 扩展目录 + 活体 ping
    python3 install.py --uninstall      # 卸载
    python3 install.py --ext-id <id>    # 从 Chrome 应用商店安装时，用商店分配的 ID 注册
    python3 install.py --rename-host <name>   # 改 native host 名字（反域名，如 com.example.htmlstudio）

支持 macOS / Linux；Windows 走注册表（实验性，见 README）。
"""

import argparse
import base64
import hashlib
import json
import os
import re
import shutil
import stat
import struct
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
STATE_DIR = os.path.join(os.path.expanduser("~"), ".html-studio")
HOST_SCRIPT = os.path.join(HERE, "native_host.py")
MANIFEST = os.path.join(HERE, "manifest.json")

# 唯一的 host 名字来源。改名请用 `--rename-host`，它会同步改写 JS 里的副本。
HOST_NAME = "com.narutolin.htmlstudio"

# 需要在改 host 名字时一起改的文件
HOST_NAME_FILES = ["content.js", "background.js", "help.js"]


# --------------------------------------------------------------------------- #
# 浏览器位置
# --------------------------------------------------------------------------- #
def browser_roots():
    """返回 [(显示名, 配置根目录)]，只保留真实存在的。"""
    home = os.path.expanduser("~")
    if sys.platform == "darwin":
        base = os.path.join(home, "Library", "Application Support")
        cands = [
            ("Google Chrome", "Google/Chrome"),
            ("Chrome Canary", "Google/Chrome Canary"),
            ("Chromium", "Chromium"),
            ("Brave", "BraveSoftware/Brave-Browser"),
            ("Microsoft Edge", "Microsoft Edge"),
            ("Vivaldi", "Vivaldi"),
        ]
    elif sys.platform.startswith("linux"):
        base = os.path.join(home, ".config")
        cands = [
            ("Google Chrome", "google-chrome"),
            ("Chrome Beta", "google-chrome-beta"),
            ("Chromium", "chromium"),
            ("Brave", "BraveSoftware/Brave-Browser"),
            ("Microsoft Edge", "microsoft-edge"),
            ("Vivaldi", "vivaldi"),
        ]
    elif sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA", os.path.join(home, "AppData", "Local"))
        cands = [
            ("Google Chrome", "Google/Chrome/User Data"),
            ("Chromium", "Chromium/User Data"),
            ("Brave", "BraveSoftware/Brave-Browser/User Data"),
            ("Microsoft Edge", "Microsoft/Edge/User Data"),
        ]
    else:
        base, cands = "", []
    out = []
    for name, rel in cands:
        root = os.path.join(base, rel) if base else ""
        if root and os.path.isdir(root):
            out.append((name, root))
    return out


def host_manifest_dir(browser_root):
    """macOS / Linux: <配置根>/NativeMessagingHosts。Windows 不用目录，走注册表。"""
    return os.path.join(browser_root, "NativeMessagingHosts")


def host_manifest_path(browser_root):
    return os.path.join(host_manifest_dir(browser_root), HOST_NAME + ".json")


def host_manifest_path_current():
    """Windows 下 host manifest 放在自己目录里，靠注册表指过去。"""
    if sys.platform == "win32":
        return os.path.join(STATE_DIR, HOST_NAME + ".json")
    return None


# --------------------------------------------------------------------------- #
# 扩展 ID
# --------------------------------------------------------------------------- #
def extension_id_from_manifest():
    with open(MANIFEST, encoding="utf-8") as f:
        key = json.load(f).get("key")
    if not key:
        return None
    der = base64.b64decode(key)
    h = hashlib.sha256(der).hexdigest()[:32]
    return "".join(chr(ord("a") + int(c, 16)) for c in h)


# --------------------------------------------------------------------------- #
# 自检：Chrome 对扩展目录有不少隐性要求
# --------------------------------------------------------------------------- #
RESERVED_PREFIXES = ("_", ".")


def clean_pycache():
    """扩展目录里绝不能留 __pycache__。

    Chrome 把 '_' 开头的名字当系统保留名，一个 __pycache__ 就能让整个扩展加载失败。
    它通常是被"导入 native_host.py"或 py_compile 误创建的，删掉无任何损失，直接自动清。
    """
    removed = []
    for root, dirs, _files in os.walk(HERE):
        for d in list(dirs):
            if d == "__pycache__":
                full = os.path.join(root, d)
                shutil.rmtree(full, ignore_errors=True)
                dirs.remove(d)
                removed.append(os.path.relpath(full, HERE))
    return removed


def validate_extension():
    problems = []
    clean_pycache()
    try:
        with open(MANIFEST, encoding="utf-8") as f:
            m = json.load(f)
    except FileNotFoundError:
        return ["manifest.json 不存在"]
    except json.JSONDecodeError as e:
        return [f"manifest.json 不是合法 JSON: {e}"]

    for name in sorted(os.listdir(HERE)):
        if name.startswith(RESERVED_PREFIXES):
            problems.append(f"文件名以 '_' 或 '.' 开头: {name}"
                            "（Chrome 保留名，会导致整个扩展加载失败）")

    refs = []
    if isinstance(m.get("background"), dict):
        refs.append(m["background"].get("service_worker"))
    for cs in m.get("content_scripts", []):
        refs += cs.get("js", []) + cs.get("css", [])
    refs += list((m.get("icons") or {}).values())
    refs += list((m.get("action", {}).get("default_icon") or {}).values())
    for r in [x for x in refs if x]:
        if not os.path.isfile(os.path.join(HERE, r)):
            problems.append(f"manifest 引用了不存在的文件: {r}")

    if not m.get("key"):
        problems.append("manifest 缺少 key（扩展 ID 会随机，native host 将无法校验）")
    return problems


# --------------------------------------------------------------------------- #
# 启动器 / 注册
# --------------------------------------------------------------------------- #
def find_python():
    for cand in ("/usr/local/bin/python3", "/opt/homebrew/bin/python3",
                 "/usr/bin/python3", sys.executable):
        if cand and os.path.isfile(cand) and os.access(cand, os.X_OK):
            try:
                if subprocess.run([cand, "-V"], capture_output=True, timeout=5).returncode == 0:
                    return cand
            except Exception:  # noqa: BLE001
                continue
    return sys.executable


def write_launcher():
    os.makedirs(STATE_DIR, exist_ok=True)
    py = find_python()
    if sys.platform == "win32":
        path = os.path.join(STATE_DIR, "run_host.cmd")
        with open(path, "w", encoding="utf-8", newline="\r\n") as f:
            f.write(f'@echo off\r\n"{py}" "{HOST_SCRIPT}" %*\r\n')
        return path, py

    path = os.path.join(STATE_DIR, "run_host.sh")
    with open(path, "w", encoding="utf-8") as f:
        f.write("#!/bin/bash\n"
                "# HTML Studio native messaging host 启动器（由 install.py 生成）\n"
                f'exec "{py}" "{HOST_SCRIPT}" "$@"\n')
    os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return path, py


def register_windows(manifest_path, ext_id):
    """Windows 用注册表登记 host manifest。"""
    try:
        import winreg  # noqa: PLC0415
    except ImportError:
        return ["当前 Python 没有 winreg，无法在 Windows 上注册"]
    errors = []
    for hive, label in ((winreg.HKEY_CURRENT_USER, "HKCU"),):
        for key_path in (
            rf"Software\Google\Chrome\NativeMessagingHosts\{HOST_NAME}",
            rf"Software\Chromium\NativeMessagingHosts\{HOST_NAME}",
            rf"Software\Microsoft\Edge\NativeMessagingHosts\{HOST_NAME}",
        ):
            try:
                with winreg.CreateKey(hive, key_path) as k:
                    winreg.SetValueEx(k, "", 0, winreg.REG_SZ, manifest_path)
            except OSError as e:
                errors.append(f"{label}\\{key_path}: {e}")
    return errors


def unregister_windows():
    try:
        import winreg  # noqa: PLC0415
    except ImportError:
        return
    for key_path in (
        rf"Software\Google\Chrome\NativeMessagingHosts\{HOST_NAME}",
        rf"Software\Chromium\NativeMessagingHosts\{HOST_NAME}",
        rf"Software\Microsoft\Edge\NativeMessagingHosts\{HOST_NAME}",
    ):
        try:
            winreg.DeleteKey(winreg.HKEY_CURRENT_USER, key_path)
        except OSError:
            pass


# --------------------------------------------------------------------------- #
# 命令
# --------------------------------------------------------------------------- #
def cmd_install(args):
    ext_id = args.ext_id or extension_id_from_manifest()
    if not ext_id:
        sys.exit("manifest.json 里没有 key，无法确定扩展 ID；可用 --ext-id 手动指定")

    problems = validate_extension()
    if problems:
        print("⚠️  扩展目录体检有问题，浏览器里加载会失败：")
        for p in problems:
            print("   - " + p)
        print("")

    launcher, py = write_launcher()
    manifest = {
        "name": HOST_NAME,
        "description": "HTML Studio 本地文件读写 host",
        "path": launcher,
        "type": "stdio",
        "allowed_origins": [f"chrome-extension://{ext_id}/"],
    }

    print("=" * 68)
    print("HTML Studio — native host 注册")
    print("=" * 68)
    print(f"平台        : {sys.platform}")
    print(f"扩展 ID     : {ext_id}" + ("  (手动指定)" if args.ext_id else ""))
    print(f"Python      : {py}")
    print(f"Host 脚本   : {HOST_SCRIPT}")
    print(f"启动器      : {launcher}")
    print("")

    if sys.platform == "win32":
        mpath = host_manifest_path_current()
        os.makedirs(os.path.dirname(mpath), exist_ok=True)
        with open(mpath, "w", encoding="utf-8") as f:
            json.dump(manifest, f, indent=2, ensure_ascii=False)
        errs = register_windows(mpath, ext_id)
        if errs:
            print("❌ 注册表写入失败：")
            for e in errs:
                print("   " + e)
        else:
            print(f"✅ 已写入注册表，manifest: {mpath}")
    else:
        browsers = browser_roots()
        if not browsers:
            print("⚠️  没找到已安装的 Chromium 系浏览器。")
            browsers = [("Google Chrome",
                         os.path.expanduser("~/Library/Application Support/Google/Chrome")
                         if sys.platform == "darwin"
                         else os.path.expanduser("~/.config/google-chrome"))]
        for name, root in browsers:
            target = host_manifest_path(root)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with open(target, "w", encoding="utf-8") as f:
                json.dump(manifest, f, indent=2, ensure_ascii=False)
            print(f"✅ {name}\n   → {target}")

    print("")
    print("-" * 68)
    print("浏览器里还要做两件事：")
    print("")
    print("1. 打开 chrome://extensions → 开启「开发者模式」")
    print("   → 「加载已解压的扩展程序」→ 选择：")
    print(f"   {HERE}")
    if not args.ext_id:
        print(f"   （ID 应为 {ext_id}，一致说明 manifest 的 key 生效了）")
    print("")
    print("2. 扩展卡片 →「详情」→ 打开「允许访问文件网址」")
    print("   ⚠️ 不开这个，本地 html 页面不会有编辑按钮。")
    print("")
    print("3. 完全退出浏览器再重开（native host 注册在启动时读取）。")
    print("")
    print("装好后随便打开一个本地 .html，右下角出现 ✎ 即可编辑。")
    print("-" * 68)
    return 0


def cmd_uninstall(args):
    if sys.platform == "win32":
        unregister_windows()
        p = host_manifest_path_current()
        if p and os.path.exists(p):
            os.remove(p)
            print(f"🗑  {p}")
    else:
        for name, root in browser_roots():
            target = host_manifest_path(root)
            if os.path.exists(target):
                os.remove(target)
                print(f"🗑  {name}: {target}")
    for f in ("run_host.sh", "run_host.cmd"):
        p = os.path.join(STATE_DIR, f)
        if os.path.exists(p):
            os.remove(p)
            print(f"🗑  {p}")
    print("已卸载注册。备份仍在 ~/.html-studio/backups/，html 文件没有改动。")
    return 0


def ping_host(launcher):
    """按 native messaging 协议真跑一次 host，验证端到端可用。"""
    msg = json.dumps({"op": "ping"}).encode()
    try:
        p = subprocess.run([launcher], input=len(msg).to_bytes(4, "little") + msg,
                           capture_output=True, timeout=20)
    except Exception as e:  # noqa: BLE001
        return None, f"启动失败: {e}"
    if len(p.stdout) < 4:
        return None, f"无输出 (exit={p.returncode}) {p.stderr.decode()[:160]}"
    n = int.from_bytes(p.stdout[:4], "little")
    try:
        return json.loads(p.stdout[4:4 + n].decode()), None
    except Exception as e:  # noqa: BLE001
        return None, f"响应解析失败: {e}"


def cmd_check(args):
    ok = True
    print("=" * 60)
    print("HTML Studio 体检")
    print("=" * 60)
    print(f"平台        : {sys.platform}")

    ext_id = extension_id_from_manifest()
    print(f"扩展 ID     : {ext_id or '❌ manifest 缺少 key'}")

    problems = validate_extension()
    if problems:
        ok = False
        print("扩展目录    : ❌")
        for p in problems:
            print("   - " + p)
    else:
        print("扩展目录    : ✅ 无保留文件名，manifest 引用的文件都在")

    print(f"Host 脚本   : {'✅ ' + HOST_SCRIPT if os.path.isfile(HOST_SCRIPT) else '❌ 缺失'}")

    launcher = os.path.join(STATE_DIR, "run_host.sh")
    if sys.platform == "win32":
        launcher = os.path.join(STATE_DIR, "run_host.cmd")
    if os.path.exists(launcher):
        print(f"启动器      : ✅ {launcher}")
        resp, err = ping_host(launcher)
        if err:
            ok = False
            print(f"活体 ping   : ❌ {err}")
        else:
            print(f"活体 ping   : ✅ host 版本 {resp.get('version')}，备份目录 {resp.get('backupRoot')}")
    else:
        ok = False
        print(f"启动器      : ❌ 缺失（{launcher}）→ 先运行 python3 install.py")

    if sys.platform == "win32":
        try:
            import winreg  # noqa: PLC0415
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                                rf"Software\Google\Chrome\NativeMessagingHosts\{HOST_NAME}"):
                print("Chrome 注册 : ✅ 注册表已登记")
        except Exception:  # noqa: BLE001
            ok = False
            print("Chrome 注册 : ❌ 注册表未登记")
    else:
        browsers = browser_roots()
        if not browsers:
            print("浏览器      : ⚠️ 没找到 Chromium 系浏览器")
        for name, root in browsers:
            target = host_manifest_path(root)
            if not os.path.exists(target):
                ok = False
                print(f"{name:16s}: ❌ 未注册")
                continue
            try:
                with open(target, encoding="utf-8") as f:
                    m = json.load(f)
                match = f"chrome-extension://{ext_id}/" in m.get("allowed_origins", [])
                if not match:
                    ok = False
                print(f"{name:16s}: ✅ 已注册" + ("（ID 匹配）" if match else "（⚠️ ID 不匹配，用 --ext-id 修正）"))
            except Exception as e:  # noqa: BLE001
                ok = False
                print(f"{name:16s}: ❌ 注册文件损坏: {e}")

    print("=" * 60)
    print("结论：✅ 全部通过" if ok else "结论：❌ 有项目未通过，见上面标记")
    return 0 if ok else 1


def cmd_rename_host(args):
    new = (args.rename_host or "").strip()
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_.-]*", new):
        sys.exit("host 名字不合法，应为反域名形式，如 com.example.htmlstudio")
    old = HOST_NAME
    if new == old:
        print("名字没变"); return 0
    changed = []
    for fn in HOST_NAME_FILES:
        p = os.path.join(HERE, fn)
        if not os.path.isfile(p):
            continue
        s = open(p, encoding="utf-8").read()
        if old in s:
            open(p, "w", encoding="utf-8").write(s.replace(old, new))
            changed.append(fn)
    me = os.path.abspath(__file__)
    s = open(me, encoding="utf-8").read()
    open(me, "w", encoding="utf-8").write(s.replace(f'HOST_NAME = "{old}"', f'HOST_NAME = "{new}"'))
    print(f"已把 host 名字从 {old} 改为 {new}")
    print("改动的文件:", ", ".join(changed + ["install.py"]))
    print("")
    print("接下来：")
    print("  1. 旧的注册文件需要手动删掉（名字已变，脚本找不到）")
    print("  2. python3 install.py")
    print("  3. chrome://extensions 里点扩展的重新加载")
    return 0


def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("--uninstall", action="store_true")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--ext-id", default=None, help="手动指定扩展 ID（应用商店安装时使用）")
    ap.add_argument("--rename-host", default=None, metavar="NAME",
                    help="改 native host 名字（反域名），会同步改写 JS 里的副本")
    args = ap.parse_args()
    if args.rename_host:
        return cmd_rename_host(args)
    if args.uninstall:
        return cmd_uninstall(args)
    if args.check:
        return cmd_check(args)
    return cmd_install(args)


if __name__ == "__main__":
    sys.exit(main())
