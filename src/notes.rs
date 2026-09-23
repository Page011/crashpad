//! Notes: a folder of markdown files (cfg.notes_dir) plus their attachments (pasted images, sketches).
//! File I/O commands are async so disk flushes never stall the window's event loop.

use super::*;

// ---------- helpers ----------

/// The notes folder (cfg.notes_dir).
pub(crate) fn notes_dir(app: &AppHandle) -> PathBuf {
    PathBuf::from(&app.state::<Pad>().cfg.lock().unwrap().notes_dir)
}

/// A bare `*.md` file name; the page may only name notes, never paths or other files.
fn md_name(name: &str) -> Res<&Path> {
    let n = bare_name(name)?;
    match n.extension() {
        Some(e) if e.eq_ignore_ascii_case("md") => Ok(n),
        _ => Err(format!("Not a note: {name}")),
    }
}

fn ms(t: io::Result<SystemTime>) -> u64 {
    t.ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64)
}

/// Change the config from Rust (pins, renames) and persist it.
fn edit_cfg(app: &AppHandle, f: impl FnOnce(&mut Config)) -> Res<()> {
    f(&mut app.state::<Pad>().cfg.lock().unwrap());
    save_config(app)
}

/// One markdown line as plain text: block markers (#, >, -, *, +, 1., [ ]), inline markers,
/// link targets and backslash escapes removed.
fn plain(line: &str) -> String {
    let mut s = line.trim();
    if s.len() >= 3 && s.chars().all(|c| "-*_ ".contains(c)) {
        return String::new(); // a divider
    }
    loop {
        let spaced = |r: &str| r.is_empty() || r.starts_with(' ');
        let digits = s.len() - s.trim_start_matches(|c: char| c.is_ascii_digit()).len();
        let rest = if let Some(r) = s.strip_prefix('>') {
            r
        } else if let Some(r) = s.strip_prefix(['-', '*', '+']).filter(|r| spaced(r)) {
            r
        } else if let Some(r) = Some(s.trim_start_matches('#')).filter(|r| r.len() < s.len() && spaced(r)) {
            r
        } else if let Some(r) = ["[ ]", "[x]", "[X]"].iter().find_map(|m| s.strip_prefix(m)) {
            r
        } else if let Some(r) = s[digits..].strip_prefix(['.', ')']).filter(|r| digits > 0 && spaced(r)) {
            r
        } else {
            break;
        };
        s = rest.trim_start();
    }
    // [text](target) and ![alt](target) keep only the text
    let mut out = String::new();
    let mut rest = s;
    while let Some(i) = rest.find('[') {
        out.push_str(rest[..i].strip_suffix('!').unwrap_or(&rest[..i]));
        let after = &rest[i + 1..];
        match after.find("](").and_then(|j| after[j + 2..].find(')').map(|k| (j, j + 2 + k + 1))) {
            Some((j, end)) => {
                out.push_str(&after[..j]);
                rest = &after[end..];
            }
            None => {
                out.push('[');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    let out = out.replace("<u>", "").replace("</u>", "").replace("&nbsp;", " ");
    let mut text = String::new();
    let mut chars = out.chars();
    while let Some(c) = chars.next() {
        match c {
            '\\' => text.extend(chars.next()),
            '*' | '~' | '`' => {}
            c => text.push(c),
        }
    }
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// A file's text without the UTF-8 byte order mark some Windows tools write.
fn unbom(s: &str) -> &str {
    s.strip_prefix('\u{feff}').unwrap_or(s)
}

/// Byte length of a leading YAML front matter block (`---` line … `---`/`...` line), 0 if none.
/// It's metadata for other tools: never shown as editable text, never a title.
fn front_matter(text: &str) -> usize {
    let mut at = 0;
    for (i, l) in text.split_inclusive('\n').enumerate() {
        at += l.len();
        match (i, l.trim_end()) {
            (0, "---") => {}
            (0, _) => return 0,
            (_, "---" | "...") => return at,
            _ => {}
        }
    }
    0
}

/// A note's title (first non-empty line, as plain text) and snippet (~90 chars of what follows).
fn summarize(text: &str) -> (String, String) {
    let mut lines = text[front_matter(text)..].lines().map(plain).filter(|l| !l.is_empty());
    let title = lines.next().unwrap_or_default();
    let mut snippet = String::new();
    for l in lines {
        if snippet.len() > 90 * 4 {
            break;
        }
        if !snippet.is_empty() {
            snippet.push(' ');
        }
        snippet.push_str(&l);
    }
    (title, snippet.chars().take(90).collect())
}

fn count_words(text: &str) -> usize {
    text.split_whitespace().filter(|w| w.chars().any(char::is_alphanumeric)).count()
}

/// File stem for a note titled `title`: no characters Windows forbids, ≤ 60 chars, never empty
/// or a reserved device name.
fn file_stem(title: &str) -> String {
    let edge = |c: char| c == '.' || c.is_whitespace();
    let s: String = title.chars().filter(|c| !c.is_control() && !r#"<>:"/\|?*"#.contains(*c)).collect();
    let s: String = s.trim_matches(edge).chars().take(60).collect();
    let s = s.trim_matches(edge);
    let base = s.split('.').next().unwrap_or("").trim().to_ascii_uppercase();
    let device = matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (base.len() == 4 && (base.starts_with("COM") || base.starts_with("LPT")) && base.as_bytes()[3].is_ascii_digit());
    match s {
        "" => "Untitled".into(),
        s if device => format!("_{s}"),
        s => s.into(),
    }
}

/// `name` is already `stem.md` or a `stem (n).md` duplicate of it.
fn named_for(name: &str, stem: &str) -> bool {
    name == format!("{stem}.md")
        || name
            .strip_prefix(stem)
            .and_then(|r| r.strip_prefix(" ("))
            .and_then(|r| r.strip_suffix(").md"))
            .is_some_and(|n| n.parse::<u32>().is_ok())
}

// ---------- commands: notes ----------

/// A note in the list. `name` is the file name (e.g. "Groceries.md") and is the note's id.
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct NoteMeta {
    pub name: String,
    pub title: String,
    pub snippet: String,
    pub modified: u64,
    pub created: u64,
    pub words: usize,
    pub pinned: bool,
    /// Whole markdown, for the list's full-text search.
    pub text: String,
}

/// A note's contents plus where it was read from (the page echoes `dir` back when saving).
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct NoteFile {
    pub dir: String,
    pub name: String,
    pub text: String,
}

/// Every `*.md` directly in the notes folder: pinned first, then most recently modified.
#[tauri::command]
pub async fn list_notes(app: AppHandle) -> Res<Vec<NoteMeta>> {
    let dir = notes_dir(&app);
    fs::create_dir_all(&dir).map_err(err)?;
    let pinned = app.state::<Pad>().cfg.lock().unwrap().pinned_notes.clone();
    // ponytail: reads every note per listing (and ships the text for search); index if folders get huge
    let mut notes: Vec<NoteMeta> = fs::read_dir(&dir)
        .map_err(err)?
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let meta = e.metadata().ok()?;
            if !meta.is_file() || md_name(&name).is_err() {
                return None;
            }
            let text = unbom(&String::from_utf8_lossy(&fs::read(e.path()).ok()?)).to_owned();
            let (title, snippet) = summarize(&text);
            Some(NoteMeta {
                pinned: pinned.contains(&name),
                title,
                snippet,
                modified: ms(meta.modified()),
                created: ms(meta.created()),
                words: count_words(&text[front_matter(&text)..]),
                text,
                name,
            })
        })
        .collect();
    notes.sort_by_key(|n| (!n.pinned, std::cmp::Reverse(n.modified)));
    Ok(notes)
}

/// A note's text; a missing file reads as empty (a note that was never typed into).
#[tauri::command]
pub async fn read_note(app: AppHandle, name: String) -> Res<NoteFile> {
    let dir = app.state::<Pad>().cfg.lock().unwrap().notes_dir.clone();
    let text = match fs::read_to_string(Path::new(&dir).join(md_name(&name)?)) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => String::new(),
        r => unbom(&r.map_err(err)?).to_owned(),
    };
    Ok(NoteFile { dir, name, text })
}

/// Save a note. `dir` is where the page read it from: if the notes folder changed since, the save
/// is refused so a stale buffer can never land in another folder. `base` is the text the page's
/// buffer started from: if the file changed on disk since (edited in another app), the save is
/// refused rather than overwrite that edit. A byte order mark the file had is kept.
#[tauri::command]
pub async fn write_note(app: AppHandle, dir: String, name: String, text: String, base: String) -> Res<()> {
    if dir != app.state::<Pad>().cfg.lock().unwrap().notes_dir {
        return Err("The notes folder changed, so this note wasn't saved there. Reopen it.".into());
    }
    let path = Path::new(&dir).join(md_name(&name)?);
    let disk = match fs::read(&path) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Vec::new(),
        r => r.map_err(err)?,
    };
    let disk = String::from_utf8_lossy(&disk);
    if unbom(&disk) != base && unbom(&disk) != text {
        return Err("This note was changed in another app, so it wasn't saved over.".into());
    }
    let bom = if disk.starts_with('\u{feff}') { "\u{feff}" } else { "" };
    write_atomic(&path, format!("{bom}{text}")).map_err(err)
}

/// A new empty note file; returns its name.
#[tauri::command]
pub async fn create_note(app: AppHandle) -> Res<String> {
    let dir = notes_dir(&app);
    fs::create_dir_all(&dir).map_err(err)?;
    let path = unique_path(&dir, "Untitled.md");
    fs::OpenOptions::new().write(true).create_new(true).open(&path).map_err(err)?;
    Ok(path.file_name().unwrap_or_default().to_string_lossy().into())
}

/// Rename a note's file after its title (the first line of `title`, which may be markdown).
/// Returns the new name (unchanged when it already fits).
#[tauri::command]
pub async fn rename_note(app: AppHandle, name: String, title: String) -> Res<String> {
    let dir = notes_dir(&app);
    let old = dir.join(md_name(&name)?);
    let stem = file_stem(&summarize(&title).0);
    if named_for(&name, &stem) {
        return Ok(name);
    }
    let want = format!("{stem}.md");
    // only the case changed: rename in place (unique_path would see the file itself as taken)
    let new = if want.eq_ignore_ascii_case(&name) { dir.join(&want) } else { unique_path(&dir, &want) };
    fs::rename(&old, &new).map_err(err)?;
    let new_name: String = new.file_name().unwrap_or_default().to_string_lossy().into();
    edit_cfg(&app, |c| {
        for p in c.pinned_notes.iter_mut().filter(|p| **p == name) {
            *p = new_name.clone();
        }
        if c.last_note == name {
            c.last_note = new_name.clone();
        }
    })?;
    Ok(new_name)
}

/// Move a note into `.trash/` inside the notes folder (recoverable by hand).
#[tauri::command]
pub async fn delete_note(app: AppHandle, name: String) -> Res<()> {
    let dir = notes_dir(&app);
    let path = dir.join(md_name(&name)?);
    let trash = dir.join(".trash");
    fs::create_dir_all(&trash).map_err(err)?;
    match fs::rename(&path, unique_path(&trash, &name)) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        r => r.map_err(err)?,
    }
    edit_cfg(&app, |c| {
        c.pinned_notes.retain(|n| *n != name);
        if c.last_note == name {
            c.last_note.clear();
        }
    })
}

