# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.3.1] - 2025

### 修复 / 打通

- **批注数据统一（7788 与 8899 现在看同一批批注）**
  - `server.py` 新增 `--anno-data`：把网页版的批注目录指向批注服务的 `data/`，一份 JSON 两个入口共用
  - docId 统一为「文件名」（`heping-hotel-diagnosis`），不再用全路径；同名不同目录时自动退回路径版，并在 `_paths.json` 里记住归属，避免串批注
  - `Store` 缓存改为**按文件 mtime 失效**（之前只缓内存，两边一起跑会互相覆盖）
  - 8899 侧去掉 `persist` 的 250ms 防抖 —— 否则对方在这 250ms 内读到旧数据，写回时会把刚加的批注**吞掉**（实测重现过）
- **网页版支持 gzip + ETag/304**：内联 echarts 的稿子 1.1MB → 363KB，公网隧道从 60 秒降到 24 秒；重复打开走 304（几百字节）
  - `engine.js` 也 gzip：56KB → 17KB，隧道下 3.9s → 1.6s

### 新增

- **网页版公网隧道**：7788 也挂了一条 bore（独立 launchd + 看门狗，固定端口从 44596 起），异地同事零安装即可“打开链接就能改、能批注”
- `bore-tunnel.sh` 参数化：`LOCAL_PORT` / `BORE_PORTS` / `BORE_PORTFILE` / `BORE_LOG` / `BORE_HEALTH`，一条脚本服务多个端口

## [1.3.0] - 2025

### 新增

- **一站式：网页版现在既能改、也能批注**（`server.py`，7788）。
  同事零安装，打开一个链接就能：改文字/排版（服务端写盘，带 diff + 备份）、划词留意见（实时同步）。
  ```bash
  python3 server.py --dir ~/Desktop/reports --host 0.0.0.0   # 同事用你的局域网 IP 访问
  ```
  - `/files/<path>` 返回 HTML 时自动「放宽 CSP + 挂上批注引擎」；批注 API 在 `/__anno/*`，与编辑器自己的 `/api/*` 不冲突
  - 批注数据复用 `skills/html-annotate/scripts/serve.py` 的 `Store`/`Hub`（同一份实现，不另写第三套），落在 `<dir>/.edits/anno/<docId>.json`
  - 「编辑」与「批注」互斥：进批注自动退编辑，引擎 `setActive(false)` 后所有批注 UI 对编辑不可见
  - **保存时自动剥干净**：注入的 `script[data-hs-anno]`、运行时 UI、高亮包裹（`.anno-hl` 拆分还原）、`anno-hidden` class，并把 CSP `content` 从 `data-hs-csp` 原样还回去 —— 实测「批注后保存」与「纯编辑保存」字节级一致
- 引擎：导入 JSON 用的隐藏 `<input type=file>` 补上 `anno-ui` class，宿主能一键剥干净
- `server.py` 支持 `Transfer-Encoding: chunked` 请求体（之前只有 `Content-Length`，非浏览器客户端会莫名 400）
- `/favicon.ico` 返回 204，不再在控制台刷 404

### 文档## [1.2.1] - 2025

### 新增

- **`skills/html-annotate/`：把批注做成 Agent Skill**（纯 Python 标准库，零依赖）。
  不装扩展、不用 node、不用 pip，clone 完丢进 skills 目录即可：
  ```bash
  python3 skills/html-annotate/scripts/annotate.py report.html   # → report.annotated.html
  python3 skills/html-annotate/scripts/serve.py --dir ./reports  # 多人实时，默认 8899
  ```
  - `annotate.py` 产出**自包含单文件**：引擎内联、CSP 自动放宽、nonce 自动剔除，双击即可批注（离线可用）
  - `annotate.py` 额外修掉两处坑：`--author` 原本静默失效（引擎 init 时 `document.currentScript` 已为 null，读不到 `data-author`，改成预置 localStorage 默认署名）；`file://` 直开时控制台必报 `ERR_FILE_NOT_FOUND`（探 `/api/health`），加了只拦 `file:` 协议 4 个端点的短路
  - `tests/smoke.sh`：15 项自检，不联网、不用浏览器
  - `tests/check-sync.sh`：校验三份 `annotator.js` 是否同源，`--fix` 自动对齐（文件头用内置常量校验，避免「自己跟自己比」查不出问题）

