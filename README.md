# HTML Studio

**改 AI 生成的 HTML，不用再让 AI 重新生成一遍。**

打开本地 `.html` → 点右下角 **✎** → 像改文档一样直接改 → `Cmd/Ctrl+S` 存回原文件。

自动备份 · 一键撤销 · 零依赖 · 无网络请求

[English](README.en.md) · [常见问题](docs/FAQ.md) · [更新记录](CHANGELOG.md)

---

## 30 秒上手

```bash
git clone https://github.com/isnarutolin/html-studio.git ~/html-studio
cd ~/html-studio/extension && python3 install.py
```

然后在浏览器里做三步：

1. `chrome://extensions` → 开**开发者模式** → **加载已解压的扩展程序** → 选 `extension` 目录
2. 卡片 → **详情** → 打开 **「允许访问文件网址」** ← **不开就没反应，而且不报错**
3. **完全退出浏览器再重开**

现在双击任意本地 `.html` 就能改。

卡在哪一步了？**点浏览器工具栏的扩展图标** → 自检页会实时告诉你缺什么：

```bash
python3 install.py --check     # 命令行等价版本：目录规范 + 注册状态 + 真实 ping
```

> **为什么还要装个本地小程序？** 浏览器的安全模型不允许扩展直接写磁盘（否则任何扩展都能改你文件），
> 所以保存必须由本地程序配合，这是 Chrome 官方的 native messaging 机制。
> 那个程序约 300 行、纯 Python 标准库，只碰 `$HOME` 下的 `.html`，不联网、无远程代码 —— 详见 [安全设计](#安全设计)。

---

## 能做什么

| | |
| --- | --- |
| **改** | 点文字直接改，所见即所得；加粗 / 斜体 / 下划线 / H1–H3 / 链接 / 清格式 / 撤销重做 |
| **存** | `Cmd/Ctrl+S` 覆盖原文件，保存后显示逐行 diff（绿增红删） |
| **后悔** | 每次保存前自动备份；「撤销保存」回到上一次保存前；备份面板可回滚任意版本 |
| **图片** | 双击换地址；粘贴截图自动存到同目录 `assets/`（不塞 base64，文件不会变胖） |
| **切换** | `Cmd/Ctrl+E` 编辑 ↔ 浏览（浏览态链接可点）；`Esc` 退出 |

未保存时右下角有**橙点**，关标签页会拦一下；保存空内容会被拒绝，一个 bug 不会清空你的文件。

> **它不是什么**：不是富文本编辑器，也不是源码编辑器 —— 就是改 AI 页面里那几个字。
> 哪些功能是刻意不做的、为什么，见 [FAQ · 边界](docs/FAQ.md#11-为什么不做-xxx--这个项目的边界)。

## 自检页

不确定哪一步没做对，或者点了保存报错 —— **点浏览器工具栏的扩展图标**（🧩 → HTML Studio），
会打开自检页，实时检查三项：扩展已加载 / 文件访问权限 / 本地程序连通性。哪项红了就直接告诉你怎么办。

---

## 本地网页版

不想装扩展时的另一条路：左边文件列表，右边直接改，同一套保存/备份逻辑。

```bash
cd ~/html-studio
python3 server.py                  # 端口 7788，默认工作目录 = 主目录
python3 server.py --dir ~/Downloads --port 8000
```

打开 <http://127.0.0.1:7788>，`Cmd/Ctrl+S` 保存。侧栏可搜索、可快捷切换目录。

macOS 上可以让它常驻（开机自启 + 崩溃自动拉起 + 记住上次打开的文件）：

```bash
python3 service.py install     # 注册 launchd
python3 service.py status      # restart / uninstall / logs
```

> Linux 写个 systemd user unit 即可（`ExecStart=python3 .../server.py --no-browser`）；
> Windows 直接前台 `python server.py`。

---

## 安全设计

一个能写你磁盘的程序，值得说清楚它到底能干什么：

- **只接受**：`$HOME` 内、`.html/.htm/.xhtml` 结尾、路径中不含隐藏目录/文件
- **拒绝保存空内容**，防止误清空源文件
- **每次写入前自动备份**，可回滚到任意历史版本（恢复前也会再备份，所以恢复也能撤回）
- **无任何网络请求、不收集数据、无远程代码**，全部本地执行
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
# 15 项断言，无任何 mock；用独立临时 profile，不动你正在用的浏览器
python3 tests/e2e_chrome.py

# 改品牌（native host 名字硬编码在 4 个文件里，用这个命令一次改全）
python3 extension/install.py --rename-host com.example.htmlstudio
```

浏览器里改了扩展代码后，**要在 `chrome://extensions` 点该扩展的「重新加载」**才会生效。

扩展结构：`content.js`（注入的编辑条，shadow DOM 隔离页面样式）→ `background.js`
（转发 native messaging，因为 content script 不能直接调 `sendNativeMessage`）→
`native_host.py`（真正读写文件）。

## License

MIT
