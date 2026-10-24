#!/bin/bash
# 双击即可启动 HTML Studio（macOS）
cd "$(dirname "$0")" || exit 1
PORT=${PORT:-7788}
DIR=${DIR:-$HOME}
exec python3 server.py --port "$PORT" --dir "$DIR"
