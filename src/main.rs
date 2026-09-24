// No console window in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audio;
mod capture;
mod clip;
mod dock;
mod ocr;
mod picker;
mod notes;
mod reminders;
mod shots;
mod live;
mod shelf;

use dock::*;
use serde::{Deserialize, Serialize};
use std::{
    fs, io,
    path::{Path, PathBuf},
    sync::{
        Mutex,
        atomic::{AtomicBool, AtomicI32, AtomicIsize, Ordering::Relaxed},
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State, WebviewWindow, WindowEvent,
    ipc::{InvokeBody, Request},
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as _};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_plugin_opener::OpenerExt;

const IMG_EXTS: [&str; 6] = ["png", "jpg", "jpeg", "gif", "webp", "bmp"];

type Res<T> = Result<T, String>;
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// Milliseconds since the Unix epoch.
fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

// ---------- config ----------

#[derive(Serialize, Deserialize, Clone)]
#[serde(default, rename_all = "camelCase")]
struct Config {
    hotkey: String,
    /// top | bottom | left | right | top-left | top-right | bottom-left | bottom-right
    edge: String,
    offset: f64,
    gap: f64,
    /// Collapsed look: pill | notch | fade | line | dot | invisible
    dock_style: String,
    #[serde(alias = "pillWidth")]
    pill_length: f64,
    #[serde(alias = "pillHeight")]
    pill_thickness: f64,
    /// Legacy (v1): false meant what dock_style "invisible" means now.
    #[serde(skip_serializing)]
    pill_visible: bool,
    /// Panel size along the edge / away from it (so left/right docks are tall and narrow).
    #[serde(alias = "panelWidth")]
    panel_length: f64,
    #[serde(alias = "panelHeight")]
    panel_depth: f64,
    radius: f64,
    /// Name of the preset the colours came from (UI only).
    theme: String,
    /// opaque | translucent | frosted | glass
    material: String,
    bg: String,
    fg: String,
    accent: String,
    opacity: f64,
    /// Backdrop blur for frosted glass, CSS px.
    blur: f64,
    font: String,
    font_size: f64,
    /// spring | smooth | snappy | fade | zoom | slide
    anim_style: String,
    anim_ms: f64,
    bounce: f64,
    peek: bool,
    /// clipboard | notes | shots | reminders
    default_tab: String,
    slam: bool,
    slam_zone: String,
    slam_push: f64,
    slam_dwell_ms: f64,
    slam_focus: bool,
    collapse_on_leave: bool,
    leave_delay_ms: f64,
    collapse_on_blur: bool,
    clipboard_max: f64,
    /// Keep clipboard history across restarts.
    clip_persist: bool,
    /// What clicking a clip does: paste (into the window you were in) | copy
    clip_click: String,
    autostart: bool,
    /// Folder of .md notes.
    notes_dir: String,
    /// Legacy (v1): the single notes file; its folder becomes notes_dir.
    #[serde(skip_serializing)]
    notes_path: String,
    pinned_notes: Vec<String>,
    last_note: String,
    screenshots_dir: String,
    shot_size: f64,
    /// grid (scroll down) | row (scroll across)
    shot_layout: String,
    /// contain (whole image) | cover (fill tile)
    shot_fit: String,
    /// Popped-out panel rect, physical px [x, y, w, h]; w == 0 means "not placed yet".
    float_rect: [f64; 4],
    float_on_top: bool,
    reminder_sound: bool,
    /// The tab that was showing last (used when default_tab is "last").
    last_tab: String,
    /// Shaking a file you're dragging pops the panel open on the Shelf.
    shake_open: bool,
    /// Show live activities (music, timers, next reminder) on the collapsed pill.
    pill_activities: bool,
    /// Global hotkey for the quick-capture bar ("" = off).
    capture_hotkey: String,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            hotkey: "Alt+C".into(),
            edge: "top".into(),
            offset: 50.,
            gap: 6.,
            dock_style: "pill".into(),
            pill_length: 120.,
            pill_thickness: 30.,
            pill_visible: true,
            panel_length: 600.,
            panel_depth: 400.,
            radius: 26.,
            theme: "island".into(),
            material: "opaque".into(),
            bg: "#000000".into(),
            fg: "#f5f5f7".into(),
            accent: "#0a84ff".into(),
            opacity: 1.,
            blur: 28.,
            font: r#""Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif"#.into(),
            font_size: 14.,
            anim_style: "spring".into(),
            anim_ms: 460.,
            bounce: 0.18,
            peek: true,
            default_tab: "notes".into(),
            slam: true,
            slam_zone: "panel".into(),
            slam_push: 150.,
            slam_dwell_ms: 150.,
            slam_focus: false,
            collapse_on_leave: true,
            leave_delay_ms: 450.,
            collapse_on_blur: true,
            clipboard_max: 100.,
            clip_persist: true,
            clip_click: "paste".into(),
            autostart: false,
            notes_dir: String::new(),
            notes_path: String::new(),
            pinned_notes: Vec::new(),
            last_note: String::new(),
            screenshots_dir: String::new(),
            shot_size: 220.,
            shot_layout: "grid".into(),
            shot_fit: "contain".into(),
            float_rect: [0.; 4],
            float_on_top: true,
            reminder_sound: true,
            last_tab: "notes".into(),
            shake_open: true,
            pill_activities: true,
            capture_hotkey: "Alt+Shift+C".into(),
        }
    }
}