#[tauri::command]
pub async fn pin_note(app: AppHandle, name: String, pinned: bool) -> Res<()> {
    md_name(&name)?;
    edit_cfg(&app, |c| {
        c.pinned_notes.retain(|n| *n != name);
        if pinned {
            c.pinned_notes.push(name);
        }
    })
}

/// Save image bytes (raw IPC body) as a new file in `attachments/` (never over an existing one:
/// undo and other notes may still show it). Headers: `ext`; `prefix` = sketch | image.
/// Returns "attachments/<name>".
#[tauri::command]
pub async fn save_attachment(app: AppHandle, request: Request<'_>) -> Res<String> {
    let InvokeBody::Raw(bytes) = request.body() else { return Err("expected image bytes".into()) };
    let header = |k: &str| request.headers().get(k).and_then(|v| v.to_str().ok());
    let dir = notes_dir(&app).join("attachments");
    let ext = header("ext")
        .map(str::to_ascii_lowercase)
        .filter(|e| IMG_EXTS.contains(&e.as_str()))
        .unwrap_or_else(|| "png".into());
    let prefix = if header("prefix") == Some("sketch") { "sketch" } else { "image" };
    fs::create_dir_all(&dir).map_err(err)?;
    let path = unique_path(&dir, &format!("{prefix}-{}.{ext}", now_ms()));
    write_atomic(&path, bytes).map_err(err)?;
    Ok(format!("attachments/{}", path.file_name().unwrap_or_default().to_string_lossy()))
}

