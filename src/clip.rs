//! Clipboard history: text, images and file lists; pinned clips; kept across restarts.

use super::*;
use std::hash::{DefaultHasher, Hash, Hasher};

/// One clipboard history entry. `kind` is "text" | "image" | "files".
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Clip {
    pub id: u64,
    pub kind: String,
    /// The text; for images "width × height".
    pub text: String,
    /// Absolute paths (kind "files").
    pub files: Vec<String>,
    /// Absolute path of the saved PNG (kind "image").
    pub image: String,
    pub pinned: bool,
    /// ms since the Unix epoch when it was (last) copied.
    pub time: u64,
}

/// Bigger images aren't recorded (a 40 MP RGBA picture is already 160 MB in memory).
const MAX_PIXELS: u64 = 40_000_000;

/// Folder holding image clips as PNGs.
pub(crate) fn images_dir(app: &AppHandle) -> PathBuf {
    data_dir(app).join("clips")
}

fn history_path(app: &AppHandle) -> PathBuf {
    data_dir(app).join("clips.json")
}

// ---------- history ----------

/// Same content, whatever the id, pin and time.
fn same(a: &Clip, b: &Clip) -> bool {
    (&a.kind, &a.text, &a.files, &a.image) == (&b.kind, &b.text, &b.files, &b.image)
}

/// Put `clip` on top. A clip with the same content moves up instead (keeping its id and pin), so
/// copying something again, or our own clipboard writes, never duplicate. Returns what fell off.
fn push(clips: &mut Vec<Clip>, mut clip: Clip, max: usize) -> Vec<Clip> {
    match clips.iter().position(|c| same(c, &clip)) {
        Some(i) => {
            let old = clips.remove(i);
            (clip.id, clip.pinned) = (old.id, old.pinned);
        }
        None => clip.id = clips.iter().map(|c| c.id + 1).max().unwrap_or(0).max(now_ms()),
    }
    clips.insert(0, clip);
    evict(clips, max)
}

/// Keep the newest `max` unpinned clips; pinned ones never expire. Returns the rest.
fn evict(clips: &mut Vec<Clip>, max: usize) -> Vec<Clip> {
    let mut n = 0;
    clips
        .extract_if(.., |c| {
            !c.pinned && {
                n += 1;
                n > max
            }
        })
        .collect()
}

/// Change the history (`f` gets it and the limit, and returns the clips it dropped), then publish:
/// emit it, delete dropped image files, save.
// ponytail: emits and saves the whole list each time; send deltas if big histories of huge texts get slow.
fn edit(app: &AppHandle, f: impl FnOnce(&mut Vec<Clip>, usize) -> Vec<Clip>) {
    let st = app.state::<Pad>();
    let max = st.cfg.lock().unwrap().clipboard_max as usize;
    let gone = {
        let mut clips = st.clips.lock().unwrap();
        let gone = f(&mut clips, max);
        let _ = app.emit("clips", &*clips);
        gone
    };
    let dir = images_dir(app);
    for c in gone {
        // only files we made (the history file could have been edited by hand)
        if Path::new(&c.image).parent() == Some(dir.as_path()) {
            let _ = fs::remove_file(&c.image);
        }
    }
    save(app);
}

/// Record a clip as just copied.
fn add(app: &AppHandle, clip: Clip) {
    edit(app, |clips, max| push(clips, Clip { time: now_ms(), ..clip }, max));
}

/// Write the history to disk off the calling thread, or delete it when history isn't kept. Writes
/// are serialized and each takes the latest list, so the file always ends up current.
fn save(app: &AppHandle) {
    static SAVING: Mutex<()> = Mutex::new(());
    let app = app.clone();
    thread::spawn(move || {
        let _one = SAVING.lock().unwrap();
        let (st, path) = (app.state::<Pad>(), history_path(&app));
        if !st.cfg.lock().unwrap().clip_persist {
            let _ = fs::remove_file(path);
            return;
        }
        let Ok(json) = serde_json::to_vec(&*st.clips.lock().unwrap()) else { return };
        if let Err(e) = write_atomic(&path, json) {
            eprintln!("crashpad: can't save clipboard history: {e}");
        }
    });
}