impl Config {
    /// Clamp hand-edited or UI-supplied values into something that can't break the window, and
    /// carry v1 settings over. `docs`/`pics` are the user's Documents and Pictures folders.
    fn sanitize(mut self, docs: &Path, pics: &Path) -> Self {
        let d = Self::default();
        let pick = |v: &mut String, ok: &[&str], def: &str| {
            if !ok.contains(&v.as_str()) {
                *v = def.into()
            }
        };
        let edges = ["top", "bottom", "left", "right", "top-left", "top-right", "bottom-left", "bottom-right"];
        pick(&mut self.edge, &edges, &d.edge);
        pick(&mut self.slam_zone, &["panel", "edge"], &d.slam_zone);
        let tabs = ["clipboard", "notes", "shots", "reminders", "shelf", "live"];
        pick(&mut self.default_tab, &[&tabs[..], &["last"]].concat(), &d.default_tab);
        pick(&mut self.last_tab, &tabs, &d.last_tab);
        if !self.pill_visible {
            (self.dock_style, self.pill_visible) = ("invisible".into(), true);
        }
        pick(&mut self.dock_style, &["pill", "notch", "fade", "line", "dot", "invisible"], &d.dock_style);
        pick(&mut self.material, &["opaque", "translucent", "frosted", "glass"], &d.material);
        pick(&mut self.anim_style, &["spring", "smooth", "snappy", "fade", "zoom", "slide"], &d.anim_style);
        pick(&mut self.clip_click, &["paste", "copy"], &d.clip_click);
        pick(&mut self.shot_layout, &["grid", "row"], &d.shot_layout);
        pick(&mut self.shot_fit, &["contain", "cover"], &d.shot_fit);
        for (v, lo, hi) in [
            (&mut self.offset, 0., 100.),
            (&mut self.gap, 0., 200.),
            (&mut self.pill_length, 4., 600.),
            (&mut self.pill_thickness, 2., 100.),
            (&mut self.panel_length, 280., 2400.),
            (&mut self.panel_depth, 200., 1600.),
            (&mut self.radius, 0., 200.),
            (&mut self.opacity, 0.1, 1.),
            (&mut self.blur, 0., 80.),
            (&mut self.font_size, 8., 40.),
            (&mut self.anim_ms, 0., 3000.),
            (&mut self.bounce, 0., 0.5),
            (&mut self.slam_push, 0., 5000.),
            (&mut self.slam_dwell_ms, 0., 5000.),
            (&mut self.leave_delay_ms, 0., 10000.),
            (&mut self.clipboard_max, 1., 2000.),
            (&mut self.shot_size, 80., 900.),
        ] {
            *v = v.clamp(lo, hi);
        }
        if self.hotkey.trim().is_empty() {
            self.hotkey = d.hotkey;
        }
        if self.notes_dir.trim().is_empty() && !self.notes_path.trim().is_empty() {
            let old = PathBuf::from(self.notes_path.trim());
            self.notes_dir = old.parent().unwrap_or(Path::new("")).to_string_lossy().into();
            self.last_note = old.file_name().map(|n| n.to_string_lossy().into()).unwrap_or_default();
        }
        self.notes_path.clear();
        if self.notes_dir.trim().is_empty() {
            self.notes_dir = docs.join("crashpad").to_string_lossy().into();
        }
        if self.screenshots_dir.trim().is_empty() {
            self.screenshots_dir = pics.join("Screenshots").to_string_lossy().into();
        }
        self
    }

