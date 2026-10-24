# 发布到 GitHub 前的检查清单

这个项目有个绕不开的特殊点：**它不是纯网页应用，而是「浏览器扩展 + 本地原生程序」的组合**。
所以"别人能用起来"的门槛比一般项目高，下面按「不处理就会出事」的优先级排列。

---

## P0 · 会泄露 / 会让别人装完直接失败

### 1. 永远不要提交签名私钥

`signing-key.pem` 是打包 `.crx` 用的私钥，**已在 `.gitignore` 里**。提交前确认：

```bash
git status --porcelain | grep -i pem   # 应该没有任何输出
```

> 注意区分：`extension/manifest.json` 里的 `"key"` 字段是**公钥**，它的作用是让扩展 ID 固定下来
> （这样 native host 的 `allowed_origins` 才能预先写死）。公钥提交是**必要且安全**的。
> 只有私钥不能进仓库。

如果你已经不小心提交过私钥，光删文件不够（历史里还在），要重写历史：

```bash
git filter-repo --path signing-key.pem --invert-paths   # 或 BFG
# 然后重新生成一对新密钥
```

### 2. 补 LICENSE

`LICENSE` 已放好 MIT 模板，**把 `<YOUR NAME>` 换成你的名字/GitHub 昵称**。
没有 LICENSE 的仓库，别人在法律上无权使用、修改、分发 —— 等于白开源。

### 3. 跨平台：`install.py` 必须能识别对方系统的浏览器路径

原版只认 macOS 的 `~/Library/Application Support/...`，Linux/Windows 用户会直接注册失败。
现已改为按 `sys.platform` 分支：

| 平台 | host manifest 位置 | 状态 |
| --- | --- | --- |
| macOS | `~/Library/Application Support/<浏览器>/NativeMessagingHosts/` | ✅ 已实测 |
| Linux | `~/.config/<浏览器>/NativeMessagingHosts/` | ✅ 逻辑相同，未实机验证 |
| Windows | 注册表 `HKCU\Software\Google\Chrome\NativeMessagingHosts\<name>` | ⚠️ 实验性，见下 |

**Windows 是唯一的真实缺口**：需要 `.cmd` 启动器 + 注册表登记，代码写好了但**没有 Windows 机器实测过**。
诚实的做法是在 README 里标注「Windows 实验性，欢迎 PR」，而不是假装支持。

### 4. 别人一定会卡在「允许访问文件网址」

这是墨菲定律级别的高频问题：**不开这个开关，扩展在本机 html 上完全不生效，而且没有任何报错**。
应对：

- README 用醒目段落写清楚（不是脚注）
- 扩展内置自检页 `help.html`：点工具栏图标就打开，三项条件实时检测（已实现）
- `install.py` 结尾打印安装步骤时反复强调（已实现）

---

## P1 · 发布渠道相关的坑

### 5. 上架 Chrome 应用商店后，扩展 ID 会变

商店会用商店的密钥重新分配 ID，manifest 里的 `"key"` 被忽略。这时 native host 注册的
`allowed_origins` 就对不上了，保存会报「无法连接本地 host」。

给用户一条出路（已实现）：

```bash
python3 install.py --ext-id <商店页面显示的ID>
```

### 6. 商店对 `nativeMessaging` 权限会人工审核

提审时要准备好说明，大意是：

> 本扩展用于编辑本地 HTML 文件。浏览器的安全模型不允许扩展直接写磁盘，
> 因此必须通过 native messaging 调用用户自行安装的本地程序完成保存。
> 该程序只接受用户主目录下、`.html` 结尾、非隐藏路径的文件，且每次写入前自动备份。

同时准备好：隐私声明（本项目**不收集任何数据、无网络请求、无远程代码**）、
截图、以及一个能让人 3 步内看到效果的 demo 视频。

### 7. 商店版和「加载已解压」版的行为差异

- 加载已解压：改代码后要让用户手动点「重新加载」，你必须写进 README
- 商店版：靠版本号升级自动更新，记得改 `manifest.json` 的 `version`

### 8. 给想改品牌的人留条路

native host 名字是 `com.naruto.html_studio`，别人的项目不该继承你的名字。
`--rename-host` 会同步改写 4 个文件里的副本（JS 里是硬编码的，漏改一个就静默失效）：

```bash
python3 extension/install.py --rename-host com.example.htmlstudio
```

---

## P2 · 体验与可维护性

### 9. 安全模型要写在明面上

别人凭什么信任一个能写他磁盘的程序？README 里要主动交代：

- 只监听 / 只操作 `$HOME` 内、`.html/.htm/.xhtml` 结尾、路径中不含隐藏目录的文件
- 拒绝空内容保存（防止把源文件清成空）
- 每次写入前备份到 `~/.html-studio/backups/`，可一键回滚
- 无任何网络请求，不收集数据
- 网页版只监听 `127.0.0.1`

