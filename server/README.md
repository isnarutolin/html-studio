# server/ — 常驻服务层（可选）

编辑器本体和批注引擎都不需要这一层。**只有当你想把「改 + 批注」做成一个长期在线的入口**、发给同事打开就能用，才需要它。

这一层做三件事：

| 组件 | 端口 | 作用 |
| --- | --- | --- |
| `review-server.mjs` | 8899 | 静态服务 + 批注注入 + 实时同步（SSE）+ **`/p/<url>` 链接转换网关** |
| `server.py`（仓库根） | 7788 | 网页版一站式：改（服务端写盘 + diff + 备份）与批注同时在手 |
| `bore-tunnel.sh` | — | 给上面两个各挂一条公网隧道，带看门狗 |

配套脚本：

| 脚本 | 用途 |
| --- | --- |
| `install.sh` | 部署脚本、生成 launchd plist、加载/重启、`--check` 查漂移 |
| `share-link.sh [docId]` | 一眼看全：公网/局域网链接、防休眠状态、服务与数据 |
| `anno-url.sh <HTML链接>` | 把任意 HTML 链接拼成「可批注地址」，并体检一次 |

## 一键部署

```bash
cd server
./install.sh                          # 只部署脚本到 ~/html-annotator-kit
./install.sh --plists --load           # 再生成开机自启并重启（macOS launchd）
./install.sh --check                   # 仓库版本和已部署目录是否一致（漂移退出码 1）
```

常用参数：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--to DIR` | `~/html-annotator-kit` | 脚本部署目录（日志、批注数据都在这里） |
| `--root DIR` | `~/Desktop/reports` | 8899 对外提供的 HTML 目录 |
| `--home DIR` | `~` | 7788 网页版能看到/改到的范围，**别用 `~` 开公网**（见安全） |
| `--label-prefix` | `com.naruto` | launchd 服务名前缀 |
| `--uninstall` | — | 卸载 plist，保留数据 |

依赖：`node`（8899）、`python3`（7788，纯标准库）、`bore`（```brew install bore-cli```，只给公网隧道用）。

## 批注数据放在哪

默认 `<部署目录>/data/`，两个入口**共用同一份 JSON**：

```
data/heping-hotel-diagnosis.json    # 一份稿子一个文件
data/identity.json                  # 浏览器身份令牌 → 署名（防冒名删别人的批注）
data/_paths.json                    # 7788 用：docId → 文件路径的归属表（同名不同目录时用）
```

`server.py` 通过 `--anno-data <该目录>` 指过来，`install.sh` 生成 plist 时已经带上了。
两个服务都会按文件 mtime 失效缓存，所以同时跑也不会互相覆盖。

## `/p/<url>`：把别人的链接变成可批注版

```bash
http://<host>:8899/p/https://file.example.com/files/6/xxx/abc.html
```

服务端抓取原页 → 放宽 CSP → 补 `<base>` → 注入引擎 → 同源返回，所以批注走本站 API，多人实时同步照常。

```bash
# 下载成单文件（引擎内联，离线也能批注，也能用扩展直接改）
http://<host>:8899/p/<百分号编码的URL>?download=1
# 给脚本用
http://<host>:8899/api/convert?url=<URL>
```

安全默认值：**禁止抓内网/回环地址**（127/10/172.16-31/192.168/169.254/`.local` 等），确需抓内网稿子再 `PROXY_ALLOW_PRIVATE=1`。

## 安全边界（认真读）

这一层把「读」和「写」都暴露在网络上了：

| 风险 | 说明 | 缓解 |
| --- | --- | --- |
| **7788 能改你的文件** | `--dir` 之下的任何 HTML 都能被改（服务端写盘） | 别用 `--home ~`；专建目录；别直接开到公网 |
| **8899 能抓任意网页** | `/p/` 是个抓取代理 | 已默认禁内网；要暴露就加口令 |
| **两者都可能裸奔** | 不带口令时，拿到地址的人都能读写 | 8899 支持 `access-code.txt`（内容即口令，HTTP Basic，用户名 `review`）；7788 目前建议只在内网用 |

README 里的定位是**可信内网工具**，不是公网服务。要真上公网，至少加口令 + 固定域名 + HTTPS。

## 公网隧道的两个已知特性

1. **端口会漂**：`bore.pub` 是免费公共服务，固定端口被占时脚本会退到下一个候选（8899 用 44589-44593，7788 用 44596-44599）。所以链接**可能变**，`share-link.sh` 每次都会打印当前实际地址。
2. **带宽有限**：约 12KB/s。内联了 echarts 的稿子 1.1MB，gzip 后 ~360KB，首次打开 ~25 秒，之后靠 ETag 304 秒开。

想要固定地址，就把 bore 换成 Cloudflare Tunnel 或自建 bore server —— 脚本只要改 `LOCAL_PORT` / `BORE_PORTS` 那几处即可。

## 合盖休眠会断

这套服务跑在笔记本上时，**合盖/休眠 = 所有链接失效**（开盖后 launchd 自动恢复，链接通常不变）。

需要临时保持在线：

```bash
caffeinate -d -m -s &      # 用完 kill 掉
```

想彻底避免，就把 8899/7788 部署到一台常开的机器上 —— 这些脚本只依赖 node / python3 / bash，`scp` 过去就能跑。