/// Copy dropped image files into `attachments/`: "attachments/<name>" per path, "" for non-images.
#[tauri::command]
pub async fn import_to_notes(app: AppHandle, paths: Vec<PathBuf>) -> Res<Vec<String>> {
    let dir = notes_dir(&app).join("attachments");
    fs::create_dir_all(&dir).map_err(err)?;
    paths
        .iter()
        .map(|p| {
            let Some(name) = p.file_name().filter(|_| p.is_file() && is_image(p)) else { return Ok(String::new()) };
            let dest = if p.parent() == Some(dir.as_path()) {
                p.clone() // already one of ours
            } else {
                let dest = unique_path(&dir, &name.to_string_lossy());
                fs::copy(p, &dest).map_err(err)?;
                dest
            };
            Ok(format!("attachments/{}", dest.file_name().unwrap_or_default().to_string_lossy()))
        })
        .collect()
}

#[tauri::command]
pub async fn open_notes_dir(app: AppHandle) -> Res<()> {
    let dir = notes_dir(&app);
    fs::create_dir_all(&dir).map_err(err)?;
    open_path(&app, &dir)
}

fn escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// Source the editor can't edit (raw HTML, front matter): shown inert, saved back verbatim.
fn raw(tag: &str, src: &str) -> String {
    format!("<{tag} class=\"raw\" contenteditable=\"false\">{}</{tag}>", escape(src))
}

