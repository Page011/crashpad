//! Screenshots folder.

use super::*;

// ---------- commands: screenshots ----------

pub(crate) fn shots_dir(app: &AppHandle) -> PathBuf {
    PathBuf::from(&app.state::<Pad>().cfg.lock().unwrap().screenshots_dir)
}

/// Resolve a bare file name inside the screenshots folder; rejects anything path-like.
pub(crate) fn shot_path(app: &AppHandle, name: &str) -> Res<PathBuf> {
    Ok(shots_dir(app).join(bare_name(name)?))
}

#[derive(Serialize)]
pub(crate) struct Shot {
    name: String,
    path: String,
    modified: u64,
}

#[tauri::command]
pub async fn list_shots(app: AppHandle) -> Res<Vec<Shot>> {
    let entries = match fs::read_dir(shots_dir(&app)) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(vec![]),
        r => r.map_err(err)?,
    };
    let mut shots: Vec<Shot> = entries
        .flatten()
        .filter_map(|e| {
            let (path, meta) = (e.path(), e.metadata().ok()?);
            if !meta.is_file() || !is_image(&path) {
                return None;
            }
            let modified = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64;
            Some(Shot { name: e.file_name().to_string_lossy().into(), path: path.to_string_lossy().into(), modified })
        })
        .collect();
    shots.sort_by_key(|s| std::cmp::Reverse(s.modified));
    shots.truncate(200); // ponytail: newest 200 only; page it if people hoard more
    Ok(shots)
}

#[tauri::command]
pub async fn copy_image(app: AppHandle, name: String) -> Res<()> {
    let img = image::open(shot_path(&app, &name)?).map_err(err)?.into_rgba8();
    let (w, h) = img.dimensions();
    let data = arboard::ImageData { width: w as usize, height: h as usize, bytes: img.into_raw().into() };
    arboard::Clipboard::new().and_then(|mut c| c.set_image(data)).map_err(err)
}

#[tauri::command]
pub async fn open_shot(app: AppHandle, name: String) -> Res<()> {
    open_path(&app, &shot_path(&app, &name)?)
}

#[tauri::command]
pub async fn reveal_shot(app: AppHandle, name: String) -> Res<()> {
    app.opener().reveal_item_in_dir(shot_path(&app, &name)?).map_err(err)
}

#[tauri::command]
pub async fn open_shots_dir(app: AppHandle) -> Res<()> {
    let dir = shots_dir(&app);
    fs::create_dir_all(&dir).map_err(err)?;
    open_path(&app, &dir)
}

/// Opens the Windows snipping overlay; Snipping Tool saves into Pictures\Screenshots by default.
#[tauri::command]
pub fn snip(app: AppHandle) -> Res<()> {
    app.opener().open_url("ms-screenclip:", None::<&str>).map_err(err)
}

/// Copy dropped image files into the screenshots folder. Returns how many were added.
#[tauri::command]
pub async fn import_files(app: AppHandle, paths: Vec<PathBuf>) -> Res<usize> {
    let dir = shots_dir(&app);
    fs::create_dir_all(&dir).map_err(err)?;
    let mut added = 0;
    for p in paths.iter().filter(|p| p.is_file() && is_image(p) && p.parent() != Some(dir.as_path())) {
        let Some(name) = p.file_name() else { continue };
        fs::copy(p, unique_path(&dir, &name.to_string_lossy())).map_err(err)?;
        added += 1;
    }
    Ok(added)
}

/// Save pasted image bytes (raw IPC body, `ext` header) into the screenshots folder.
#[tauri::command]
pub async fn save_image(app: AppHandle, request: Request<'_>) -> Res<String> {
    let InvokeBody::Raw(bytes) = request.body() else { return Err("expected image bytes".into()) };
    let ext = request
        .headers()
        .get("ext")
        .and_then(|v| v.to_str().ok())
        .map(str::to_ascii_lowercase)
        .filter(|e| IMG_EXTS.contains(&e.as_str()))
        .unwrap_or_else(|| "png".into());
    let dir = shots_dir(&app);
    fs::create_dir_all(&dir).map_err(err)?;
    let ms = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis());
    let path = unique_path(&dir, &format!("crashpad-{ms}.{ext}"));
    fs::write(&path, bytes).map_err(err)?;
    Ok(path.to_string_lossy().into())
}

/// Drag a screenshot out of the panel as a real file (into Explorer, chats, editors...).
/// Call while the mouse button is still down. Returns "dropped" or "cancel".
#[tauri::command]
pub async fn drag_shot(app: AppHandle, name: String) -> Res<String> {
    let path = shot_path(&app, &name)?;
    let preview = image::open(&path).map(preview_png).unwrap_or_default(); // no preview beats no drag
    drag_out(&app, vec![path], Some(preview))
}

/// Native drag-out of files (the Shelf uses it too). Call from an async command while the mouse
/// button is still down; `preview` is the PNG under the cursor (none: just the cursor).
/// Returns "dropped" or "cancel".
pub(crate) fn drag_out(app: &AppHandle, paths: Vec<PathBuf>, preview: Option<Vec<u8>>) -> Res<String> {
    let win = main_window(app);
    let (tx, rx) = std::sync::mpsc::channel();
    let st = app.state::<Pad>();
    st.dragging.store(true, Relaxed);
    // DoDragDrop runs a modal loop, so it goes through the event loop rather than running inside
    // WebView2's IPC handler (a sync command), where WebView2 forbids nested message loops.
    let started = app.run_on_main_thread(move || {
        let done = tx.clone();
        let on_drop = move |r, _| {
            let _ = done.send(Ok(matches!(r, drag::DragResult::Dropped)));
        };
        let files = drag::DragItem::Files(paths);
        let image = drag::Image::Raw(preview.unwrap_or_default()); // empty bytes: the crate skips the image
        if let Err(e) = drag::start_drag(&win, files, image, on_drop, Default::default()) {
            let _ = tx.send(Err(err(e)));
        }
    });
    // ponytail: blocks this async worker for the drag's length; one drag at a time, so fine
    let dropped = started.map_err(err).and_then(|_| rx.recv().unwrap_or_else(|_| Err("drag failed".into())));
    st.dragging.store(false, Relaxed);
    Ok(if dropped? { "dropped" } else { "cancel" }.into())
}

/// The OS drag image: the shot shrunk to fit 240 px, as PNG.
pub(crate) fn preview_png(img: image::DynamicImage) -> Vec<u8> {
    let img = if img.width() > 240 || img.height() > 240 { img.thumbnail(240, 240) } else { img };
    let mut png = io::Cursor::new(Vec::new());
    let _ = img.write_to(&mut png, image::ImageFormat::Png);
    png.into_inner()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drag_preview_fits_240() {
        let dims = |img| image::load_from_memory(&preview_png(img)).map(|i| (i.width(), i.height())).unwrap();
        assert_eq!(dims(image::DynamicImage::new_rgba8(1920, 1080)), (240, 135));
        assert_eq!(dims(image::DynamicImage::new_rgb8(50, 400)), (30, 240));
        assert_eq!(dims(image::DynamicImage::new_rgba8(100, 60)), (100, 60)); // small ones stay sharp
    }
}
