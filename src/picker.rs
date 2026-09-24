//! Screen colour picker: the next click anywhere picks the pixel under the cursor.

use super::*;
use std::sync::atomic::AtomicU8;
use windows::Win32::{
    Foundation::{LPARAM, LRESULT, WPARAM},
    Graphics::Gdi::{CLR_INVALID, GetDC, GetPixel, ReleaseDC},
    System::LibraryLoader::GetModuleHandleW,
    UI::{
        Input::KeyboardAndMouse::{GetAsyncKeyState, VK_ESCAPE},
        WindowsAndMessaging::*,
    },
};

/// One pick at a time.
static PICKING: AtomicBool = AtomicBool::new(false);
// What the hook saw. It runs on the picking thread (inside PeekMessageW), so these never race.
static SEEN: AtomicU8 = AtomicU8::new(0);
const PICKED: u8 = 1;
const CANCELLED: u8 = 2;
static AT_X: AtomicI32 = AtomicI32::new(0);
static AT_Y: AtomicI32 = AtomicI32::new(0);
/// Buttons whose press was swallowed (1 left, 2 right): their release is swallowed too.
static HELD: AtomicU8 = AtomicU8::new(0);

/// COLORREF (0x00BBGGRR) -> ("#RRGGBB", "rgb(r, g, b)").
fn color(c: u32) -> (String, String) {
    let [r, g, b, _] = c.to_le_bytes();
    (format!("#{r:02X}{g:02X}{b:02X}"), format!("rgb({r}, {g}, {b})"))
}

/// The screen pixel at physical coords.
fn pixel(x: i32, y: i32) -> Option<u32> {
    unsafe {
        let dc = GetDC(None);
        let c = GetPixel(dc, x, y).0;
        ReleaseDC(None, dc);
        (c != CLR_INVALID).then_some(c)
    }
}

/// Low-level mouse hook. It must return fast, so it only records: a left press picks (at the
/// hook's point), a right press cancels; both, and their releases, never reach the app below.
unsafe extern "system" fn hook(code: i32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    let msg = wp.0 as u32;
    let bit = match msg {
        WM_LBUTTONDOWN | WM_LBUTTONUP => 1,
        WM_RBUTTONDOWN | WM_RBUTTONUP => 2,
        _ => 0,
    };
    if code == HC_ACTION as i32 && bit != 0 {
        if msg == WM_LBUTTONDOWN || msg == WM_RBUTTONDOWN {
            HELD.fetch_or(bit, Relaxed);
            if SEEN.load(Relaxed) == 0 {
                let pt = unsafe { (*(lp.0 as *const MSLLHOOKSTRUCT)).pt };
                AT_X.store(pt.x, Relaxed);
                AT_Y.store(pt.y, Relaxed);
                SEEN.store(if bit == 1 { PICKED } else { CANCELLED }, Relaxed);
            }
            return LRESULT(1);
        }
        if HELD.fetch_and(!bit, Relaxed) & bit != 0 {
            return LRESULT(1);
        }
    }
    unsafe { CallNextHookEx(None, code, wp, lp) }
}

/// Unhooks on every way out of `run` (panics included) and frees the picker.
struct Hook(HHOOK);
impl Drop for Hook {
    fn drop(&mut self) {
        unsafe { let _ = UnhookWindowsHookEx(self.0); }
        PICKING.store(false, Relaxed);
    }
}

/// The picking thread: hook the mouse, pump its messages, report hover / pick / cancel.
fn run(app: &AppHandle) -> windows::core::Result<()> {
    SEEN.store(0, Relaxed);
    HELD.store(0, Relaxed);
    let _hook = Hook(unsafe { SetWindowsHookExW(WH_MOUSE_LL, Some(hook), Some(GetModuleHandleW(None)?.into()), 0)? });
    let (start, mut next, mut last, mut done) = (Instant::now(), Instant::now(), CLR_INVALID, false);
    let mut msg = MSG::default();
    loop {
        // wakes on every hook call, so the hook is answered at once (else the whole desktop's mouse lags)
        unsafe {
            MsgWaitForMultipleObjects(None, false, 20, QS_ALLINPUT);
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                DispatchMessageW(&msg);
            }
        }
        let late = start.elapsed() > Duration::from_secs(30);
        if !done {
            let seen = SEEN.load(Relaxed);
            if seen == PICKED {
                done = true;
                match pixel(AT_X.load(Relaxed), AT_Y.load(Relaxed)).map(color) {
                    Some((hex, rgb)) => {
                        // copied first, so the page's "Copied" peek from the clip is replaced by the swatch
                        if let Err(e) = clip::copy_text(app.clone(), hex.clone()) {
                            let _ = app.emit("notice", format!("Couldn't copy {hex}: {e}"));
                        }
                        let _ = app.emit("color-picked", serde_json::json!({ "hex": hex, "rgb": rgb }));
                    }
                    None => {
                        let _ = app.emit("color-cancel", ());
                    }
                }
            } else if seen == CANCELLED || late || unsafe { GetAsyncKeyState(VK_ESCAPE.0 as i32) } < 0 {
                done = true;
                let _ = app.emit("color-cancel", ());
            } else if Instant::now() >= next {
                next = Instant::now() + Duration::from_millis(16);
                if let Some((x, y)) = cursor()
                    && let Some(c) = pixel(x as i32, y as i32)
                    && c != last
                {
                    last = c;
                    let _ = app.emit("color-hover", serde_json::json!({ "hex": color(c).0 }));
                }
            }
        }
        // keep the hook until the swallowed click is released, so the app below never gets half a click
        if done && (HELD.load(Relaxed) == 0 || late) {
            return Ok(());
        }
    }
}

/// Start picking: collapses the panel; emits "color-hover" {hex} while moving, then
/// "color-picked" {hex, rgb} (hex also copied, so it joins the clipboard history) or "color-cancel"
/// (right click, Esc, or 30 s). A call while already picking does nothing.
#[tauri::command]
pub fn pick_color(app: AppHandle) -> Res<()> {
    if PICKING.swap(true, Relaxed) {
        return Ok(());
    }
    set_open_later(&app, false, false); // a popped-out window stays
    thread::spawn(move || {
        if let Err(e) = run(&app) {
            PICKING.store(false, Relaxed);
            let _ = app.emit("color-cancel", ());
            let _ = app.emit("notice", format!("Couldn't start the colour picker: {e}"));
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // pure parts only: running the picker would read the screen and swallow a real click
    #[test]
    fn colorref_to_css() {
        assert_eq!(color(0x0033_6699), ("#996633".to_string(), "rgb(153, 102, 51)".to_string()));
        assert_eq!(color(0x00FF_FFFF), ("#FFFFFF".to_string(), "rgb(255, 255, 255)".to_string()));
        assert_eq!(color(0), ("#000000".to_string(), "rgb(0, 0, 0)".to_string()));
    }
}