    fn sanitized(self, app: &AppHandle) -> Self {
        let docs = app.path().document_dir().unwrap_or_default();
        let pics = app.path().picture_dir().unwrap_or_default();
        self.sanitize(&docs, &pics)
    }
}

fn config_path(app: &AppHandle) -> PathBuf {
    app.path().app_config_dir().unwrap_or_default().join("config.json")
}

/// App data folder (clipboard history, reminders).
fn data_dir(app: &AppHandle) -> PathBuf {
    app.path().app_data_dir().unwrap_or_default()
}

fn load_config(app: &AppHandle) -> Config {
    let path = config_path(app);
    let cfg = match fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_else(|e| {
            eprintln!("crashpad: unreadable config ({e}); kept a copy as config.json.bad");
            let _ = fs::copy(&path, path.with_extension("json.bad"));
            Config::default()
        }),
        Err(_) => Config::default(),
    };
    cfg.sanitized(app)
}

/// Persist the current config. Every writer goes through here: they share config.json.tmp, so
/// one at a time, and each writes the latest state.
fn save_config(app: &AppHandle) -> Res<()> {
    static SAVING: Mutex<()> = Mutex::new(());
    let _one = SAVING.lock().unwrap();
    let cfg = app.state::<Pad>().cfg.lock().unwrap().clone();
    write_atomic(&config_path(app), serde_json::to_string_pretty(&cfg).map_err(err)?).map_err(err)
}

/// Write via a temp file + rename so a crash mid-write never truncates notes or config.
fn write_atomic(path: &Path, data: impl AsRef<[u8]>) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let mut f = fs::File::create(&tmp)?;
    io::Write::write_all(&mut f, data.as_ref())?;
    f.sync_all()?; // else a power cut can leave the renamed file full of zeros
    drop(f);
    fs::rename(&tmp, path)
}

/// `dir/name`, or `dir/stem (n).ext` if that's taken.
fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let (stem, ext) = name.rsplit_once('.').map_or((name, String::new()), |(s, e)| (s, format!(".{e}")));
    let mut p = dir.join(name);
    for i in 1.. {
        if !p.exists() {
            break;
        }
        p = dir.join(format!("{stem} ({i}){ext}"));
    }
    p
}

/// A bare file name (no separators, no `..`), as the page may only name files, never paths.
fn bare_name(name: &str) -> Res<&Path> {
    let n = Path::new(name);
    if name.is_empty() || n.file_name() != Some(n.as_os_str()) {
        return Err(format!("Invalid file name: {name}"));
    }
    Ok(n)
}

fn is_image(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| IMG_EXTS.contains(&e.to_ascii_lowercase().as_str()))
}

fn open_path(app: &AppHandle, p: &Path) -> Res<()> {
    app.opener().open_path(p.to_string_lossy(), None::<&str>).map_err(err)
}

// ---------- state ----------

#[derive(Default)]
struct Pad {
    cfg: Mutex<Config>,
    /// Clipboard history, newest first (pinned clips never expire).
    clips: Mutex<Vec<clip::Clip>>,
    reminders: Mutex<Vec<reminders::Reminder>>,
    geo: Mutex<Geo>,
    open: AtomicBool,
    /// Popped out: a free floating, resizable window instead of the docked island.
    detached: AtomicBool,
    /// A reminder alert is showing on the collapsed island, so it takes clicks.
    interactive: AtomicBool,
    /// A native drag out of the panel is running (don't close on leave meanwhile).
    dragging: AtomicBool,
    /// Where the reminder alert card is (physical px inside the window) while `interactive`.
    alert_rect: Mutex<Option<[f64; 4]>>,
    /// Pinned open: no auto-close on blur or mouse leave (Esc / hotkey still close).
    pinned: AtomicBool,
    /// Countdown timers (Live tab); see live.rs.
    timers: Mutex<Vec<live::Timer>>,
    /// Files parked on the Shelf; see shelf.rs.
    shelf: Mutex<Vec<shelf::Item>>,
    own_window: AtomicIsize,
    /// Window that had focus before we grabbed it, so closing hands focus back.
    prev_window: AtomicIsize,
    /// Heads-ups for the user, one slot per source ([HOTKEY], [EDGE], [CAPTURE]); `ready` hands them to the page.
    notices: Mutex<[Option<String>; 3]>,
}

