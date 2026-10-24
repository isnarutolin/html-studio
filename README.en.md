# HTML Studio

**Edit AI-generated HTML in place — no need to make the model regenerate the whole page.**

Open a local `.html` → click **✎** in the bottom-right corner → edit the text like a document
→ `Cmd/Ctrl+S` writes it back to the original file.

Automatic backups · One-click undo · Zero dependencies · No network access

[中文](README.md) · [FAQ](docs/FAQ.md) (Chinese) · [Changelog](CHANGELOG.md)

---

## 30-second setup

```bash
git clone https://github.com/isnarutolin/html-studio.git ~/html-studio
cd ~/html-studio/extension && python3 install.py
```

Then, in the browser:

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → pick the `extension` folder
2. Extension card → **Details** → turn on **"Allow access to file URLs"**
   ← **without this, nothing happens on local pages and no error is shown**
3. **Fully quit and reopen the browser**

Now double-click any local `.html` file and edit it.

Stuck? **Click the extension's toolbar icon** — the self-check page tells you exactly what's missing:

```bash
python3 install.py --check     # CLI equivalent: layout, registration, live ping
```

> **Why a local helper program?** Browsers deliberately prevent extensions from writing to disk
> (otherwise any extension could modify your files). Saving therefore has to go through a native
> program — that's Chrome's official *native messaging* mechanism. The helper is ~300 lines of
> plain Python standard library, only touches `.html` files under `$HOME`, has no network access.
> See [Security model](#security-model).

---

## What it does

| | |
| --- | --- |
| **Edit** | Click text and type, WYSIWYG; bold / italic / underline / H1–H3 / link / clear formatting / undo / redo |
| **Save** | `Cmd/Ctrl+S` overwrites the original file; after saving you get a line-by-line diff (green add / red remove) |
| **Undo** | Automatic backup before every save; "undo save" reverts to the previous version; browse any historical backup |
| **Images** | Double-click to change a URL; pasting a screenshot stores it in `assets/` next to the file (no base64 bloat) |
| **Toggle** | `Cmd/Ctrl+E` edit ↔ browse (links clickable); `Esc` to exit |

An **orange dot** means unsaved changes, and closing the tab warns you. Empty content is rejected,
so a bug can never blank out your source file.

> **What it is not**: not a rich-text editor, not an HTML source editor — it's for fixing the few
> words in a page AI already generated. Deliberate non-goals are documented in
> [FAQ · scope](docs/FAQ.md#11-为什么不做-xxx--这个项目的边界) (Chinese).

## Self-check page

Not sure which step went wrong? **Click the extension's toolbar icon** (🧩 → HTML Studio).
It opens a live diagnostic page checking three things: extension loaded / file-URL access /
native host connectivity — and tells you how to fix whichever one is red.

---

## Local web app

The other path, if you'd rather not install an extension: file list on the left, editor on the right,
same save/backup pipeline.

```bash
cd ~/html-studio
python3 server.py                  # port 7788, workspace defaults to $HOME
python3 server.py --dir ~/Downloads --port 8000
```

Open <http://127.0.0.1:7788>, then `Cmd/Ctrl+S` to save. Includes search and quick folder switching.

On macOS you can keep it running in the background (starts at login, restarts on crash,
remembers the last file you had open):

```bash
python3 service.py install     # registers a launchd agent
python3 service.py status      # restart / uninstall / logs
```

> Linux: write a systemd user unit (`ExecStart=python3 .../server.py --no-browser`).
> Windows: just run `python server.py` in a terminal.

---

## Security model

A program that can write to your disk deserves a clear explanation:

- **Only accepts** files inside `$HOME`, ending in `.html/.htm/.xhtml`, with no hidden path segments
- **Rejects empty content**, so your source file can't be wiped by a bug
- **Backs up before every write**; any historical version can be restored (restoring also backs up first)
- **No network requests, no telemetry, no remote code** — everything runs locally
- The web app binds to `127.0.0.1` only and validates paths against traversal

Backup locations:

```
~/.html-studio/backups/        # extension (one .bak dir per file)
<workspace>/.edits/backups/    # web app
```

## Known limitations

Saving serializes the live DOM, therefore:

- Text, structure, classes and attributes are preserved; self-closing `<svg>` tags are restored
- The browser re-normalizes indentation/whitespace once. Measured: on a 118-line AI-generated page,
  changing a single word altered 10 lines (1 real change + 3 whitespace normalizations)
- If a page generates DOM via `<script>` at load time, that content gets baked in.
  Check the diff afterwards and use "undo save" if it looks wrong — backups protect you

## Platform support

| | macOS | Linux | Windows |
| --- | --- | --- | --- |
| Extension + native host | ✅ | ✅ same logic, not machine-tested | ⚠️ experimental (registry + `.cmd` launcher, untested) |
| Web app | ✅ | ✅ | ✅ |
| Background service | ✅ launchd | use systemd | — |

PRs with Linux/Windows testing feedback are very welcome.

## Development

```bash
python3 -m py_compile server.py service.py extension/native_host.py extension/install.py

# End-to-end test: real Chrome + real native messaging, 15 assertions, no mocks.
# Uses a throwaway profile; your own browser is untouched.
python3 tests/e2e_chrome.py

# Rebrand: the native host name is hardcoded in 4 files; this rewrites all of them
python3 extension/install.py --rename-host com.example.htmlstudio
```

After changing extension code, click **Reload** on the extension card in `chrome://extensions`.

Flow: `content.js` (injected toolbar, shadow DOM isolated from page CSS) → `background.js`
(forwards native messaging, because content scripts cannot call `sendNativeMessage` directly) →
`native_host.py` (actual file I/O).

## License

MIT
