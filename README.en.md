# HTML Studio

**Edit AI-generated HTML content directly in the browser, then press `Cmd/Ctrl+S` to save it back
to the original file.** No more asking the model to regenerate the whole page for a typo.

[中文](README.md) · English

> 📖 **[FAQ](docs/FAQ.md)** (Chinese) — covers the most common issues: no ✎ button,
> "cannot connect to native host", "manifest file is missing or unreadable".

Two form factors, same local save pipeline:

| Form | Best for | Entry point |
| --- | --- | --- |
| **Chrome extension** | Open any local `.html` and click ✎ in the bottom-right corner | see below |
| **Local web app** | Browse a file list and edit side by side | `python3 server.py` → <http://127.0.0.1:7788> |

---

## 1. Chrome extension

Extensions can't write to disk (browser security model), so there's a small local companion
(a *native messaging host*) that does the actual saving, versioned backups and undo.
It's plain Python standard library — **no third-party dependencies at all**.

### Install

```bash
git clone https://github.com/isnarutolin/html-studio.git ~/html-studio
cd ~/html-studio/extension
python3 install.py
```

The script detects installed Chromium-based browsers (Chrome / Chromium / Brave / Edge / Vivaldi),
registers the native host, and prints the extension ID plus next steps. Then in the browser:

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → pick the `extension` folder
2. On the extension card → **Details** → turn on **"Allow access to file URLs"**
   > ⚠️ **Without this, nothing happens on local pages and there is no error message.** This is the #1 gotcha.
3. **Fully quit and reopen the browser** (native host registrations are read at startup)

### Usage

Double-click a local `.html` file (the address bar must start with `file:///`).
A blue **✎** appears in the bottom-right corner — click it to start editing.

| Action | |
| --- | --- |
| `Cmd/Ctrl+S` | save back to the same file |
| `Cmd/Ctrl+E` | toggle edit / browse (links clickable) |
| `Esc` | leave edit mode |
| double-click an image | replace its URL |
| paste a screenshot / click "图片" | image is stored in `assets/` next to the file, referenced relatively |
| toolbar | bold / italic / underline / H1–H3 / paragraph / link / clear formatting / undo / redo |
| 备份 · 撤销保存 · 另存为 | backup history · undo last save · save as |

An **orange dot** means unsaved changes; closing the tab warns you.

### Self-check page

Not sure which step is missing? **Click the extension's toolbar icon** (🧩 → HTML Studio).
It opens a live diagnostic page checking three things: extension loaded / file-URL access /
native host connectivity — and tells you exactly what to fix.

Command line equivalent:

```bash
python3 install.py --check     # layout + registration + a real ping to the native host
```

---

## 2. Local web app

```bash
cd ~/html-studio
python3 server.py                  # port 7788, workspace defaults to $HOME
python3 server.py --dir ~/Downloads --port 8000
```

Open <http://127.0.0.1:7788>: pick a file on the left, edit on the right, `Cmd/Ctrl+S` to save.
Includes search, quick folder switching, and a per-save diff panel (green add / red remove).

### Run it as a background service (macOS)

```bash
python3 service.py install     # launchd: start at login, restart on crash
python3 service.py status | restart | uninstall
```

That gives you a permanent bookmarkable entry point, and it remembers the last file you had open.

> Linux: write a systemd user unit. Windows: just run `python server.py` in a terminal.

---

## Security model

- The native host only accepts files that are **inside `$HOME`**, end with `.html/.htm/.xhtml`,
  and contain **no hidden path segments**
- **Empty content is rejected**, so a bug can never blank out your source file
- **Every write is backed up first**; any historical version can be restored
- **No network requests, no telemetry, no remote code** — everything is local
- The web app binds to `127.0.0.1` only and validates paths against traversal

Backups live in:

```
~/.html-studio/backups/        # extension: one .bak dir per file
<workspace>/.edits/backups/    # web app
```

## Known limitations

Saving serializes the live DOM, therefore:

- Text, structure, classes and attributes are preserved; self-closing `<svg>` tags are restored
- The browser re-normalizes indentation/whitespace once. Measured on a 118-line AI-generated page,
  changing one word altered 10 lines (1 real change + 3 whitespace normalizations)
- If a page generates DOM via `<script>` at load time, that generated content gets baked in.
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

# End-to-end test: real Chrome + real native messaging (click ✎ → edit → save → verify on disk).
# Uses a throwaway profile; your own browser is untouched.
python3 tests/e2e_chrome.py

# rebrand: the native host name is duplicated in 4 files; this rewrites all of them
python3 extension/install.py --rename-host com.example.htmlstudio
```

After changing extension code, click **Reload** on the extension card in `chrome://extensions`.

Flow: `content.js` (injected toolbar, shadow DOM isolated from page CSS) → `background.js`
(forwards native messaging, because content scripts cannot call `sendNativeMessage` directly) →
`native_host.py` (actual file I/O).

## Changelog

[CHANGELOG.md](CHANGELOG.md)

## License

MIT
