#!/usr/bin/env python3
"""
把 HTML Studio 网页版做成 macOS 常驻服务（launchd LaunchAgent）：
开机/登录自动启动，崩溃自动拉起，固定地址 http://127.0.0.1:7788

    python3 service.py install     # 安装并启动（默认）
    python3 service.py status      # 看状态
    python3 service.py restart     # 重启
    python3 service.py stop        # 停止（不删除配置）
    python3 service.py start       # 启动
    python3 service.py uninstall   # 卸载
    python3 service.py logs        # 跟踪日志
"""

import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

LABEL = "com.naruto.html-studio"
HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(HERE, "server.py")
PLIST = os.path.expanduser(f"~/Library/LaunchAgents/{LABEL}.plist")
LOG_DIR = os.path.expanduser("~/Library/Logs")
OUT_LOG = os.path.join(LOG_DIR, "html-studio.out.log")
ERR_LOG = os.path.join(LOG_DIR, "html-studio.err.log")
PORT = int(os.environ.get("HTML_STUDIO_PORT", "7788"))
ROOT = os.environ.get("HTML_STUDIO_DIR", os.path.expanduser("~"))
URL = f"http://127.0.0.1:{PORT}"

UID = os.getuid()
DOMAIN = f"gui/{UID}"


# --------------------------------------------------------------------------- #
def find_python():
    """挑一个稳定的 python3 解释器：优先 /usr/local/bin/python3，回退当前解释器。"""
    for cand in ("/usr/local/bin/python3", "/opt/homebrew/bin/python3", sys.executable):
        if cand and os.path.isfile(cand) and os.access(cand, os.X_OK):
            try:
                v = subprocess.run([cand, "-V"], capture_output=True, text=True, timeout=5)
                if v.returncode == 0:
                    return cand
            except Exception:  # noqa: BLE001
                continue
    sys.exit("找不到可用的 python3")


def plist_xml(py):
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{py}</string>
    <string>{SERVER}</string>
    <string>--port</string>
    <string>{PORT}</string>
    <string>--dir</string>
    <string>{ROOT}</string>
    <string>--no-browser</string>
  </array>
  <key>WorkingDirectory</key>
  <string>{HERE}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PYTHONUNBUFFERED</key>
    <string>1</string>
  </dict>
  <key>StandardOutPath</key>
  <string>{OUT_LOG}</string>
  <key>StandardErrorPath</key>
  <string>{ERR_LOG}</string>
