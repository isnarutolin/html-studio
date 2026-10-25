# html-studio

**AI 生成的 HTML，想增删改一些内容，不必再费力改 prompt，也不用反复调教AI生成符合你心意的版本。**

所有html网页，你只需要在页面下方找到编辑入口，点一下就改，保存写回原来的 `.html` 文件——不是另存一份，不是导出 PDF。保存前能看 diff，每一笔改动都有备份。

[English](README.en.md) | 简体中文

![在页面上直接改字，保存写回原文件](docs/images/hero.gif)

---

## 它解决什么

你让 AI 生成一份周报、一张看板、一个方案页，生成得挺好，只有一个数字写错了。

**原来的路**：找回那段 prompt → 补一句“把 38% 改成 39%” → 重跑 → 发现全文措辞都变了 → 再逐段对一遍。

**用 html-studio**：打开文件 → 点那个错字 → 改 → `Cmd/Ctrl + S` → 完事。其余部分一个字节没动。

## 和别的方式比

| | 能直接改 | 能写回源文件 | 自动备份 | 要懂源码 |
| --- | --- | --- | --- | --- |
| 浏览器 DevTools | ✅ | ❌ 刷新即失效 | ❌ | — |
| 编辑器 + 浏览器预览 | ✅ | ✅ | 看你自己 | ✅ |
| 让 AI 重新生成 | ✅ | ✅ | ❌ 全文可能变 | ✅ 会改 prompt |
| **html-studio** | ✅ | ✅ | ✅ | ❌ |

三种都能改，区别在于**改完还剩什么**。DevTools 关掉就没了，是临时看；编辑器要你在标签里找代码；重新生成是拿确定性换省事。html-studio 只动你指的那一处，落盘前把 diff 摆给你看。

## 30 秒上手

两个入口，挑一个。

### 方式一：Chrome 扩展（推荐，能改任意本地 HTML）

```bash
git clone https://github.com/isnarutolin/html-studio.git
cd html-studio
python3 extension/install.py     # 注册 native host，让页面有权限写回磁盘
```

然后在浏览器里做三步：

1. `chrome://extensions` → 打开「开发者模式」→「加载已解压的扩展程序」→ 选 `extension/` 目录
2. 扩展卡片 →「详情」→ 打开 **「允许访问文件网址」**
   ← 不开这个，本地页面不会有任何反应，也不会报错
3. 完全退出浏览器再重开（native host 注册在启动时读取）

打开任意本地 `.html`，右下角出现 ✎，点它开始编辑。

### 方式二：本地网页版（不装扩展）

```bash
python3 server.py --dir ~/Downloads      # 默认端口 7788
```

打开 <http://127.0.0.1:7788>，左侧是文件列表，右侧直接改，`Cmd/Ctrl + S` 保存。

想让它在 macOS 上常驻（登录自启、崩溃自动拉起、记住固定地址）：

```bash
python3 service.py install      # 安装并启动
python3 service.py status       # 看状态
python3 service.py logs         # 跟日志
python3 service.py uninstall    # 卸载
```

## 保存前先看 diff

这是它敢让你直接动生产文件的原因。点保存会弹出逐行 diff，认了才落盘。

只改一个数字，落盘就是这一段：

```diff
19c19
- <p>留存仍然是短板，次月留存 38%，低于目标 6 个百分点。</p>
+ <p>留存仍然是短板，次月留存 39%，低于目标 6 个百分点。</p>
```

不满意就点「撤销保存」，源文件原样退回。

## 安全

一个能写你磁盘的东西，值得把边界说清楚：

- 只动 `$HOME` 内的 `.html / .htm / .xhtml`，路径含隐藏目录一律拒绝
- 拒绝写入空内容，防手滑把源文件清空
- 每次写盘前自动备份，可回滚到任意历史版本；恢复前再备份一次，所以恢复本身也能撤回
- 零网络请求、不收集数据、无远程代码，全程本地
- 网页版只监听 `127.0.0.1`，`/files/` 有路径越界校验

备份位置：

```
~/.html-studio/backups/        # 扩展版
<工作目录>/.edits/backups/      # 网页版
```

## 已知边界

保存是把页面当前 DOM 序列化写回文件，浏览器会顺手把排版重新规范化一遍：

- 文字、结构、class、属性都保留；`<svg>` 自闭合标签已做还原
- **缩进和换行会被重排**，`<!doctype html>` 会被规范成 `<!DOCTYPE html>`。改动越大越明显——所以请看 diff，不要盲存
- 页面若用 `<script>` 动态生成 DOM，那部分也会被一起写进文件。改这类页面先看 diff，不对就撤销，有备份兜底

## 平台

macOS 完整支持。Linux 逻辑相同但未实机验证。Windows 的扩展部分为实验性（注册表 + `.cmd` 启动器），网页版三平台通用。细节见 [FAQ](docs/FAQ.md)。

## 开发者

```bash
python3 tests/e2e_chrome.py      # 真 Chrome + 真 native messaging，端到端 17 项断言
```

一条链路：`content.js`（注入编辑条，shadow DOM 隔离样式）→ `background.js`（转发消息，content script 不能直接调 `sendNativeMessage`）→ `native_host.py`（校验 + 读写文件）。改完扩展代码记得回 `chrome://extensions` 点「重新加载」。

提 PR 前先跑一遍 `tests/e2e_chrome.py`，它覆盖了保存、备份、回滚、路径校验这几条主路径。

## License

MIT
