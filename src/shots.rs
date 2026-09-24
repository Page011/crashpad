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
    set_clipboard(image::open(shot_path(&app, &name)?).map_err(err)?.into_rgba8())
}

fn set_clipboard(img: image::RgbaImage) -> Res<()> {
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

/// Save a marked-up copy of a screenshot next to it as a new file. Body: the drawing as a
/// transparent PNG at the image's full size; `name` header: the original's file name. Rust
/// composites it (the page can't: asset images taint its canvas). Returns the new file name.
#[tauri::command]
pub async fn save_markup(app: AppHandle, request: Request<'_>) -> Res<String> {
    let (path, img) = marked_up(&app, &request)?;
    let stem = path.file_stem().unwrap_or_default().to_string_lossy();
    let out = unique_path(&shots_dir(&app), &format!("{stem} (marked).png"));
    img.save_with_format(&out, image::ImageFormat::Png).map_err(err)?;
    Ok(out.file_name().unwrap_or_default().to_string_lossy().into())
}

/// Same composite as save_markup, put on the clipboard as an image instead.
#[tauri::command]
pub async fn copy_markup(app: AppHandle, request: Request<'_>) -> Res<()> {
    set_clipboard(marked_up(&app, &request)?.1)
}

/// The screenshot named by the `name` header with the drawing in the raw body laid over it.
fn marked_up(app: &AppHandle, request: &Request) -> Res<(PathBuf, image::RgbaImage)> {
    let InvokeBody::Raw(png) = request.body() else { return Err("expected image bytes".into()) };
    let name = request.headers().get("name").and_then(|v| v.to_str().ok()).unwrap_or_default();
    let path = shot_path(app, &uri_decode(name))?;
    let mut img = upright(&path)?.into_rgba8();
    composite(&mut img, image::load_from_memory_with_format(png, image::ImageFormat::Png).map_err(err)?);
    Ok((path, img))
}

/// The shot the way the page drew on it: <img> honours EXIF rotation (phone photos), image::open doesn't.
fn upright(path: &Path) -> Res<image::DynamicImage> {
    let mut dec = image::ImageReader::open(path).map_err(err)?.into_decoder().map_err(err)?;
    image::Limits::default().reserve(image::ImageDecoder::total_bytes(&dec)).map_err(err)?; // image::open's 512 MB cap
    let turn = image::ImageDecoder::orientation(&mut dec).map_err(err)?;
    let mut img = image::DynamicImage::from_decoder(dec).map_err(err)?;
    img.apply_orientation(turn);
    Ok(img)
}

/// The page sends the name through encodeURIComponent: header values must be ASCII, file names needn't be.
fn uri_decode(s: &str) -> String {
    tauri::Url::parse(&format!("x:?{s}")).ok().and_then(|u| u.query_pairs().next().map(|(k, _)| k.into_owned())).unwrap_or_default()
}

/// Alpha-blend `overlay` onto `base`, stretched to fit first if the page capped its size.
fn composite(base: &mut image::RgbaImage, overlay: image::DynamicImage) {
    let (w, h) = base.dimensions();
    let opaque = base.pixels().all(|p| p[3] == 255);
    let top = if (overlay.width(), overlay.height()) == (w, h) { overlay } else { overlay.resize_exact(w, h, image::imageops::FilterType::Triangle) };
    image::imageops::overlay(base, &top.into_rgba8(), 0, 0);
    if opaque {
        base.pixels_mut().for_each(|p| p[3] = 255); // blend's f32 math leaves 254 under see-through ink
    }
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

    #[test]
    fn markup_composites_over_the_shot() {
        use image::{Rgba, RgbaImage};
        let grey = Rgba([90, 90, 90, 255]);
        let mut base = RgbaImage::from_pixel(4, 4, grey);
        let mut ink = RgbaImage::new(4, 4); // transparent
        ink.put_pixel(1, 2, Rgba([255, 0, 0, 255]));
        ink.put_pixel(3, 3, Rgba([0, 0, 255, 128])); // highlighter: half see-through
        composite(&mut base, ink.into());
        assert_eq!(base.get_pixel(1, 2), &Rgba([255, 0, 0, 255]));
        assert_eq!(base.get_pixel(0, 0), &grey, "transparent ink leaves the shot alone");
        let hl = base.get_pixel(3, 3);
        assert!(hl[2] > 150 && hl[0] < 60 && hl[3] == 255, "{hl:?}");

        // the page capped a huge shot: a half-size drawing is stretched back over it
        let mut big = RgbaImage::from_pixel(8, 8, grey);
        composite(&mut big, RgbaImage::from_pixel(4, 4, Rgba([0, 255, 0, 255])).into());
        assert_eq!((big.dimensions(), big.get_pixel(7, 7)), ((8, 8), &Rgba([0, 255, 0, 255])));
    }

    #[test]
    fn markup_base_follows_exif_rotation() {
        use image::ImageEncoder;
        // a 4×2 JPEG tagged "rotate 90°" (raw TIFF: one IFD entry, Orientation = 6) shows as 2×4
        let exif = vec![0x49, 0x49, 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 1, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0];
        let mut jpg = Vec::new();
        let mut enc = image::codecs::jpeg::JpegEncoder::new(&mut jpg);
        enc.set_exif_metadata(exif).unwrap();
        enc.write_image(&[0; 24], 4, 2, image::ExtendedColorType::Rgb8).unwrap();
        let p = std::env::temp_dir().join(format!("crashpad-exif-{}.jpg", std::process::id()));
        fs::write(&p, jpg).unwrap();
        let dims = upright(&p).map(|i| (i.width(), i.height()));
        let _ = fs::remove_file(&p);
        assert_eq!(dims, Ok((2, 4)));
    }

    #[test]
    fn markup_names_round_trip() {
        assert_eq!(uri_decode("shot1.png"), "shot1.png");
        assert_eq!(uri_decode("Caf%C3%A9%20%E2%98%95%20a%2Bb%26c%3Dd%23.png"), "Café ☕ a+b&c=d#.png");
        assert!(bare_name(&uri_decode("..%5Cx.png")).is_err());
    }
}
