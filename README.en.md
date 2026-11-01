# html-studio

**AI-generated HTML with one wrong character? Fix it without going back to the prompt.**

Local `.html` files and **pages someone shared with you as a link** are both editable in place: retype text, switch font and size, drag blocks around, delete a whole page — then `Cmd/Ctrl + S` writes a local `.html` file. You see a diff before it lands, and every change is backed up.

English | [简体中文](README.md) · [FAQ](docs/FAQ.md) · [Changelog](CHANGELOG.md)

![Editing text directly on the page, saving back to the original file](docs/images/hero.gif)

---

## What it solves

You asked AI for a weekly report, a dashboard, a proposal page. It came out good. One number is wrong.

**The old loop**: find the original prompt → add "change 38% to 39%" → regenerate → notice the wording changed everywhere else → re-read the whole thing line by line.

**With html-studio**: open the file → click the typo → fix it → `Cmd/Ctrl + S` → done. Every other byte is untouched.

## What you can do

| | How |
| --- | --- |
| **Edit text** | Click into it and type; `Cmd+Z` to undo |
| **Font & size** | Select text (or just put the caret in a paragraph to restyle that whole block) → `Aa` → pick a family / size, or type any px value |
| **Drag blocks** | Click `移动` → drag a heading, image, card or whole section; the blue line shows where it lands; hold `Shift` to grab the parent container |
| **Delete a page** | Click `页面` → every detected page is listed → jump to it or delete it |
| **Edit a shared web page** | Open the link (no source file needed) → the first `Cmd+S` saves it as `~/Downloads/<host>-<page>.html`; later saves write to that file |

Saving a web page rewrites relative URLs (`./style.css`, `/img/a.png`) into absolute ones, so styles and images still load offline.

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

> **Upgrading 1.0.x → 1.1.0 requires a reload**: `chrome://extensions` → **Reload** on this extension.
> From 1.1.0 the extension runs on all `http/https` pages (that's what makes web-page editing work),
> so the browser may ask you to re-approve the permission once. That's expected.

**Editing a shared web page**: open the link, then click the extension's toolbar icon (or press `Cmd+Shift+E`, or right-click → "HTML Studio: edit this page"). Pages whose URL ends in `.html` show the ✎ automatically. The first `Cmd+S` saves straight to `~/Downloads/` and the toast tells you the exact path.

Stuck on a step? Click the extension's **toolbar icon** (🧩 → HTML Studio) — the self-check page verifies "extension loaded / file-URL access / native host connectivity" live and tells you exactly what to fix. Command-line equivalent: `python3 extension/install.py --check`.

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

- Touches only `.html / .htm / .xhtml` inside `$HOME`; any path containing a hidden directory is refused (this includes web-page saves)
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
- **Saving a web page** keeps `data:` images as-is (`blob:` images can't survive a save — export them first) and cannot reach into cross-origin iframes
- **Deleting a page** just removes that block from the HTML; if a deck drives paging from a JS array, double-check the paging afterwards (don't save — a reload brings the page back)
- **Dragging only reorders siblings**: blocks are inserted before/after a target, never inside a paragraph; to move something into another container, drop it between that container's children

## Platforms

macOS is fully supported. Linux uses the same logic but hasn't been tested on real hardware. The extension on Windows is experimental (registry + `.cmd` launcher); the web app works on all three. Details in the [FAQ](docs/FAQ.md) (Chinese).

## Development

```bash
python3 tests/e2e_chrome.py      # real Chrome + real native messaging, 39 end-to-end assertions
```

One pipeline: `content.js` (injects the editing bar, shadow DOM isolated from page styles) → `background.js` (forwards messages — content scripts can't call `sendNativeMessage` directly) → `native_host.py` (validates and reads/writes files). After changing extension code, click "Reload" in `chrome://extensions`.

Run `tests/e2e_chrome.py` before opening a PR — it covers saving, backups, rollback and path validation.

## License

MIT