const HOTKEY: usize = 0;
const EDGE: usize = 1;
const CAPTURE: usize = 2;

fn main_window(app: &AppHandle) -> WebviewWindow {
    app.get_webview_window("main").expect("main window")
}

/// Store a heads-up for the page; emits only when it changes so settings tweaks don't repeat it.
fn notify(app: &AppHandle, slot: usize, msg: Option<String>) {
    let st = app.state::<Pad>();
    let mut notices = st.notices.lock().unwrap();
    if notices[slot] != msg {
        if let Some(m) = &msg {
            let _ = app.emit("notice", m);
        }
        notices[slot] = msg;
    }
}

/// Real paths for files dropped on the page. With Tauri's native drop handler off (so text drops
/// work), WebView2 only hands JS path-less File objects; JS forwards them via
/// chrome.webview.postMessageWithAdditionalObjects and we read ICoreWebView2File::Path here.
fn hook_file_drops(w: &WebviewWindow) -> tauri::Result<()> {
    use webview2_com::{
        Microsoft::Web::WebView2::Win32::{ICoreWebView2File, ICoreWebView2WebMessageReceivedEventArgs2},
        WebMessageReceivedEventHandler, take_pwstr,
    };
    use windows::core::{Interface, PWSTR};
    let emitter = w.clone();
    w.with_webview(move |wv| unsafe {
        let Ok(core) = wv.controller().CoreWebView2() else { return };
        let handler = WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args.and_then(|a| a.cast::<ICoreWebView2WebMessageReceivedEventArgs2>().ok()) else {
                return Ok(());
            };
            let Ok(objs) = args.AdditionalObjects() else { return Ok(()) };
            let mut n = 0;
            objs.Count(&mut n)?;
            let mut paths = Vec::new();
            for i in 0..n {
                if let Ok(file) = objs.GetValueAtIndex(i)?.cast::<ICoreWebView2File>() {
                    let mut p = PWSTR::null();
                    file.Path(&mut p)?;
                    paths.push(take_pwstr(p));
                }
            }
            if !paths.is_empty() {
                let _ = emitter.emit("files-dropped", paths);
            }
            Ok(())
        }));
        let mut token = Default::default();
        let _ = core.add_WebMessageReceived(&handler, &mut token);
    })
}

// ---------- commands: window & config ----------

/// What the page needs on boot (or reload) to match Rust's state.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Ready {
    open: bool,
    detached: bool,
    notice: Option<String>,
}

#[tauri::command]
fn ready(app: AppHandle) -> Ready {
    let st = app.state::<Pad>();
    let notices: Vec<String> = st.notices.lock().unwrap().iter().flatten().cloned().collect();
    Ready {
        open: st.open.load(Relaxed),
        detached: st.detached.load(Relaxed),
        notice: (!notices.is_empty()).then(|| notices.join(" ")),
    }
}

#[tauri::command]
fn close_panel(app: AppHandle) {
    set_open(&app, false, false);
}

/// Expand the panel and focus it (e.g. "Open" on a reminder alert).
#[tauri::command]
fn open_panel(app: AppHandle) {
    set_open(&app, true, true);
}

#[tauri::command]
fn get_config(st: State<Pad>) -> Config {
    st.cfg.lock().unwrap().clone()
}

