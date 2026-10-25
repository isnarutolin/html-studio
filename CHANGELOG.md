# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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