/// Load the saved history at startup (if it's kept) and delete image files nothing refers to.
pub(crate) fn load(app: &AppHandle) {
    let st = app.state::<Pad>();
    let (path, dir) = (history_path(app), images_dir(app));
    let (persist, max) = {
        let c = st.cfg.lock().unwrap();
        (c.clip_persist, c.clipboard_max as usize)
    };
    let mut clips: Vec<Clip> = match fs::read(&path) {
        Ok(bytes) if persist => match serde_json::from_slice(&bytes) {
            Ok(clips) => clips,
            Err(e) => {
                eprintln!("crashpad: unreadable clipboard history ({e}); kept a copy as clips.json.bad");
                let _ = fs::copy(&path, path.with_extension("json.bad"));
                return; // its images stay, in case the file gets repaired
            }
        },
        _ => Vec::new(),
    };
    let ours = |p: &str| Path::new(p).parent() == Some(dir.as_path());
    clips.retain(|c| c.kind != "image" || (ours(&c.image) && Path::new(&c.image).is_file()));
    evict(&mut clips, max);
    for e in fs::read_dir(&dir).into_iter().flatten().flatten() {
        if !clips.iter().any(|c| Path::new(&c.image) == e.path()) {
            let _ = fs::remove_file(e.path());
        }
    }
    *st.clips.lock().unwrap() = clips;
}

/// Apply the settings now: the history limit, and keeping (or deleting) the saved file.
pub(crate) fn trim(app: &AppHandle) {
    edit(app, evict);
}

// ---------- watching the clipboard ----------

/// True when the clipboard owner (password managers etc.) asked monitors to skip this content.
/// The caller must hold the clipboard open.
fn clipboard_private() -> bool {
    use clipboard_win::{is_format_avail, raw, register_format};
    let has = |name: &str| register_format(name).is_some_and(|f| is_format_avail(f.get()));
    if has("ExcludeClipboardContentFromMonitorProcessing") || has("Clipboard Viewer Ignore") {
        return true;
    }
    let Some(f) = register_format("CanIncludeInClipboardHistory") else { return false };
    if !is_format_avail(f.get()) {
        return false;
    }
    let mut buf = [0u8; 4];
    !matches!(raw::get(f.get(), &mut buf), Ok(4) if u32::from_ne_bytes(buf) != 0)
}

enum Content {
    Files(Vec<String>),
    Text(String),
    /// PNG or BMP file bytes.
    Image(Vec<u8>),
}

/// Read what's on the clipboard (held open by the caller): files, else text, else an image.
fn read_clipboard() -> Option<Content> {
    use clipboard_win::{formats::*, get, is_format_avail, raw, register_format, size};
    if is_format_avail(CF_HDROP)
        && let Ok(files) = get::<Vec<String>, _>(FileList)
        && !files.is_empty()
    {
        return Some(Content::Files(files));
    }
    if let Ok(text) = get::<String, _>(Unicode) {
        if text.len() > 1 << 20 {
            return None;
        }
        if !text.trim().is_empty() {
            return Some(Content::Text(text));
        }
    }
    // PNG first: it keeps transparency (browsers, Office and our own image writes offer it)
    let png = register_format("PNG").map(|f| f.get()).filter(|&f| is_format_avail(f));
    let fmt = png.unwrap_or(CF_DIB);
    if !is_format_avail(fmt) || size(fmt).is_some_and(|n| n.get() as u64 > MAX_PIXELS * 4 + (1 << 20)) {
        return None;
    }
    let bytes = match png {
        Some(f) => {
            let mut v = Vec::new();
            raw::get_vec(f, &mut v).ok()?;
            v
        }
        None => get::<Vec<u8>, _>(Bitmap).ok()?, // CF_BITMAP as BMP file bytes
    };
    Some(Content::Image(bytes))
}