#[tauri::command]
fn set_config(app: AppHandle, cfg: Config) -> Res<Config> {
    let cfg = cfg.sanitized(&app);
    let st = app.state::<Pad>();
    let old = st.cfg.lock().unwrap().clone();
    if cfg.hotkey != old.hotkey {
        rebind_hotkey(&app, &old.hotkey, &cfg.hotkey)?;
        st.cfg.lock().unwrap().hotkey = cfg.hotkey.clone(); // keep state honest if a later step fails
        notify(&app, HOTKEY, None);
    }
    if cfg.capture_hotkey != old.capture_hotkey {
        rebind_hotkey(&app, &old.capture_hotkey, &cfg.capture_hotkey)?;
        st.cfg.lock().unwrap().capture_hotkey = cfg.capture_hotkey.clone();
        notify(&app, CAPTURE, None);
    }
    if cfg.autostart != old.autostart {
        let al = app.autolaunch();
        if cfg.autostart { al.enable() } else { al.disable() }.map_err(err)?;
        st.cfg.lock().unwrap().autostart = cfg.autostart;
    }
    let scope = app.asset_protocol_scope();
    if cfg.screenshots_dir != old.screenshots_dir {
        let _ = scope.allow_directory(&cfg.screenshots_dir, false);
    }
    if cfg.notes_dir != old.notes_dir {
        let _ = scope.allow_directory(&cfg.notes_dir, true);
    }
    *st.cfg.lock().unwrap() = cfg.clone();
    clip::trim(&app);
    place(&app).map_err(err)?;
    save_config(&app)?;
    let now = st.cfg.lock().unwrap().clone(); // place() may have shrunk the panel to fit
    Ok(now)
}

#[tauri::command]
async fn open_config_dir(app: AppHandle) -> Res<()> {
    let dir = app.path().app_config_dir().map_err(err)?;
    fs::create_dir_all(&dir).map_err(err)?;
    open_path(&app, &dir)
}

#[tauri::command]
fn quit(app: AppHandle) {
    app.exit(0);
}

// ---------- main ----------

