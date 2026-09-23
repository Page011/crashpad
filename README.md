# crashpad

A Dynamic-Island-style scratchpad on the edge of your screen (Windows 11).
Slam the mouse into it (keep pushing past the edge; just resting there does nothing) or press
**Alt+C**, and it springs open with:

- **Clipboard**: a real clipboard manager. It keeps text, images and files across restarts, has pinned clips,
  and clicking a clip pastes it straight into the window you were in. Copies from password managers are skipped.
- **Notes**: a folder of markdown notes with a live editor. Type `[] ` for a checkbox, `- ` for bullets,
  `1. ` for a numbered list, and `# ` for a heading. Draw sketches with a pen. The sidebar lists every note, with pinned ones on top.
- **Shots**: your screenshots folder as big previews in a grid (scroll down) or a row (scroll across).
  Click to copy, right-click for Quick Look, drag to pull the file into any app.
- **Reminders**: type it how you'd say it ("call mom in 10 minutes", "dentist friday 3pm"). When one is due, the
  island shows an alert with Done / Snooze.
- **Shelf**: shake a file you're dragging and the island pops open. Drop files there to park them, then drag
  them out into any app later, copy them, or zip them (the zip lands in Downloads).
- **Live**: what's playing (with controls), countdown timers ("tea 10 min"), CPU / memory / GPU / disk / network
  / battery, your PC's specs, and the next reminders. While the panel is collapsed the pill shows the live bit
  that matters: a running timer, the music playing, or a reminder coming up within the hour.
- **Settings**:
  - Theme presets.
  - Opaque, translucent, frosted or liquid-glass materials.
  - Dock styles: pill, notch, fade, line, dot or invisible, on any edge or corner.
  - Animation styles and your hotkey.

Press ⤢ (or F11) to pop the panel out into a big floating window you can drag and resize. The pin button
(Ctrl+Shift+P) keeps the docked panel open until you close it yourself. Right-click clips, notes, reminders
and shelf items for a menu (on screenshots, right-click is Quick Look). Settings → "Open to" can be a fixed
tab or the last one used.
Left and right docks get a vertical layout.

## Run

```sh
cargo run --release
```

Needs Rust and the WebView2 runtime (preinstalled on Windows 11). `target/release/crashpad.exe` is the whole app.
Config: `%APPDATA%\com.crashpad.app\config.json`. Notes: `Documents\crashpad\*.md`.
Clipboard history and reminders: `%APPDATA%\com.crashpad.app\`.

## Keys

| Key | Where | Does |
|---|---|---|
| Alt+C | anywhere | open and focus / close (configurable) |
| Esc | panel | close and hand focus back |
| Ctrl+1…7, Ctrl+Tab | panel | switch tab |
| F11 | panel | pop out / dock back |
| Ctrl+Shift+P | docked panel | pin open / unpin |
| type, ↑↓, Enter, Shift+Enter, Ctrl+P, Shift+Del | Clipboard | search, pick, paste, copy only, pin, delete |
| Ctrl+N, Ctrl+Shift+L / 8 / 7, Ctrl+Shift+D, Ctrl+B/I/U | Notes | new note, checklist / bullets / numbers, draw, format |
| arrows, Enter, Space, O, R, S, Ctrl+V | Shots | pick, copy, Quick Look, open, reveal, snip, save pasted image |
| type, Enter, Space, S, Delete | Reminders | add, edit, done, snooze 10 min, delete |
| arrows, Space, Ctrl+A, Ctrl+C, Z, Enter, R, Delete | Shelf | select, copy, zip, open, reveal, remove |
| digits/type, Enter, ↑↓, Space, Delete | Live | new timer, pause/resume, remove |

Frosted and liquid glass work by capturing what's behind the panel, so while they're on crashpad hides itself from
screenshots and screen shares. Opaque and translucent don't do this.
