//! Quick capture: a global hotkey opens a one-line bar on the island; what's typed lands in the
//! Inbox note (or becomes a reminder / timer). The bar itself is ui/palette.js.

use super::*;

/// The capture hotkey was pressed: open focused and tell the page to show the bar.
pub(crate) fn show(app: &AppHandle) {
    let w = main_window(app);
    if w.is_minimized().unwrap_or(false) {
        let _ = w.unminimize(); // a minimized pop-out: set_focus ignores iconic windows
    }
    let _ = app.emit("capture", ()); // first, so the page opens straight into the bar
    set_open(app, true, true);
}

/// `old` (Inbox.md's text, "" if new) with `item` appended as a list item: a "# Inbox" heading
/// if there's nothing yet, the file's BOM and line endings kept, extra lines indented under the item.
fn inbox_text(old: &str, item: &str) -> String {
    let nl = if old.contains("\r\n") { "\r\n" } else { "\n" };
    let (bom, body) = old.strip_prefix('\u{feff}').map_or(("", old), |b| ("\u{feff}", b));
    let mut out = String::from(bom);
    if body.trim().is_empty() {
        out += &format!("# Inbox{nl}{nl}");
    } else {
        out += body;
        if !body.ends_with('\n') {
            out += nl;
        }
    }
    let lines: Vec<String> = item
        .lines()
        .map(|l| match l.trim_end() {
            "" => String::new(),
            l => format!("  {l}"),
        })
        .collect();
    out += "- ";
    out += lines.join(nl).trim_start();
    out += nl;
    out
}

/// Append a line to Inbox.md in the notes folder (created if missing). Returns the note's file name.
#[tauri::command]
pub async fn append_inbox(app: AppHandle, text: String) -> Res<String> {
    static ONE: Mutex<()> = Mutex::new(()); // read-modify-write: two quick captures mustn't drop one
    let text = text.trim();
    if text.is_empty() {
        return Err("Nothing to add".into());
    }
    let dir = notes::notes_dir(&app);
    let _one = ONE.lock().unwrap();
    fs::create_dir_all(&dir).map_err(err)?;
    // an existing "inbox.md" keeps its spelling (the rename in write_atomic would recase it)
    let name = fs::read_dir(&dir)
        .map_err(err)?
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .find(|n| n.eq_ignore_ascii_case("Inbox.md"))
        .unwrap_or_else(|| "Inbox.md".into());
    let path = dir.join(&name);
    let old = match fs::read(&path) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Vec::new(),
        r => r.map_err(err)?,
    };
    let old = String::from_utf8(old).map_err(|_| format!("{name} isn't UTF-8 text, so nothing was added to it"))?;
    write_atomic(&path, inbox_text(&old, text)).map_err(err)?;
    Ok(name)
}

#[cfg(test)]
mod tests {
    use super::inbox_text;

    #[test]
    fn inbox_items() {
        assert_eq!(inbox_text("", "buy milk"), "# Inbox\n\n- buy milk\n");
        assert_eq!(inbox_text("\u{feff}", "x"), "\u{feff}# Inbox\n\n- x\n");
        assert_eq!(inbox_text("# Inbox\n\n- a", "b"), "# Inbox\n\n- a\n- b\n");
        assert_eq!(
            inbox_text("\u{feff}# Inbox\r\n\r\n- a\r\n", "one\r\ntwo  \n\nthree"),
            "\u{feff}# Inbox\r\n\r\n- a\r\n- one\r\n  two\r\n\r\n  three\r\n"
        );
    }
}
