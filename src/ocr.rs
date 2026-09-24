//! Text from images (Windows.Media.Ocr, offline).

use super::*;
use windows::{
    Graphics::Imaging::{BitmapPixelFormat, SoftwareBitmap},
    Media::Ocr::OcrEngine,
    Storage::Streams::DataWriter,
    Win32::System::WinRT::{RO_INIT_MULTITHREADED, RoInitialize},
};

/// Only images crashpad itself shows: directly inside one of `dirs` (screenshots, clip images) or
/// a shelf item. Windows paths, so case and separator style don't matter; `..` never matches.
fn allowed(p: &Path, dirs: &[PathBuf], shelf: &[String]) -> bool {
    let key = |p: &Path| PathBuf::from(p.to_string_lossy().to_lowercase());
    p.is_absolute()
        && is_image(p)
        && (p.parent().is_some_and(|d| dirs.iter().any(|x| key(x) == key(d)))
            || shelf.iter().any(|s| key(Path::new(s)) == key(p)))
}

/// Recognize the text in an image file, lines joined with '\n'. Needs a WinRT-initialised thread.
fn recognize(path: &Path) -> Res<String> {
    let engine = OcrEngine::TryCreateFromUserProfileLanguages()
        .map_err(|_| "No OCR language is installed (Settings › Time & language › Language)".to_string())?;
    let max = OcrEngine::MaxImageDimension().map_err(err)?;
    let mut img = image::open(path).map_err(err)?;
    if img.width() > max || img.height() > max {
        img = img.resize(max, max, image::imageops::FilterType::Triangle); // keeps the aspect ratio
    }
    let (w, h) = (img.width() as i32, img.height() as i32);
    let mut px = img.into_rgba8().into_raw();
    for p in px.as_chunks_mut::<4>().0 {
        // RGBA -> BGRA, flattened onto white so dark text on a transparent background stays readable
        let [r, g, b, a] = *p;
        let on_white = |c: u8| ((c as u32 * a as u32 + 255 * (255 - a as u32)) / 255) as u8;
        *p = [on_white(b), on_white(g), on_white(r), 255];
    }
    let run = || -> windows::core::Result<String> {
        let writer = DataWriter::new()?;
        writer.WriteBytes(&px)?;
        let bitmap = SoftwareBitmap::CreateCopyFromBuffer(&writer.DetachBuffer()?, BitmapPixelFormat::Bgra8, w, h)?;
        let lines = engine.RecognizeAsync(&bitmap)?.get()?.Lines()?;
        Ok(lines.into_iter().map(|l| l.Text().unwrap_or_default().to_string()).collect::<Vec<_>>().join("\n"))
    };
    run().map_err(err)
}

/// Recognize the text in an image file. Only images crashpad shows (screenshots folder, clip
/// images, shelf items) are accepted.
#[tauri::command]
pub async fn ocr_image(app: AppHandle, path: String) -> Res<String> {
    let p = PathBuf::from(path);
    let shelf: Vec<String> = app.state::<Pad>().shelf.lock().unwrap().iter().map(|i| i.path.clone()).collect();
    if !allowed(&p, &[shots::shots_dir(&app), clip::images_dir(&app)], &shelf) || !p.is_file() {
        return Err("Can't read text from that file".into());
    }
    // WinRT wants an initialised thread; the async runtime's workers aren't
    tauri::async_runtime::spawn_blocking(move || {
        unsafe { let _ = RoInitialize(RO_INIT_MULTITHREADED); }
        recognize(&p)
    })
    .await
    .map_err(err)?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_images_crashpad_shows() {
        let dirs = [PathBuf::from("C:\\Pics\\Screenshots\\"), PathBuf::from("C:\\Data\\clips")];
        let shelf = ["D:\\Stuff\\Photo.JPG".to_string()];
        let ok = |p: &str| allowed(Path::new(p), &dirs, &shelf);
        for good in ["C:\\Pics\\Screenshots\\a.png", "c:/pics/screenshots/A.PNG", "C:\\Data\\clips\\0123.png", "d:\\stuff\\photo.jpg"] {
            assert!(ok(good), "{good}");
        }
        for bad in [
            "C:\\Pics\\Screenshots\\notes.txt",
            "C:\\Pics\\Screenshots\\sub\\a.png",
            "C:\\Pics\\Screenshots\\..\\secret.png",
            "C:\\Pics\\other.png",
            "D:\\Stuff\\other.jpg",
            "a.png",
            "",
        ] {
            assert!(!ok(bad), "{bad}");
        }
    }

    /// Draws known text with GDI+ (PowerShell), then reads it back with Windows OCR.
    #[test]
    #[ignore = "needs Windows OCR + PowerShell; run by hand: cargo test ocr -- --ignored --nocapture"]
    fn reads_text_from_a_png() {
        let dir = std::env::temp_dir().join(format!("crashpad-ocr-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let png = dir.join("hello.png");
        let ps = format!(
            "Add-Type -AssemblyName System.Drawing; $b = New-Object Drawing.Bitmap 720,120; \
             $g = [Drawing.Graphics]::FromImage($b); $g.Clear([Drawing.Color]::White); \
             $g.DrawString('Crashpad reads this text', (New-Object Drawing.Font 'Segoe UI',32), [Drawing.Brushes]::Black, 10, 25); \
             $b.Save('{}', [Drawing.Imaging.ImageFormat]::Png)",
            png.display()
        );
        let made = std::process::Command::new("powershell").args(["-NoProfile", "-Command", &ps]).status().unwrap();
        assert!(made.success() && png.is_file());
        unsafe { let _ = RoInitialize(RO_INIT_MULTITHREADED); }
        let text = recognize(&png);
        fs::remove_dir_all(&dir).unwrap();
        println!("OCR -> {text:?}");
        let text = text.unwrap();
        assert!(["Crashpad", "reads", "this", "text"].iter().all(|w| text.contains(w)), "{text}");
    }
}