/// Decode clipboard image bytes and keep them as `images_dir/<pixel hash>.png`, so the same
/// picture copied again (or our own write of it) is the same clip.
// ponytail: DefaultHasher may change across Rust releases; then an old image clip can reappear once.
fn store_image(app: &AppHandle, bytes: &[u8]) -> Option<Clip> {
    let reader = || image::ImageReader::new(io::Cursor::new(bytes)).with_guessed_format().ok();
    let (w, h) = reader()?.into_dimensions().ok()?;
    if w as u64 * h as u64 > MAX_PIXELS {
        return None;
    }
    let img = reader()?.decode().ok()?.into_rgba8();
    let mut hash = DefaultHasher::new();
    (w, h, img.as_raw()).hash(&mut hash);
    let path = images_dir(app).join(format!("{:016x}.png", hash.finish()));
    if !path.is_file() {
        let mut png = io::Cursor::new(Vec::new());
        img.write_to(&mut png, image::ImageFormat::Png).ok()?;
        write_atomic(&path, png.into_inner()).ok()?;
    }
    let image = path.to_string_lossy().into();
    Some(Clip { kind: "image".into(), text: format!("{w} × {h}"), image, ..Default::default() })
}

pub(crate) fn watch_clipboard(app: AppHandle) {
    let mut last = clipboard_win::seq_num();
    loop {
        thread::sleep(Duration::from_millis(300));
        let now = clipboard_win::seq_num();
        if now == last {
            continue;
        }
        last = now;
        // check privacy and read in one open session, so a password manager can't slip its text
        // in between (seq_num moves at EmptyClipboard, before the privacy format is set)
        let content = {
            let Ok(_open) = clipboard_win::Clipboard::new_attempts(10) else {
                last = None; // someone else holds it; retry next tick
                continue;
            };
            if clipboard_private() {
                continue;
            }
            read_clipboard()
        }; // closed again before the slow part (decoding, saving)
        let clip = match content {
            Some(Content::Files(files)) => Clip { kind: "files".into(), files, ..Default::default() },
            Some(Content::Text(text)) => Clip { kind: "text".into(), text, ..Default::default() },
            Some(Content::Image(bytes)) => match store_image(&app, &bytes) {
                Some(clip) => clip,
                None => continue,
            },
            None => continue,
        };
        add(&app, clip);
    }
}

// ---------- pasting ----------

/// Put a clip on the system clipboard.
fn put(clip: &Clip) -> Res<()> {
    match clip.kind.as_str() {
        "image" => {
            let img = image::open(&clip.image).map_err(err)?.into_rgba8();
            let (w, h) = img.dimensions();
            let data = arboard::ImageData { width: w as usize, height: h as usize, bytes: img.into_raw().into() };
            arboard::Clipboard::new().and_then(|mut c| c.set_image(data)).map_err(err)
        }
        "files" => {
            if !clip.files.iter().any(|f| Path::new(f).exists()) {
                return Err("Those files no longer exist".into());
            }
            let _open = clipboard_win::Clipboard::new_attempts(10).map_err(err)?;
            clipboard_win::raw::set_file_list_with(&clip.files, clipboard_win::options::DoClear).map_err(err)
        }
        _ => clipboard_win::set_clipboard_string(&clip.text).map_err(err),
    }
}

/// Ctrl+V into the foreground window, first letting go of modifiers still held (Shift from a
/// Shift+click, say), which would turn it into another shortcut.
fn send_ctrl_v() {
    use windows::Win32::UI::Input::KeyboardAndMouse::*;
    let key = |vk: VIRTUAL_KEY, up: bool| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: unsafe { MapVirtualKeyW(vk.0 as u32, MAPVK_VK_TO_VSC) } as u16,
                dwFlags: if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) },
                ..Default::default()
            },
        },
    };
    let mut keys = vec![key(VK_CONTROL, false)]; // first, so a lone Alt/Win release opens no menu
    for vk in [VK_LSHIFT, VK_RSHIFT, VK_LMENU, VK_RMENU, VK_LWIN, VK_RWIN] {
        if unsafe { GetAsyncKeyState(vk.0 as i32) } < 0 {
            keys.push(key(vk, true));
        }
    }
    keys.extend([key(VK_V, false), key(VK_V, true), key(VK_CONTROL, true)]);
    unsafe { SendInput(&keys, std::mem::size_of::<INPUT>() as i32) };
}