/// Markdown to HTML for the editor. Raw HTML and front matter become inert `.raw` elements that
/// carry their source (bar `<u>`/`</u>`, which the editor writes for underline), a fenced code
/// block's full info string rides along as `data-info`, and script URLs are neutered (the page
/// has IPC access).
#[tauri::command]
pub fn render_md(text: String) -> String {
    use pulldown_cmark::{CodeBlockKind, CowStr, Event, Options, Parser, Tag, TagEnd, html};
    let script = |u: &str| {
        let u = u.trim_start().to_ascii_lowercase();
        u.starts_with("javascript:") || u.starts_with("vbscript:") || u.starts_with("data:")
    };
    let fm = front_matter(&text);
    let mut out = if fm > 0 { raw("div", &text[..fm]) } else { String::new() };
    let opts = Options::ENABLE_TABLES | Options::ENABLE_TASKLISTS | Options::ENABLE_STRIKETHROUGH;
    let (mut block, mut in_image) = (String::new(), 0);
    let events = Parser::new_ext(&text[fm..], opts).filter_map(|ev| {
        Some(match ev {
            Event::Html(s) => {
                block.push_str(&s); // an HTML block's lines: shown as one element at its end
                return None;
            }
            Event::End(TagEnd::HtmlBlock) => Event::Html(raw("div", &std::mem::take(&mut block)).into()),
            Event::InlineHtml(s) if in_image > 0 || matches!(s.as_ref(), "<u>" | "</u>") => Event::InlineHtml(s),
            Event::InlineHtml(s) => Event::InlineHtml(raw("span", &s).into()),
            Event::Start(Tag::Image { .. }) | Event::End(TagEnd::Image) => {
                in_image += if matches!(ev, Event::Start(_)) { 1 } else { -1 };
                ev
            }
            Event::Start(Tag::CodeBlock(CodeBlockKind::Fenced(info))) if info.contains(' ') => {
                Event::Html(format!("<pre><code data-info=\"{}\">", escape(&info)).into())
            }
            Event::Start(Tag::Link { link_type, dest_url, title, id }) if script(&dest_url) => {
                Event::Start(Tag::Link { link_type, dest_url: CowStr::Borrowed("#"), title, id })
            }
            e => e,
        })
    });
    html::push_html(&mut out, events);
    out
}

