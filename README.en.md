# html-studio

**AI-generated HTML with one wrong character? Fix it without going back to the prompt.**

Click the text on the page and edit it. Saving writes back to the same `.html` file — not a copy, not an export. You see a diff before it lands, and every change is backed up.

English | [简体中文](README.md)

![Editing text directly on the page, saving back to the original file](docs/images/hero.gif)

---

## What it solves

You asked AI for a weekly report, a dashboard, a proposal page. It came out good. One number is wrong.

**The old loop**: find the original prompt → add "change 38% to 39%" → regenerate → notice the wording changed everywhere else → re-read the whole thing line by line.

**With html-studio**: open the file → click the typo → fix it → `Cmd/Ctrl + S` → done. Every other byte is untouched.

## Compared to alternatives

| | Edit in place | Writes back to source | Automatic backups | Requires reading code |
| --- | --- | --- | --- | --- |
| Browser DevTools | ✅ | ❌ gone on refresh | ❌ | — |
| Editor + browser preview | ✅ | ✅ | up to you | ✅ |
| Ask AI to regenerate | ✅ | ✅ | ❌ whole page may change | ✅ rewrite the prompt |
| **html-studio** | ✅ | ✅ | ✅ | ❌ |

All of them can edit. The difference is **what's left afterwards**. DevTools is a temporary peek — close it and the change is gone. An editor makes you hunt for the code. Regenerating trades determinism for convenience. html-studio touches only the spot you point at, and shows you the diff before it lands.

## 30-second setup

Two entry points — pick one.

### Option 1: Chrome extension (recommended — edits any local HTML)

```bash
git clone https://github.com/isnarutolin/html-studio.git
cd html-studio
python3 extension/install.py     # registers the native host that's allowed to write to disk
```

Then in the browser:

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → pick the `extension/` folder
2. Extension card → **Details** → turn on **"Allow access to file URLs"**
   ← without this, local pages show nothing at all and no error
3. Fully quit and reopen the browser (the native host registration is read at startup)

Open any local `.html`; a ✎ appears in the bottom-right corner. Click it to start editing.

### Option 2: Local web app (no extension)

```bash
python3 server.py --dir ~/Downloads      # port 7788 by default
```

Open <http://127.0.0.1:7788> — file list on the left, edit on the right, `Cmd/Ctrl + S` to save.

To keep it running on macOS (starts at login, restarts on crash, stable address):

```bash
python3 service.py install      # install and start
python3 service.py status       # check status
python3 service.py logs         # follow logs
python3 service.py uninstall    # remove
```

## See the diff before you save

This is why it's safe to point at a real file. Hitting save shows a line-by-line diff; nothing is written until you accept it.

Changing one number writes exactly that range:

```diff
19c19
- <p>留存仍然是短板，次月留存 38%，低于目标 6 个百分点。</p>
+ <p>留存仍然是短板，次月留存 39%，低于目标 6 个百分点。</p>
```

Not happy with it? Hit "撤销保存" (undo save) and the source file goes back exactly as it was.

## Safety

Something that can write to your disk deserves a clear boundary:

- Touches only `.html / .htm / .xhtml` inside `$HOME`; any path containing a hidden directory is refused
- Refuses to write empty content, so a slip can't blank out your source file
- Backs up before every write and can roll back to any earlier version; it also backs up before restoring, so a restore can be undone
- Zero network requests, no telemetry, no remote code — everything runs locally
- The web app binds to `127.0.0.1` only, and `/files/` paths are validated against traversal

Backup locations:

```
~/.html-studio/backups/        # extension
<workspace>/.edits/backups/    # web app
```

## Known limitations

Saving serializes the page's current DOM back into the file, and the browser re-normalizes formatting along the way:

- Text, structure, classes and attributes are preserved; self-closing `<svg>` tags are restored
- **Indentation and line breaks get reflowed**, and `<!doctype html>` is normalized to `<!DOCTYPE html>`. The bigger the change, the more visible it is — so read the diff, don't save blindly
- If a page generates DOM with `<script>`, that generated content is written into the file too. Check the diff first; if it looks wrong, undo — the backup has you covered

## Platforms

macOS is fully supported. Linux uses the same logic but hasn't been tested on real hardware. The extension on Windows is experimental (registry + `.cmd` launcher); the web app works on all three. Details in the [FAQ](docs/FAQ.md) (Chinese).

## Development

```bash
python3 tests/e2e_chrome.py      # real Chrome + real native messaging, 17 end-to-end assertions
```

One pipeline: `content.js` (injects the editing bar, shadow DOM isolated from page styles) → `background.js` (forwards messages — content scripts can't call `sendNativeMessage` directly) → `native_host.py` (validates and reads/writes files). After changing extension code, click "Reload" in `chrome://extensions`.

Run `tests/e2e_chrome.py` before opening a PR — it covers saving, backups, rollback and path validation.

## License

MIT
