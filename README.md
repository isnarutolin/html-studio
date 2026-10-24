# HTML Studio

**直接在 AI 生成的 HTML 上改内容，`Cmd+S` 存回本地原文件，不用再反复跟 AI 对话。**

[English](README.en.md) · 中文

> 📖 **[常见问题（FAQ）](docs/FAQ.md)** —— 页面没有 ✎、保存报「无法连接本地 host」等，先看这里。

AI 生成的页面，改一句话就要重新生成一整份 —— 这个工具解决的就是这一步。
加载后在本地 `.html` 页面里直接点文字改，像改文档一样，保存就是覆盖原文件（自动备份、可撤销）。

两种形态，同一套本地保存逻辑：

| 形态 | 适合 | 入口 |
| --- | --- | --- |
| **Chrome 扩展** | 想在哪改就在哪改：双击任意本地 html，右下角点 ✎ | 见下 |
| **本地网页版** | 想一边浏览文件列表一边改 | `python3 server.py` → <http://127.0.0.1:7788> |

---

## 一、Chrome 扩展

扩展不能直接写磁盘（浏览器安全模型限制），所以配了一个很小的本地程序（native messaging host，
纯 Python 标准库，无第三方依赖）负责真正的保存、备份、撤销。

### 安装

```bash
git clone https://github.com/isnarutolin/html-studio.git ~/html-studio
cd ~/html-studio/extension
python3 install.py
```

脚本会自动找到已安装的 Chromium 系浏览器（Chrome / Chromium / Brave / Edge / Vivaldi）并注册本地程序，
然后打印扩展 ID 和后续步骤。浏览器里要做三件事：

1. `chrome://extensions` → 开启**开发者模式** → **加载已解压的扩展程序** → 选这个 `extension` 目录
2. 扩展卡片 → **详情** → 打开 **「允许访问文件网址」**
   > ⚠️ **不开这一步，本地 html 页面不会有任何反应，也不会有报错。** 这是最常见的坑。
3. **完全退出浏览器再重开**（native host 注册在启动时读取）

### 用起来

在访达/Finder 里双击一个本地 `.html`（地址栏是 `file:///...`），右下角出现蓝色 **✎** → 点它开始编辑。

| 操作 | 说明 |
| --- | --- |
| `Cmd/Ctrl+S` | 保存回原文件 |
| `Cmd/Ctrl+E` | 切换 编辑 / 浏览（浏览态链接可点） |
| `Esc` | 退出编辑 |
| 双击图片 | 换图片地址 |
| 粘贴截图 / 点「图片」 | 图片存到该文件旁的 `assets/`，页面用相对路径引用 |
| 工具条 | 加粗 / 斜体 / 下划线 / H1-H3 / 正文 / 链接 / 清格式 / 撤销 / 重做 |
| 备份 / 撤销保存 / 另存为 | 见下 |

**橙点**表示有未保存改动，关标签页会拦一下。

### 自检页

忘了哪一步没做？**点浏览器工具栏的扩展图标**（🧩 → HTML Studio），会打开自检页，实时检查三项：
扩展已加载 / 文件访问权限 / 本地程序连通性。哪项红了就直接告诉你怎么办。

也可以命令行体检：

```bash
python3 install.py --check     # 目录规范 + 注册状态 + 真实 ping 一次本地程序
```

---

## 二、本地网页版

```bash
cd ~/html-studio
python3 server.py                  # 端口 7788，默认工作目录 = 主目录
python3 server.py --dir ~/Downloads --port 8000
```

打开 <http://127.0.0.1:7788>：左边点文件 → 右边直接改 → `Cmd/Ctrl+S`。
侧栏有快捷目录切换和搜索；保存后底部面板显示这次改了哪几行（绿加红删）。

### 想让它常驻（macOS）

```bash
python3 service.py install     # 注册 launchd：开机自启 + 崩溃自动拉起
python3 service.py status      # 状态
python3 service.py restart
python3 service.py uninstall
```

装完就是个固定入口，存书签即可。还会记住上次打开的文件。

> Linux 用户：`./start.command` 类似地写个 systemd user unit 即可（`ExecStart=python3 .../server.py --no-browser`）。
> Windows 用户：直接前台 `python server.py`。

---

## 安全设计

- 本地程序**只接受**：`$HOME` 内、`.html/.htm/.xhtml` 结尾、路径中不含隐藏目录/文件
- **拒绝保存空内容**（防止把源文件清成空）
- **每次写入前自动备份**，可一键回滚到任意历史版本
- **无任何网络请求，不收集数据，无远程代码**，全部本地
- 网页版只监听 `127.0.0.1`，并对 `/files/` 做路径越界校验

备份位置：

```
~/.html-studio/backups/        # 扩展版（每个文件一个 .bak 目录）
<工作目录>/.edits/backups/     # 网页版
```

## 已知边界

保存是把浏览器当前 DOM 序列化写回文件，所以：

- 文本、结构、class、属性都保留；`<svg>` 里的自闭合标签做了还原处理
- 但浏览器会重新规范化一次缩进/换行。实测一个 118 行的 AI 生成页面只改一个词，落盘差 10 行
  （1 行真实改动 + 3 行空白归一化）
- 如果页面用 `<script>` 在加载后动态生成 DOM，那部分动态内容也会被写进文件。
  改这类页面后先看一眼 diff，不对就「撤销保存」—— 有备份兜底

## 平台支持

| | macOS | Linux | Windows |
| --- | --- | --- | --- |
| 扩展 + native host | ✅ | ✅ 逻辑相同，未实机验证 | ⚠️ 实验性（注册表 + `.cmd` 启动器，未实测） |
| 网页版 | ✅ | ✅ | ✅ |
| 常驻服务 `service.py` | ✅ launchd | 用 systemd（见上） | — |

欢迎 PR 补 Windows/Linux 实测反馈。细节见 [FAQ · 平台支持](docs/FAQ.md#8-windows--linux-能用吗)。

## 开发者

```bash
# 语法检查
python3 -m py_compile server.py service.py extension/native_host.py extension/install.py

# 端到端测试：真实 Chrome + 真实 native messaging，走完「点 ✎ → 改字 → 保存 → 校验落盘」
# 用独立临时 profile，不动你正在用的浏览器
python3 tests/e2e_chrome.py

# 改品牌（native host 名字是硬编码在 4 个文件里的，用这个命令一次改全）
python3 extension/install.py --rename-host com.example.htmlstudio
```

浏览器里改了扩展代码后，**要在 `chrome://extensions` 点该扩展的「重新加载」**才会生效。

扩展结构：`content.js`（注入的编辑条，shadow DOM 隔离页面样式）→ `background.js`
（转发 native messaging，因为 content script 不能直接调 `sendNativeMessage`）→
`native_host.py`（真正读写文件）。

## License

MIT