### 修复

- **`<base href>` 会让批注引擎连错后端**：引擎的 `detectAndConnect('')` 用相对地址 `'/api/health'`，一旦页面里有 `<base>`（代理生成的页面、保存的网页必须加）就会被解析到远端域名，跨域被拦 → 实时同步静默失效（只剩本地批注）。
  现在引擎用 `normalizeBase()` 把空 base 钉到 `location.origin`，`file://` 下退回空串保持离线模式。
- **`--author` 静默失效**：引擎 init 时 `document.currentScript` 已为 null，读不到 `data-author`。注入器改为预置 `localStorage` 默认署名（仅在用户还未署名时写入）。
- **`file://` 直开必报 `ERR_FILE_NOT_FOUND`**：引擎会探 `/api/health`。注入器加了只拦 `file:` 协议 4 个端点的 fetch 短路。

### 文档

- README（中/英）把**编辑**与**批注**拆成两条独立的线：开头新增决策表，明确「只想要批注时不要跑 `install.py`、不要加载扩展」
- 标题区分「编辑 · 方式一/二」；批注章节补「装了扩展点 💬」与「没装扩展跑 `annotate.py`」两条路

## [1.2.0] - 2025

### 新增

- **划词批注**（右下角 💬 / `Cmd·Ctrl + Shift + A`）：划选文字 → 写意见 → 侧栏可回复、标记已解决。
  批注不动正文一个字节，退出批注模式后高亮隐起、正文完全不变。批注默认存在浏览器本地，
  侧栏可 ⬇ 导出 JSON / ⬆ 导入合并 / ⤓ 导出「带批注的独立 HTML」。
- **多人共享批注服务 `collab.py`**（零第三方依赖，只用标准库）：
  静态服务一个目录、自动给 HTML 注入批注引擎，提供 `/api/state`、`/api/stream`（SSE）、`/api/op`；
  谁改了批注，其他人不刷新就能看到，侧栏显示「N 人在线」。
  ```bash
  python3 collab.py --dir ~/Desktop/reports [--passcode 口令]
  ```
- **「只能改自己的批注」权限**：非作者的 ✓/✕ 按钮置灰并提示原因；
  服务端另按浏览器身份令牌（cookie）校验，伪造请求也会被 403。
  署名绑定到浏览器，别人把名字改成你的会被 409 拒掉。
- **可选的访问口令**：`--passcode` / `--code-file`，走 HTTP Basic 认证（用户名 `review`），
  页面、API、SSE 长连接全部要过。
- 批注模式与编辑模式**互斥**：进一个自动退另一个（编辑靠 `contenteditable`、批注靠划选，两者抢选区）。
- 协作服务做了三件工程上的事：
  - **gzip**：内联了 echarts 的稿子 1.17MB → 377KB，局域网更快，公网隧道才传得完
  - **少写扩展名也能开**：`/doc` 自动回退到 `/doc.html`，404 页会直接列出目录里有哪些稿子
  - **数据落盘**：`data/<docId>.json`，一个文档一个文件，可直接备份 / 进 Git

### 修复

- **批注后正文凭空多出空行**（本轮最重的一个 bug）：原来高亮用 `range.extractContents()` 整段包裹，
  跨段落划选时会把 `<p>/<section>` 等块级元素塞进 inline `<span>`，浏览器拆出匿名块 →
  正文多出空行，且每次重渲染都嵌套一层、越包越大（实测一次批注文档高度 +866px）。
  现改为**只给文本节点包 `<span>`**，跨段划选拆成多个片段共用同一个批注 id，
  实测 571 个块元素的位置与高度**零差异**。删除批注后正文逐字还原。
- **多人评审时分不清谁说的**：原来所有人一律显示「我」。现在每人独立署名（首次填一次、标题栏头像可随时改），
  默认给可区分的「访客 XXX」，不会被误当成同一个人。