</dict>
</plist>
"""


def sh(*args, check=False):
    return subprocess.run(list(args), capture_output=True, text=True, check=check)


def running_pid():
    r = sh("launchctl", "list")
    for line in r.stdout.splitlines():
        parts = line.split("\t")
        if len(parts) >= 3 and parts[2] == LABEL:
            pid = parts[0].strip()
            return int(pid) if pid.isdigit() else None
    return None


def port_owner():
    r = sh("lsof", "-nP", f"-iTCP:{PORT}", "-sTCP:LISTEN")
    lines = [l for l in r.stdout.splitlines()[1:] if l.strip()]
    return lines[0] if lines else None


def http_ok(timeout=2):
    try:
        req = urllib.request.Request(URL + "/api/state", headers={"Origin": URL})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = json.loads(r.read().decode())
        return data.get("ok") is True, data
    except Exception as e:  # noqa: BLE001
        return False, str(e)


def wait_ready(seconds=12):
    end = time.time() + seconds
    while time.time() < end:
        ok, info = http_ok(1.5)
        if ok:
            return info
        time.sleep(0.5)
    return None


# --------------------------------------------------------------------------- #
def do_install():
    py = find_python()
    os.makedirs(os.path.dirname(PLIST), exist_ok=True)
    os.makedirs(LOG_DIR, exist_ok=True)

    owner = port_owner()
    if owner and running_pid() is None:
        print(f"⚠️  端口 {PORT} 已被别的进程占用，先让出端口再安装：")
        print("   " + owner)
        print(f"   临时办法:  pkill -f 'server.py.*--port {PORT}'")
        return 1

    with open(PLIST, "w", encoding="utf-8") as f:
        f.write(plist_xml(py))

    sh("launchctl", "bootout", f"{DOMAIN}/{LABEL}")  # 已存在就先卸掉
    r = sh("launchctl", "bootstrap", DOMAIN, PLIST)
    if r.returncode != 0 and "already bootstrapped" not in (r.stderr or ""):
        print("bootstrap 失败:", r.stderr.strip() or r.stdout.strip())
        return 1
    sh("launchctl", "enable", f"{DOMAIN}/{LABEL}")

    info = wait_ready()
    print("=" * 60)
    if info:
        print(f"✅ 已启动：{URL}")
        print(f"   工作目录 : {info.get('root')}")
        print(f"   扫到文件 : {len(info.get('files', []))} 个 HTML")
        print(f"   Python   : {py}")
        print(f"   配置     : {PLIST}")
        print(f"   日志     : {OUT_LOG}")
        print("")
        print("   以后开机/登录会自动起来，崩溃launchd自动重启。")
        print(f"   直接在浏览器打开（或存成书签）：{URL}")
    else:
        print("⚠️  服务已注册，但端口还没响应，看一下日志：")
        print(f"   tail -20 {ERR_LOG}")
        return 1
    print("=" * 60)
    return 0


def do_uninstall():
    sh("launchctl", "bootout", f"{DOMAIN}/{LABEL}")
    if os.path.exists(PLIST):
        os.remove(PLIST)
        print(f"🗑  已删除 {PLIST}")
    print("已卸载。html 文件没有被改动，备份仍在 ~/.html-studio/ 和 .edits/ 里。")
    return 0


def do_start():
    if running_pid():
        print("已经在运行了")
        return do_status()
    if not os.path.exists(PLIST):
        return do_install()
    sh("launchctl", "bootstrap", DOMAIN, PLIST)
    sh("launchctl", "kickstart", f"{DOMAIN}/{LABEL}")
    if wait_ready():
        print(f"✅ 已启动 {URL}")
        return 0
    print("⚠️ 启动后端口无响应，看日志：", ERR_LOG)
    return 1


def do_stop():
    r = sh("launchctl", "bootout", f"{DOMAIN}/{LABEL}")
    if r.returncode == 0:
        print("⏹  已停止（下次登录还会自动起来；想彻底关掉用 uninstall）")
    else:
        print("没在运行，或停止失败：", (r.stderr or "").strip())
    return 0


def do_restart():
    sh("launchctl", "kickstart", "-k", f"{DOMAIN}/{LABEL}")
    if wait_ready():
        print(f"🔄 已重启 {URL}")
        return 0
    print("⚠️ 重启后端口无响应，看日志：", ERR_LOG)
    return 1


def do_status():
    pid = running_pid()
    ok, info = http_ok()
    owner = port_owner()
    print(f"地址      : {URL}")
    print(f"响应      : {'✅ 正常' if ok else '❌ 无响应'}")
    if ok:
        print(f"工作目录  : {info.get('root')}")
        print(f"HTML 文件 : {len(info.get('files', []))} 个")
    print(f"LaunchAgent: {'✅ 已安装' if os.path.exists(PLIST) else '❌ 未安装'}"
          + (f" · 进程 {pid}" if pid else " · 未运行"))
    if owner:
        print(f"端口占用  : {owner}")
    if not ok and os.path.exists(ERR_LOG):
        tail = sh("tail", "-5", ERR_LOG).stdout.strip()
        if tail:
            print("最近日志  :\n" + tail)
    return 0 if ok else 1


def do_logs():
    if not os.path.exists(OUT_LOG):
        print("还没有日志")
        return 0
    os.execvp("tail", ["tail", "-f", "-n", "40", OUT_LOG, ERR_LOG])


COMMANDS = {
    "install": do_install,
    "uninstall": do_uninstall,
    "start": do_start,
    "stop": do_stop,
    "restart": do_restart,
    "status": do_status,
    "logs": do_logs,
}


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "install"
    if sys.platform != "darwin" and cmd != "status":
        print("这个脚本用 launchd 做常驻，只支持 macOS。")
        print("")
        print("其它平台想常驻，可以：")
        print("  Linux   : 写一个 systemd user unit，例如 ~/.config/systemd/user/html-studio.service")
        print("            [Service]")
        print(f"            ExecStart={sys.executable} {SERVER} --port {PORT} --no-browser")
        print("            Restart=always")
        print("            然后: systemctl --user enable --now html-studio")
        print("  Windows : 直接用任务计划程序，或前台跑 python server.py")
        print("")
        print("只是想现在用一下：python3 server.py --no-browser")
        sys.exit(0)
    fn = COMMANDS.get(cmd)
    if not fn:
        print(__doc__)
        sys.exit(2)
    sys.exit(fn())
