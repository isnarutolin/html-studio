---
name: html-annotate
description: 给任意 HTML 加「划词批注」能力。生成/收到 HTML 报告、看板、诊断页后调用本 skill，产出可批注版（单机 localStorage 或多人实时同步）。纯 Python 标准库，零依赖，无需装浏览器扩展。
argument-hint: <html文件或URL> [-o 输出] [--remote http://host:8899]
---

# HTML 批注

把一份普通 HTML 变成「能划词、能评论、能回复、能标记已解决」的可批注稿。
**不需要浏览器扩展、不需要 node、不需要 pip install** —— 引擎是单文件 JS，服务端只用 Python 标准库。

## 什么时候用

- 用户拿到/生成了 HTML 报告、诊断页、看板、PPT 式长图，想让人在页面上直接评论
- 需要多人同时在同一份稿子上看到彼此的批注
- 需要把批注导出成 JSON 或带批注的独立 HTML 发给别人

## 两条路径，先判断用哪条

| 场景 | 命令 | 批注存哪 |
| --- | --- | --- |
| 一个人看、自己批注、发给别人带着批注 | `annotate.py` | 浏览器 localStorage（离线可用） |
| 多人实时看到彼此的批注 | `serve.py` | 服务端 `data/<docId>.json` |

> 只是自己批注再发出去 → 第一条。要"你批一句我马上看到" → 第二条。

## 用法 1：单机可批注文件

```bash
python3 scripts/annotate.py report.html            # → report.annotated.html
python3 scripts/annotate.py report.html -o out.html
python3 scripts/annotate.py https://x.com/a.html -o a.html   # 直接吃网址
```

产物是一个**自包含单文件**：引擎已内联，双击就能用，离线也能批注。
发微信/邮件/飞书都行，对方打开就能评。但**批注各存各的浏览器**，互相看不到（要同步走用法 2）。

常用选项：

| 选项 | 作用 |
| --- | --- |
| `--doc-id <id>` | 批注归档 ID。默认取文件名；**重跑会自动沿用原值**，不会丢历史批注 |
| `--author <名字>` | 默认批注者昵称（仅在浏览器里还没有署名时写入，不覆盖用户自己改过的名字） |
| `--remote <url>` | 让页面连到远端 `serve.py`（跨域可用，服务已带 CORS `*`） |
| `--no-csp` | 不改写 CSP（严格 CSP 下引擎会被静默拦掉，一般不要用） |
| `-f` | 覆盖已存在的输出 |

## 用法 2：多人实时

```bash
python3 scripts/serve.py --dir ./reports --port 8899
# → http://127.0.0.1:8899/<文件名>   局域网同事用 http://<你的IP>:8899/<文件名>
```

服务做三件事：静态服务目录里的 HTML、开页时**自动注入**批注引擎、提供 `/api/state` `/api/stream`(SSE) `/api/op` 同步批注。
把 HTML 丢进 `--dir` 就自动可批注，**不用重启**。

常用选项：

| 选项 | 作用 |
| --- | --- |
| `--passcode <口令>` | 开 HTTP Basic 认证（用户名 `review`），防止链接裸奔 |
| `--data <目录>` | 批注 JSON 存放位置，默认 `skills/html-annotate/data` |
| `--no-inject` | 不自动注入（文件已用 `annotate.py` 处理过时） |
| `--quiet` | 不打访问日志 |

权限：**只有作者本人能标记已解决 / 删除自己的批注**，按钮在 UI 禁用，服务端也校验（伪造请求返回 403）。
数据落一个文档一个 JSON，可直接备份 / 进 Git。

## 报错与规避

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 页面能开但**没有批注按钮** | 原稿 CSP 的 `script-src` 带 nonce / `connect-src 'none'` 把引擎拦了 | 别加 `--no-csp`，重跑 `annotate.py`；检查 `<meta http-equiv="Content-Security-Policy">` 是否已被改写 |
| 批注按钮在但**多人不同步** | 没连上后端 | 同源：确认走的是 `serve.py` 的地址；跨域：`--remote http://host:8899` |
| 页面结构错乱 / 图表没了 | 原稿依赖的外部脚本被 CSP 或网络挡了 | 先 `annotate.py` 放宽 CSP 再看；外部 CDN 需联网 |
| `</body>` 不唯一 | 注入点有歧义 | 脚本会警告；产物仍生成，但需人工确认注入位置 |
| 重新注入后**老批注不见了** | docId 变了 | 别手动改 `--doc-id`；脚本默认沿用页面里已声明的 docId |

## 边界（做不到的事）

- **不能改内容**，只加批注层（高亮 + 侧栏）。要改文字/排版是另一个功能（编辑器），不在本 skill
- 批注靠 DOM 文本匹配定位，**原稿改版后老批注会失配**（会退化成按文本兜底定位）
- 跨域 iframe 里的内容抓不到
- `blob:` 图片无法随"导出带批注 HTML"一起保存

## 安装（别人怎么用）

本目录就是一个标准 Agent Skill：把它放进你的 skills 目录即可，**无需 npm / pip**：

```bash
# 方式一：只取 skill（推荐）
git clone --depth 1 https://github.com/isnarutolin/html-studio.git /tmp/hs \
  && cp -r /tmp/hs/skills/html-annotate ~/.agents/skills/    # Claude Code 用 ~/.claude/skills/

# 方式二：已 clone 整个仓库，直接软链
ln -s "$PWD/skills/html-annotate" ~/.agents/skills/html-annotate
```

装完 `bash ~/.agents/skills/html-annotate/tests/smoke.sh` 应 15 项全通过。

## 文件构成

```
skills/html-annotate/
├── SKILL.md              # 本文件
├── lib/annotator.js      # 批注引擎（单文件）
├── scripts/annotate.py   # 单机注入（纯标准库）
├── scripts/serve.py      # 多人实时服务（纯标准库）
└── tests/                # smoke.sh + fixture.html
```

> `lib/annotator.js` 的**生产真源在 `html-annotator-kit/annotator.js`**（也就是起 8899 的那套）。
> `extension/lib/annotator.js` 只是多了一段 `__ANNO_DISABLE_AUTOINIT__ = true`（扩展要按需初始化）。
> 改引擎时只改 kit 那份，然后同步到这里和 `extension/lib/`，否则三份会分叉。

引擎的 API（给需要程序化控制的人）：

```js
HtmlAnnotator.init({ docId, author: {name}, remote: 'http://host:8899' })
HtmlAnnotator.connect(base)      // 后接后端
HtmlAnnotator.add({...})         // 程序化加批注
HtmlAnnotator.isLive()           // 是否已连上实时
```