### 10. 明确「保存会重排空白」这个真实限制

浏览器把 DOM 序列化回去时，缩进/换行会被规范化，内联 SVG 的自闭合标签需要特判（已处理）。
实测一个 118 行的 AI 生成页面只改一个词，落盘差 10 行（1 行真改动 + 3 行空白归一化）。
**主动写进 README**，比让用户自己发现强得多。

### 11. 仓库别带上你自己的运行时垃圾

`.gitignore` 已覆盖：`.edits/`（网页版备份）、`*.log`、`__pycache__/`、`.DS_Store`、`*.pem`。
注意 `~/.html-studio/`（扩展版备份）在仓库外，本来就不会被提交。

> **真实的坑（我自己踩了）**：在 `extension/` 里跑 `py_compile` 或 `import native_host`
> 会生成 `extension/__pycache__/` —— 而 `_` 开头的目录名同样会让 Chrome 拒绝加载整个扩展，
> 报错还是那句含糊的「清单文件缺失或不可读取」。
> `install.py --check` 现在会自动清理它；但提交前最好还是确认一下：
>
> ```bash
> ls -A extension | grep -E '^[_.]' && echo "✗ 有保留名，先删掉" || echo "✓ 干净"
> ```

### 12. 没有第三方依赖，这是卖点

`server.py` / `native_host.py` / `install.py` / `service.py` 全部只用 Python 标准库。
README 里值得明说 —— 别人 `python3 xxx.py` 就能跑，不用 `pip install`。

---

## 发布前自检（照着跑一遍）

```bash
cd ~/html-studio

# 1. 没有任何私钥会被提交
git status --porcelain | grep -i pem || echo "✓ 无私钥"

# 2. 扩展目录体检 + native host 活体 ping
python3 extension/install.py --check

# 3. Python 文件语法
python3 -m py_compile server.py service.py extension/native_host.py extension/install.py && echo "✓ 语法 OK"

# 4. 别把个人绝对路径写进文档
grep -rn "/Users/$(whoami)" README.md PUBLISHING.md || echo "✓ 无个人路径"

# 5. 确认真实可用（端到端：装扩展 → 打开本地 html → 改字 → 保存 → 落盘）
#    这一步没法自动化，手动做一遍
```

## 仓库 About（GitHub 右侧那块）

点仓库页右上角 ⚙️ 编辑。Description 比 README 第一屏更容易被看到，值得单独打磨：

```
Edit AI-generated HTML in place — click the text, tweak it, Cmd+S writes it back to the
original file. Chrome extension + optional local web UI. Zero dependencies, automatic
backups, one-click undo.
```

Topics（影响被搜到的概率）：

```
html  html-editor  wysiwyg  contenteditable  chrome-extension  native-messaging
local-first  ai-generated  no-dependencies  backup  macos  python
```

再勾上 README 里已经写好的:
- Website 留空或填 demo 视频链接
- Releases 里发一个 `v1.0.0`，附一张 zip（点 Code → Download ZIP 也行，但有 Release 显得更正式）

## 可选增强（不影响发布）

这些都没有也能发，按性价比排序：

1. **demo 录屏 / GIF** —— 效果最好的一项。"点文字改 → Cmd+S → 文件修改时间跳一下"这 5 秒，
   比任何文字描述都直观。放 `docs/demo.gif`，然后在 README 顶部加一行 `![demo](docs/demo.gif)`。
   不想录就跳过，首屏的四步流程文字已经够表达了。
2. **GitHub Release** —— 比只有代码更有"这是个成品"的感觉。`git tag -a v1.0.0` + 发布页贴
   Release Notes（`CHANGELOG.md` 里有素材）。
3. **Discussions** —— 开个 Q&A 分类，避免所有问题都变成 issue。
4. **GitHub Actions** —— 跑 `py_compile` + `tests/e2e_chrome.py`。
   注意 e2e 需要真 Chrome 和已注册的 native host，在 CI 里要额外装 Chrome，成本较高；
   只跑语法检查也是合理的最小方案。

## 目录建议

公开仓库建议只保留产品代码，把个人安装痕迹清掉：

```
html-studio/
├── README.md            # 中文主文档
├── README.en.md         # 英文版（GitHub 国际读者）
├── LICENSE              # MIT
├── PUBLISHING.md        # 本文件（也可以不进仓库）
├── .gitignore
├── server.py            # 网页版
├── ui.html
├── service.py           # 常驻服务（macOS launchd；其它平台见 README）
├── start.command
└── extension/           # Chrome 扩展
    ├── manifest.json
    ├── content.js
    ├── background.js
    ├── help.html / help.js
    ├── native_host.py
    ├── install.py
    └── icon-*.png
```