/// Once the window the user came from is in front again, paste into it. Never into crashpad, and
/// not into the desktop focus fell back to because that window is gone (it would get files).
fn paste_back(app: &AppHandle) {
    let missed = || {
        let _ = app.emit("notice", "Copied. Couldn't get back to your window, so press Ctrl+V there.");
    };
    let t = Instant::now();
    while foreground() == 0 || focused(app) {
        if t.elapsed() > Duration::from_millis(500) {
            return missed();
        }
        thread::sleep(Duration::from_millis(15));
    }
    thread::sleep(Duration::from_millis(40)); // let it finish activating, or keys land mid-switch
    let (fg, prev) = (foreground(), app.state::<Pad>().prev_window.load(Relaxed));
    let shell = unsafe { windows::Win32::UI::WindowsAndMessaging::GetShellWindow() }.0 as isize;
    if fg == 0 || focused(app) || (fg == shell && fg != prev) {
        return missed();
    }
    send_ctrl_v();
}

// ---------- commands ----------

#[tauri::command]
pub fn get_clips(st: State<Pad>) -> Vec<Clip> {
    st.clips.lock().unwrap().clone()
}

/// Put a clip back on the clipboard (and on top of the history); with `paste`, also close the
/// panel and paste it into the window that was in front before (Ctrl+V). Async so decoding a big
/// image doesn't stall the main thread.
#[tauri::command]
pub async fn use_clip(app: AppHandle, id: u64, paste: bool) -> Res<()> {
    let clip = app.state::<Pad>().clips.lock().unwrap().iter().find(|c| c.id == id).cloned();
    let clip = clip.ok_or("That clip is gone")?;
    put(&clip)?;
    add(&app, clip);
    if paste {
        let a = app.clone();
        let _ = app.run_on_main_thread(move || {
            if a.state::<Pad>().detached.load(Relaxed) {
                hand_focus_back(&a);
            } else {
                set_open(&a, false, false);
            }
        });
        thread::spawn(move || paste_back(&app));
    }
    Ok(())
}

/// Copy text (e.g. dropped text or paths) and record it.
#[tauri::command]
pub fn copy_text(app: AppHandle, text: String) -> Res<()> {
    clipboard_win::set_clipboard_string(&text).map_err(err)?;
    add(&app, Clip { kind: "text".into(), text, ..Default::default() });
    Ok(())
}

#[tauri::command]
pub fn pin_clip(app: AppHandle, id: u64, pinned: bool) -> Res<()> {
    edit(&app, |clips, max| {
        clips.iter_mut().filter(|c| c.id == id).for_each(|c| c.pinned = pinned);
        evict(clips, max) // unpinning can take the history over the limit
    });
    Ok(())
}

#[tauri::command]
pub fn remove_clip(app: AppHandle, id: u64) -> Res<()> {
    edit(&app, |clips, _| clips.extract_if(.., |c| c.id == id).collect());
    Ok(())
}

/// Remove every clip except pinned ones.
#[tauri::command]
pub fn clear_clips(app: AppHandle) -> Res<()> {
    edit(&app, |clips, _| clips.extract_if(.., |c| !c.pinned).collect());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_dedupes_and_keeps_pinned() {
        let text = |t: &str| Clip { kind: "text".into(), text: t.into(), ..Default::default() };
        let texts = |c: &[Clip]| c.iter().map(|c| c.text.clone()).collect::<Vec<_>>();
        let mut clips = Vec::new();
        for t in ["a", "b", "c"] {
            assert!(push(&mut clips, text(t), 3).is_empty());
        }
        let b = clips[1].id;
        clips[1].pinned = true;
        // copying "b" again moves it up with its id and pin, no duplicate
        push(&mut clips, Clip { time: 7, ..text("b") }, 3);
        assert_eq!(texts(&clips), ["b", "c", "a"]);
        assert_eq!((clips[0].id, clips[0].pinned, clips[0].time), (b, true, 7));
        // same text as a file list is a different clip; the oldest unpinned falls off, pinned stay
        let files = Clip { kind: "files".into(), files: vec!["C:\\b".into()], ..Default::default() };
        let gone = push(&mut clips, files, 2);
        assert_eq!(texts(&gone), ["a"]);
        let gone = push(&mut clips, text("d"), 1);
        assert_eq!((texts(&clips), texts(&gone)), (vec!["d".to_string(), "b".into()], vec!["".to_string(), "c".into()]));
    }
}