- **侧栏展开后图表被遮住**：侧栏靠改 `body` 右内边距给正文让位，但 window 尺寸没变，
  echarts 这类图表库收不到 `resize` 就不会重排，图表右侧被压在侧栏底下。
  现在开合侧栏时在过渡首尾各派发一次 `resize`。
- 点击高亮支持多片段：一条批注对应多个高亮片段时，点任意片段都会激活同一张卡片，且所有片段同时高亮。

## [1.1.0] - 2025

### 新增

- **网页（http/https）也能编辑**。别人分享给你一个 html 网页、你手上没有原文件，也能直接改：
  点工具栏图标 / `Cmd+Shift+E` / 右键「HTML Studio：编辑本页」进入编辑
  （地址本身就是 `.html` 结尾的网页会自动出现 ✎，其余网站不打扰）。
  第一次 `Cmd+S` 自动存成 `~/Downloads/<域名>-<路径>.html`，之后的保存都写这个文件；
  下次打开同一个链接还认得住这个落点。
- **网页存本地时自动把相对路径转成绝对地址**：`./style.css`、`/img/a.png`、`style` 里的 `url()`、
  `srcset` 全部转绝对，存到磁盘再离线打开不会丢样式和图片。
- **字体 / 字号**（工具条 `Aa`）：常用中英文字体 + 11~96px 预设 + 自定义 px。
  选中文字改选中的部分；没选中时改光标所在的整段。样式写成内联 `span`，跟着文字一起保存。
- **拖动模块**（工具条「移动」/ `Cmd+M`）：拖标题、图片、卡片、整段 section 换位置，
  蓝线是落点，`Shift` 抓父级容器，`Esc` 退出，移动模式下 `Cmd+Z` 撤销上一步移动
  （拖动是脚本直接改 DOM，浏览器自带撤销追不到，这里自己记了位置栈）。
  落点优先找「与拖动物同级」的兄弟，所以拖卡片不会误插到别人卡片的标题里；
  只做同级重排，不会产出 `<div>` 塞进 `<p>` 的非法嵌套。
- **删除某一页**（工具条「页面」）：先按 `.slide / .page / swiper / [data-page]` 等已知结构识别，
  再退回「同一父元素下多个接近满屏的块」的启发式；每页带标题，可定位、可删除。
- 工具条「⋯」菜单：另存为 / 放弃改动 / 备份历史 / 撤销保存 / 自检页入口（按钮太多，收起来了）。
- 本地程序新增 `save-or-create`：目标文件不存在就新建、存在就覆盖（覆盖前照旧备份）。

### 修复

- **字体改完再调字号会变成「应用到整段」**：改完会把刚处理的那段重新选上，
  连着调字体字号不会失效
- **改字体把原来的字号弄丢了**：不再用 `execCommand('fontSize')` 打标记
  （它按 1~7 档位工作，32px 和 size=7 同档，会被当成「取消格式」），
  改成按 Range 精确包 `<span>`；选区正好是某个内联元素的全部内容时就地合并样式，不套娃
- 工具条重绘会把刚弹出的提示抹掉（改一下字提示就消失了）
- 点面板里的下拉框会覆盖掉页面里的选区，导致样式作用到错误的位置

## [1.0.3] - 2025

### 修复

- **点保存/点工具条会触发页面自己的点击逻辑**（在「点一下翻下一页」这类页面上表现为保存后直接跳页）。
  原因是工具条的点击事件冒泡到了 `document`，被页面当成翻页指令。
  现在编辑模式下：工具条内的事件在 host 边界截断；页面内容的点击也不再传给页面自己的监听器
  （只 `stopPropagation`，不 `preventDefault`，光标定位与选中文字等原生编辑行为不受影响）。
  要正常使用页面交互时切到预览模式（`Cmd/Ctrl+E`）即可
- 工具条按钮显式设为 `type="button"`，避免页面残留未闭合的 `<form>` 把按钮当成提交按钮

## [1.0.2] - 2025

### 修复