/// Links clicked in a note: web links open in the browser, paths on a local drive are
/// revealed in Explorer (never executed). UNC paths are refused: even checking one sends the
/// user's NTLM credentials to that host.
#[tauri::command]
pub async fn open_link(app: AppHandle, url: String) -> Res<()> {
    let lower = url.to_ascii_lowercase();
    if ["http://", "https://", "mailto:"].iter().any(|s| lower.starts_with(s)) {
        return app.opener().open_url(url, None::<&str>).map_err(err);
    }
    use std::path::{Component, Prefix};
    let path = PathBuf::from(url.strip_prefix("file:///").unwrap_or(&url));
    let on_drive = matches!(path.components().next(), Some(Component::Prefix(p)) if matches!(p.kind(), Prefix::Disk(_)));
    if on_drive && path.exists() {
        return app.opener().reveal_item_in_dir(path).map_err(err);
    }
    Err(format!("Can't open {url}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_is_sanitized() {
        let html = render_md("<script>alert(1)</script>\n\n[x](javascript:alert(1))\n\n- [ ] task\n- [x] done".into());
        assert!(!html.contains("<script>") && !html.contains("javascript:"));
        assert_eq!(html.matches("type=\"checkbox\"").count(), 2);
        let raw = r#"<span class="raw" contenteditable="false">"#;
        assert!(render_md("a <u>b</u> <i>c</i>".into()).contains(&format!("<u>b</u> {raw}&lt;i&gt;</span>c{raw}&lt;/i&gt;</span>")));
        let html = render_md("<details>\n<b>x</b>\n\n![a <b>c</b>](p.png)".into());
        assert!(html.starts_with(r#"<div class="raw" contenteditable="false">&lt;details&gt;"#) && html.contains(r#"alt="a &lt;b&gt;c&lt;/b&gt;""#));
        assert!(render_md("```rust title=\"x\"\nfn\n```".into()).contains(r#"<code data-info="rust title=&quot;x&quot;">"#));
    }

    #[test]
    fn front_matter_and_bom() {
        let doc = "---\ntitle: Front\n---\n# Heading\n";
        assert_eq!(front_matter(doc), 21);
        assert_eq!(front_matter("---\r\na: 1\r\n...\r\nx"), 16);
        assert_eq!(front_matter("---\n---\n"), 8);
        assert_eq!(front_matter("---\nno end"), 0);
        assert_eq!(front_matter("--- x\n---\n"), 0);
        assert_eq!(summarize(doc).0, "Heading");
        assert!(render_md(doc.into()).starts_with(r#"<div class="raw" contenteditable="false">---"#));
        assert_eq!(unbom("\u{feff}# T"), "# T");
    }

    /// Round-trip harness: renders every text in the JSON array at $RT_IN the way the editor gets
    /// it (read_note then render_md) and writes [[text, html], ...] to $RT_OUT.
    #[test]
    #[ignore]
    fn render_fixtures() {
        let (Ok(i), Ok(o)) = (std::env::var("RT_IN"), std::env::var("RT_OUT")) else { return };
        let texts: Vec<String> = serde_json::from_str(&fs::read_to_string(i).unwrap()).unwrap();
        let out: Vec<[String; 2]> = texts.iter().map(|t| [unbom(t).into(), render_md(unbom(t).into())]).collect();
        fs::write(o, serde_json::to_string(&out).unwrap()).unwrap();
    }

    #[test]
    fn titles_and_snippets() {
        let (t, s) = summarize("\n\n## **Groceries** list\n- [ ] milk\n- [x] `eggs`\n\n---\n> see [shop](https://x.y)\n");
        assert_eq!((t.as_str(), s.as_str()), ("Groceries list", "milk eggs see shop"));
        assert_eq!(summarize("1. first\n![sketch](attachments/s.png)\n&nbsp;\nsnake_case \\*star\\*").0, "first");
        assert_eq!(summarize("1. first\n![sketch](attachments/s.png)\n&nbsp;\nsnake_case \\*x\\*").1, "sketch snake_case *x*");
        assert_eq!(summarize("-5 degrees").0, "-5 degrees");
        assert_eq!(summarize("").0, "");
        assert_eq!(summarize(&format!("t
{}", "word ".repeat(100))).1.chars().count(), 90);
        assert_eq!(count_words("- [ ] buy milk\n\n---"), 2);
    }

    #[test]
    fn file_names_from_titles() {
        assert_eq!(file_stem("  What? a/b: \"c\" <d>|e*  "), "What ab c de");
        assert_eq!(file_stem("..hidden.."), "hidden");
        assert_eq!(file_stem(" \t\u{7}"), "Untitled");
        assert_eq!(file_stem("con"), "_con");
        assert_eq!(file_stem("Com1.txt"), "_Com1.txt");
        assert_eq!(file_stem("Console"), "Console");
        assert_eq!(file_stem(&"x".repeat(80)).len(), 60);
        assert!(named_for("Untitled (3).md", "Untitled") && named_for("A.md", "A"));
        assert!(!named_for("A (x).md", "A") && !named_for("AB.md", "A"));
        assert!(md_name("a.MD").is_ok() && md_name("a.txt").is_err() && md_name("..\\a.md").is_err());
    }
}