fn main() {
    tauri::Builder::default()
        // must be first: a second launch exits here and pops the running panel open instead
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            // a second launch can arrive while we're still starting, before state exists
            if app.try_state::<Pad>().is_some() {
                set_open(app, true, true)
            }
        }))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, key, e| {
                    if e.state != ShortcutState::Pressed {
                        return;
                    }
                    let capture = app.state::<Pad>().cfg.lock().unwrap().capture_hotkey.parse::<Shortcut>();
                    if capture.is_ok_and(|c| c.id() == key.id()) { capture::show(app) } else { toggle(app) }
                })
                .build(),
        )
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_opener::Builder::new().open_js_links_on_click(false).build())
        .setup(|app| {
            let h = app.handle().clone();
            let mut cfg = load_config(&h);
            // the main hotkey keeps a chord the capture hotkey shares (a v3 user on Alt+Shift+C, a hand
            // edit): registering both would leave every press opening quick capture
            let chord = |s: &str| s.parse::<Shortcut>().ok().map(|k| k.id());
            if chord(&cfg.capture_hotkey).is_some_and(|c| Some(c) == chord(&cfg.hotkey)) {
                cfg.capture_hotkey.clear();
            }
            cfg.autostart = h.autolaunch().is_enabled().unwrap_or(false);
            let scope = h.asset_protocol_scope();
            let _ = scope.allow_directory(&cfg.screenshots_dir, false);
            let _ = scope.allow_directory(&cfg.notes_dir, true); // sketches and pasted images
            let _ = scope.allow_directory(clip::images_dir(&h), false);
            let (hotkey, capture) = (cfg.hotkey.clone(), cfg.capture_hotkey.clone());
            let own = main_window(&h).hwnd()?.0 as isize;
            app.manage(Pad { cfg: Mutex::new(cfg), own_window: own.into(), ..Default::default() });
            clip::load(&h);
            reminders::load(&h);
            live::load(&h);
            shelf::load(&h);
            // registered after manage() so the handler can't fire before state exists;
            // a taken hotkey is reported in the UI instead of killing startup
            if let Err(e) = h.global_shortcut().register(hotkey.as_str()) {
                notify(&h, HOTKEY, Some(format!("Hotkey {hotkey} is taken ({e}). Pick another in Settings.")));
            }
            if let Some(Err(e)) = (!capture.trim().is_empty()).then(|| h.global_shortcut().register(capture.as_str())) {
                notify(&h, CAPTURE, Some(format!("Quick-capture hotkey {capture} is taken ({e}). Pick another in Settings.")));
            }
            // The window stays visible for its whole life (show/hide flashes white and throttles
            // WebView2); "collapsed" is just CSS plus click-through.
            set_click_through(&h, true);
            place(&h)?;
            hook_file_drops(&main_window(&h))?;
            for watcher in [watch_mouse, clip::watch_clipboard, reminders::watch, dock::watch_backdrop, live::watch, audio::watch] {
                let h = h.clone();
                thread::spawn(move || watcher(h));
            }
            thread::spawn(|| {
                if let Err(e) = watch_raw_mouse() {
                    eprintln!("crashpad: no raw mouse input ({e}); slams fall back to holding at the edge");
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            let app = window.app_handle();
            // Alt+F4 on the panel just collapses it; Quit lives in Settings
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                set_open(app, false, false);
            }
            dock::window_event(app, event);
        })
        .invoke_handler(tauri::generate_handler![
            ready,
            close_panel,
            open_panel,
            get_config,
            set_config,
            open_config_dir,
            quit,
            dock::set_detached,
            dock::set_interactive,
            dock::set_pinned,
            clip::get_clips,
            clip::use_clip,
            clip::copy_text,
            clip::pin_clip,
            clip::remove_clip,
            clip::clear_clips,
            notes::list_notes,
            notes::read_note,
            notes::write_note,
            notes::create_note,
            notes::rename_note,
            notes::delete_note,
            notes::pin_note,
            notes::save_attachment,
            notes::import_to_notes,
            notes::open_notes_dir,
            notes::render_md,
            notes::open_link,
            shots::list_shots,
            shots::copy_image,
            shots::open_shot,
            shots::reveal_shot,
            shots::open_shots_dir,
            shots::snip,
            shots::import_files,
            shots::save_image,
            shots::drag_shot,
            reminders::get_reminders,
            reminders::add_reminder,
            reminders::update_reminder,
            reminders::delete_reminder,
            live::get_specs,
            live::media_control,
            live::get_media,
            live::get_timers,
            live::add_timer,
            live::update_timer,
            live::remove_timer,
            shelf::get_shelf,
            shelf::shelf_add,
            shelf::shelf_remove,
            shelf::shelf_clear,
            shelf::shelf_open,
            shelf::shelf_reveal,
            shelf::shelf_copy,
            shelf::shelf_zip,
            shelf::shelf_drag,
            capture::append_inbox,
            ocr::ocr_image,
            picker::pick_color,
            audio::get_audio,
            audio::set_volume,
            audio::set_mute,
            audio::set_mic_mute,
            shots::save_markup,
            shots::copy_markup,
        ])
        .run(tauri::generate_context!())
        .expect("error while running crashpad");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn v1_config_carries_over() {
        let v1 = r#"{"pillWidth":90,"pillHeight":20,"pillVisible":false,"panelWidth":700,"panelHeight":420,
                     "notesPath":"D:\\vault\\inbox.md","edge":"sideways"}"#;
        let c: Config = serde_json::from_str(v1).unwrap();
        let c = c.sanitize(Path::new("C:\\Docs"), Path::new("C:\\Pics"));
        assert_eq!((c.pill_length, c.pill_thickness, c.panel_length, c.panel_depth), (90., 20., 700., 420.));
        assert_eq!(c.dock_style, "invisible");
        assert_eq!((c.notes_dir.as_str(), c.last_note.as_str()), ("D:\\vault", "inbox.md"));
        assert_eq!(c.edge, "top");
        let out = serde_json::to_string(&c).unwrap();
        assert!(!out.contains("notesPath") && !out.contains("pillVisible"));
        let fresh = Config::default().sanitize(Path::new("C:\\Docs"), Path::new("C:\\Pics"));
        assert_eq!(fresh.notes_dir, "C:\\Docs\\crashpad");
    }

    #[test]
    fn unique_path_avoids_collisions() {
        let dir = std::env::temp_dir().join(format!("crashpad-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("a.png"), "").unwrap();
        assert_eq!(unique_path(&dir, "a.png"), dir.join("a (1).png"));
        assert_eq!(unique_path(&dir, "b.png"), dir.join("b.png"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn bare_names_only() {
        assert!(bare_name("a.png").is_ok());
        for bad in ["", "..", "a/b.png", "..\\x", "C:x"] {
            assert!(bare_name(bad).is_err(), "{bad}");
        }
    }
}