- **`Cmd/Ctrl+Z` 撤销失效** —— 改为自己在捕获阶段接管撤销/重做，走与工具条 `↶ ↷` 相同的
  `execCommand` 通道（该通道已验证有效），不再依赖页面自身的 keydown 处理与浏览器默认行为；
  `Cmd/Ctrl+Shift+Z` 为重做
- **保存链路故障时无法丢弃改动** —— 新增工具条「**放弃改动**」，直接重新加载文件。
  它不经过本地程序，因此即使本地程序没注册上也能用
- 「撤销保存」失败时补充指引：提示改用「放弃改动」或 `Cmd+Z`

## [1.0.1] - 2025

### 修复

- 保存失败时不再直接抛出浏览器英文错误码（如 `Specified native messaging host not found`），
  改为按错误类型给出可操作的中文指引（跑 `install.py` / `--ext-id` 重新注册 / 重新加载扩展 /
  文件不在主目录等）；错误提示停留时间 5.2s → 12s

## [1.0.0] - 2025

首个公开版本。

### 新增

**Chrome 扩展**

- 在任意本地 `.html` 页面注入悬浮编辑条（shadow DOM，与页面样式完全隔离），点文字即可编辑
- `Cmd/Ctrl+S` 保存回原文件；`Cmd/Ctrl+E` 切换编辑/浏览；`Esc` 退出
- 格式工具条：加粗 / 斜体 / 下划线 / H1–H3 / 正文 / 链接 / 插入图片 / 清除格式 / 撤销 / 重做
- 双击图片替换地址；粘贴截图或选图自动存入同目录 `assets/`，页面以相对路径引用
- 备份历史面板、撤销上次保存、另存为
- 未保存改动以橙点提示，关闭标签页时拦截
- 内置自检页（点工具栏图标打开）：实时检测扩展加载 / 文件访问权限 / native host 连通性
- 点工具栏图标可开关编辑模式；在非本地页面则打开自检页

**native messaging host**

- 纯 Python 标准库实现，零第三方依赖
- 保存、自动备份、按备份恢复、撤销、图片落盘
- 安全边界：仅接受 `$HOME` 内、`.html/.htm/.xhtml` 结尾、路径中不含隐藏段落的文件；
  拒绝保存空内容；无网络请求、无遥测、无远程代码

**本地网页版**

- 文件列表 + 所见即所得编辑，保存后显示逐行 diff（绿增红删）
- 工作目录搜索、快捷目录切换（主目录 / Downloads / Desktop / Documents）
- 记住上次打开的文件，再次访问自动恢复
- 可注册为 launchd 常驻服务：开机自启、崩溃自动拉起

**安装与工程**

- `extension/install.py` 跨平台注册（macOS 实测 / Linux 同逻辑 / Windows 实验性）
- `install.py --check` 体检：目录合法性 + 注册状态 + 活体 ping
- `install.py --ext-id` 支持从应用商店安装时按商店分配的 ID 注册
- `install.py --rename-host` 一次性改写 4 处硬编码的 host 名
- `tests/e2e_chrome.py`：真实 Chrome + 真实 native messaging 的端到端测试，15 项断言，无 mock
- 中英文双 README、FAQ、issue/PR 模板

### 修复（开发期踩到并已解决的坑）

- `extension/` 内以 `_` 或 `.` 开头的文件（如 `__pycache__`）会导致 Chrome 拒绝加载整个扩展，
  而报错信息只说「清单文件缺失或不可读取」。现已由 `--check` 自动清理并给出提示
- MV3 content script 不允许调用 `chrome.runtime.sendNativeMessage`，改为经 background 转发
- MV3 扩展页 CSP 禁止内联 `<script>`，自检页脚本拆为 `help.js`
- 内联 SVG 的自闭合标签被浏览器序列化展开（`<line/>` → `<line></line>`），已做还原
- 重复进入编辑模式会把原始 `contenteditable` 属性记错，导致退出后残留

### 已知限制

- 保存基于 DOM 序列化，浏览器会重新规范化一次缩进/换行（实测 118 行页面改一个词，落盘差 10 行）
- 页面若用 `<script>` 在加载后动态生成 DOM，该部分内容会被一并写入文件
