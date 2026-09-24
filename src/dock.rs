//! Docking: geometry, slam detection, focus hand-off and click-through.

use super::*;

/// Raw mouse movement (counts) since the mouse thread last looked; fed by watch_raw_mouse.
pub(crate) static RAW_DX: AtomicI32 = AtomicI32::new(0);
pub(crate) static RAW_DY: AtomicI32 = AtomicI32::new(0);

// ---------- geometry ----------

#[derive(Default, Clone, Copy, Debug)]
pub(crate) struct Rect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

impl Rect {
    fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && x < self.x + self.w && y >= self.y && y < self.y + self.h
    }
}

/// What the mouse thread needs, in physical screen pixels.
#[derive(Default, Clone, Copy)]
pub(crate) struct Geo {
    /// 1px strip on the screen edge (3x3 px square for a corner) that counts as a slam.
    zone: Rect,
    /// Panel plus the gap to the edge; leaving it closes an unfocused panel.
    hover: Rect,
    /// Unit vector pointing out of the screen through the edge (diagonal for a corner).
    out: (f64, f64),
    /// The window itself (the alert card's rect from the page is relative to it).
    win: Rect,
}

/// Panel (width, height) in logical px: length runs along the edge, depth away from it.
pub(crate) fn panel_size(c: &Config) -> (f64, f64) {
    match c.edge.as_str() {
        "left" | "right" => (c.panel_depth, c.panel_length),
        _ => (c.panel_length, c.panel_depth),
    }
}

/// Transparent margin (logical px) around the panel: room for the spring's overshoot plus shadow.
pub(crate) fn pad(c: &Config) -> f64 {
    let z = (1. - c.bounce).clamp(0.3, 1.); // no more damped than the shell's spring(), so an upper bound
    let overshoot = if z < 1. { (-z * std::f64::consts::PI / (1. - z * z).sqrt()).exp() } else { 0. };
    (overshoot * c.panel_length.max(c.panel_depth) + 52.).max(64.)
}

/// Where the edge lies on each axis: -1 = left/top, 1 = right/bottom, 0 = free (centred along it).
fn sides(edge: &str) -> (f64, f64) {
    let side = |lo: &str, hi: &str| if edge.contains(lo) { -1. } else if edge.contains(hi) { 1. } else { 0. };
    (side("left", "right"), side("top", "bottom"))
}

/// Gap to the edge. Flush styles sit on it (island.css does the same).
pub(crate) fn gap(c: &Config) -> f64 {
    if matches!(c.dock_style.as_str(), "notch" | "fade") { 0. } else { c.gap }
}

/// Window rect and mouse zones for a panel docked to `c.edge` of a monitor (`s` = scale factor).
/// Per axis the panel sits at `gap` from an edge with `pad` on its inner side, or (free axis)
/// between two pads at `offset` along the work area. Matches the anchoring in island.css.
pub(crate) fn layout(c: &Config, mon: Rect, work: Rect, s: f64) -> (Rect, Geo) {
    let (w, h) = panel_size(c);
    let (gap, pad, tol) = (gap(c) * s, pad(c) * s, 12. * s);
    let (sx, sy) = sides(&c.edge);
    let corner = sx != 0. && sy != 0.;
    let full = c.slam_zone == "edge" && !corner;
    let t = c.offset / 100.;
    // one axis → (window pos, window len, slam zone lo/len, hover lo/len)
    let axis = |side: f64, p: f64, (wlo, wlen): (f64, f64), (mlo, mlen): (f64, f64)| {
        let n = if corner { 3. } else { 1. }; // corners slam into a 3x3 px square
        if side == 0. {
            let len = p + 2. * pad;
            let pos = wlo + (wlen - len) * t;
            let at = pos + pad;
            let zone = if full { (mlo, mlen) } else { (at, p) };
            ((pos, len), zone, (at - tol, p + 2. * tol))
        } else if side < 0. {
            let at = wlo + gap;
            ((wlo, p + gap + pad), (mlo, n), (mlo, at + p + tol - mlo))
        } else {
            let len = p + gap + pad;
            let at = wlo + wlen - len + pad;
            ((wlo + wlen - len, len), (mlo + mlen - n, n), (at - tol, mlo + mlen - (at - tol)))
        }
    };
    let ((x, ww), (zx, zw), (hx, hw)) = axis(sx, w * s, (work.x, work.w), (mon.x, mon.w));
    let ((y, wh), (zy, zh), (hy, hh)) = axis(sy, h * s, (work.y, work.h), (mon.y, mon.h));
    let n = sx.hypot(sy);
    let geo = Geo {
        zone: Rect { x: zx, y: zy, w: zw, h: zh },
        hover: Rect { x: hx, y: hy, w: hw, h: hh },
        out: (sx / n, sy / n),
        win: Rect { x, y, w: ww, h: wh },
    };
    (geo.win, geo)
}

/// Dock the window to the primary monitor according to the config. No-op while popped out.
// ponytail: primary monitor only; add a "monitor" setting if multi-screen users ask.
pub(crate) fn place(app: &AppHandle) -> tauri::Result<()> {
    if app.state::<Pad>().detached.load(Relaxed) {
        return Ok(()); // the user placed the floating window; the monitor tick must not dock it
    }
    let w = main_window(app);
    let Some(m) = app.primary_monitor()? else { return Ok(()) };
    let (pos, size, wa) = (m.position(), m.size(), m.work_area());
    let mon = Rect { x: pos.x as f64, y: pos.y as f64, w: size.width as f64, h: size.height as f64 };
    let work = Rect {
        x: wa.position.x as f64,
        y: wa.position.y as f64,
        w: wa.size.width as f64,
        h: wa.size.height as f64,
    };
    let (st, s) = (app.state::<Pad>(), m.scale_factor());
    let mut cfg = st.cfg.lock().unwrap().clone();
    // a panel sized on a bigger screen may not fit this one: shrink it (saved with the next change)
    let (pad, g, (sx, sy)) = (pad(&cfg), gap(&cfg), sides(&cfg.edge));
    let fit = |side: f64, len: f64| len / s - if side == 0. { 2. * pad } else { g + pad };
    let (max_w, max_h) = (fit(sx, work.w), fit(sy, work.h));
    let (pw, ph) = panel_size(&cfg);
    if pw > max_w || ph > max_h {
        let (w, h) = (pw.min(max_w).max(200.), ph.min(max_h).max(120.));
        (cfg.panel_length, cfg.panel_depth) = match cfg.edge.as_str() {
            "left" | "right" => (h, w),
            _ => (w, h),
        };
        let mut c = st.cfg.lock().unwrap();
        (c.panel_length, c.panel_depth) = (cfg.panel_length, cfg.panel_depth);
        let _ = app.emit("config", &*c);
    }
    let (win, geo) = layout(&cfg, mon, work, s);
    let at = PhysicalPosition::new(win.x.round() as i32, win.y.round() as i32);
    // move first: crossing onto a monitor with another DPI rescales the window, then size it exactly
    w.set_position(at)?;
    w.set_size(PhysicalSize::new(win.w.round() as u32, win.h.round() as u32))?;
    w.set_position(at)?;
    *st.geo.lock().unwrap() = geo;
    // slams need a wall: warn when another screen continues past this edge (either wall of a
    // corner). Floor, because tao truncates toward zero and -0.5 would land back on this monitor.
    let z = geo.zone;
    let past = |dx: f64, dy: f64| {
        let (x, y) = (z.x + z.w / 2. + dx * (z.w / 2. + 1.), z.y + z.h / 2. + dy * (z.h / 2. + 1.));
        (dx != 0. || dy != 0.) && app.monitor_from_point(x.floor(), y.floor()).ok().flatten().is_some()
    };
    let shared = cfg.slam && (past(sx, 0.) || past(0., sy));
    notify(
        app,
        EDGE,
        shared.then(|| {
            format!(
                "Another screen continues past the {} {}, so slams can't land there. Pick another spot or use {}.",
                cfg.edge,
                if sx != 0. && sy != 0. { "corner" } else { "edge" },
                cfg.hotkey
            )
        }),
    );
    Ok(())
}

// ---------- open / close ----------

pub(crate) fn foreground() -> isize {
    unsafe { windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow().0 as isize }
}

/// Ground truth for "the panel has keyboard focus". Tauri's Focused events for a single-webview
/// window are synthesized from WebView2 Got/LostFocus and can disagree with the real foreground.
pub(crate) fn focused(app: &AppHandle) -> bool {
    use windows::Win32::{Foundation::HWND, UI::WindowsAndMessaging::{GA_ROOTOWNER, GetAncestor}};
    let fg = foreground();
    // popups we own (the page's confirm() dialog) count as us
    fg != 0 && unsafe { GetAncestor(HWND(fg as _), GA_ROOTOWNER) }.0 as isize == app.state::<Pad>().own_window.load(Relaxed)
}

/// Worth handing focus back to: not a shell surface (Start, search, Win+V, taskbar), which is
/// dismissed by the time we close.
pub(crate) fn app_window(hwnd: isize) -> bool {
    use windows::Win32::{Foundation::HWND, UI::WindowsAndMessaging::GetClassNameW};
    let mut buf = [0u16; 64];
    let n = unsafe { GetClassNameW(HWND(hwnd as _), &mut buf) } as usize;
    let class = String::from_utf16_lossy(&buf[..n]);
    hwnd != 0
        && !matches!(
            class.as_str(),
            "Windows.UI.Core.CoreWindow" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd" | "XamlExplorerHostIslandWindow"
        )
}

/// Physical virtual-desktop coords. Called directly: tauri's cursor_position() is a blocking
/// round trip to the main thread, too heavy at 60Hz.
pub(crate) fn cursor() -> Option<(f64, f64)> {
    let mut p = windows::Win32::Foundation::POINT::default();
    unsafe { windows::Win32::UI::WindowsAndMessaging::GetCursorPos(&mut p) }.ok()?;
    Some((p.x as f64, p.y as f64))
}

/// Toggle click-through. tao rebuilds the window's ex-style on every flag change, which brings
/// back WS_EX_APPWINDOW (skipTaskbar doesn't cover Alt+Tab), so re-mark it as a tool window after.
/// Opening also re-asserts topmost, which Windows 11 sometimes drops (not for a popped-out
/// window the user unpinned from the top).
pub(crate) fn set_click_through(app: &AppHandle, on: bool) {
    use windows::Win32::{Foundation::HWND, UI::WindowsAndMessaging::*};
    let _ = main_window(app).set_ignore_cursor_events(on);
    let st = app.state::<Pad>();
    let h = st.own_window.load(Relaxed);
    let top = !on && (!st.detached.load(Relaxed) || st.cfg.lock().unwrap().float_on_top);
    let _ = app.run_on_main_thread(move || unsafe {
        let h = HWND(h as _);
        let ex = GetWindowLongPtrW(h, GWL_EXSTYLE);
        SetWindowLongPtrW(h, GWL_EXSTYLE, (ex | WS_EX_TOOLWINDOW.0 as isize) & !(WS_EX_APPWINDOW.0 as isize));
        if top {
            let _ = SetWindowPos(h, Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        }
    });
}

/// A fullscreen video, game or presentation is up: hide the pill and ignore edge slams.
pub(crate) fn fullscreen_app() -> bool {
    use windows::Win32::UI::Shell::*;
    matches!(unsafe { SHQueryUserNotificationState() },
        Ok(s) if s == QUNS_BUSY || s == QUNS_RUNNING_D3D_FULL_SCREEN || s == QUNS_PRESENTATION_MODE)
}

/// Physical buttons, so both are checked (left-handed users drag with the physical right one).
pub(crate) fn mouse_down() -> bool {
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON, VK_RBUTTON};
    [VK_LBUTTON, VK_RBUTTON].iter().any(|k| (unsafe { GetAsyncKeyState(k.0 as i32) }) < 0)
}

/// Hand focus back; if that window is gone, give it to the desktop rather than keep it ourselves.
pub(crate) fn activate(hwnd: isize) {
    use windows::Win32::{Foundation::HWND, UI::WindowsAndMessaging::*};
    unsafe {
        if hwnd == 0 || !SetForegroundWindow(HWND(hwnd as _)).as_bool() {
            let _ = SetForegroundWindow(GetShellWindow());
        }
    }
}

/// Open/close the docked panel. Either way ends an alert's clickability (`interactive`). A
/// popped-out panel ignores closing; docking it back (set_detached(false)) comes first.
pub(crate) fn set_open(app: &AppHandle, open: bool, focus: bool) {
    let st = app.state::<Pad>();
    if !open && st.detached.load(Relaxed) {
        return;
    }
    let was = st.open.swap(open, Relaxed);
    let was_interactive = st.interactive.swap(false, Relaxed);
    if was == open && !(open && focus) && !was_interactive {
        return;
    }
    set_click_through(app, !open);
    // prev_window is kept current by watch_mouse, so there's nothing to capture here
    if open {
        if focus {
            let _ = main_window(app).set_focus();
        }
    } else if focused(app) {
        activate(st.prev_window.load(Relaxed));
    }
    if was != open {
        let _ = app.emit("open", open);
    }
}

/// For the watcher threads: run set_open on the main thread, so it can't interleave with the
/// hotkey handler (which runs there) and leave the window click-through while open.
pub(crate) fn set_open_later(app: &AppHandle, open: bool, focus: bool) {
    let a = app.clone();
    let _ = app.run_on_main_thread(move || set_open(&a, open, focus));
}

/// Hotkey: open + focus, or close if it's already open and focused. Popped out: focus it, or
/// if it already has focus, dock it back and close.
pub(crate) fn toggle(app: &AppHandle) {
    let st = app.state::<Pad>();
    let w = main_window(app);
    let min = w.is_minimized().unwrap_or(false);
    let f = !min && focused(app); // before restoring: restoring activates it, which isn't "already focused"
    if min {
        let _ = w.unminimize(); // Win+D / Show desktop hid the pop-out; set_focus ignores iconic windows
    }
    if !st.detached.load(Relaxed) {
        set_open(app, !(st.open.load(Relaxed) && f), true);
    } else if f {
        let _ = set_detached(app.clone(), false);
        set_open(app, false, false);
    } else {
        let _ = main_window(app).set_focus();
    }
}

/// Swap a global hotkey; "" means none. On failure (taken, e.g. by the other crashpad hotkey) the
/// old one stays.
pub(crate) fn rebind_hotkey(app: &AppHandle, old: &str, new: &str) -> Res<()> {
    let gs = app.global_shortcut();
    let _ = gs.unregister(old);
    if new.trim().is_empty() {
        return Ok(());
    }
    gs.register(new).map_err(|e| {
        let _ = gs.register(old);
        format!("Can't use hotkey \"{new}\": {e}")
    })
}

// ---------- background watchers ----------

/// Slam detector, fed one sample per tick while the panel is closed.
#[derive(Default)]
pub(crate) struct Slam {
    push: f64,
    push_start: Option<Instant>,
    pinned_since: Option<Instant>,
    was_at_edge: bool,
}

impl Slam {
    /// `into` / `along`: raw mouse counts moved into the wall / sideways along it this tick.
    /// `raw_ok`: the pointer reports relative raw input at all; if not, holding at the edge for
    /// `dwell_ms` counts instead.
    #[allow(clippy::too_many_arguments)]
    fn step(&mut self, at_edge: bool, into: f64, along: f64, raw_ok: bool, now: Instant, need_push: f64, dwell_ms: f64) -> bool {
        let ms = |t: Instant| (now - t).as_secs_f64() * 1000.;
        // a slam is a burst: `need_push` must arrive within 300ms of the push starting, so slow
        // nudges and tremor while parked on a tab never add up
        if !at_edge || self.push_start.is_some_and(|t| ms(t) > 300.) {
            (self.push, self.push_start) = (0., None);
        }
        // only movement while already pinned counts (the arriving tick carries the approach), and
        // only when it's mostly into the wall, not sliding along it between tabs
        if at_edge && self.was_at_edge && into > along {
            self.push_start.get_or_insert(now);
            self.push += into;
        }
        self.pinned_since = if at_edge { self.pinned_since.or(Some(now)) } else { None };
        self.was_at_edge = at_edge;
        match self.pinned_since {
            Some(_) if raw_ok => self.push >= need_push, // need_push 0 = open on touch
            Some(t) => ms(t) >= dwell_ms,
            None => false,
        }
    }
}

/// Shake detector: while a mouse button is held, `need` quick reversals of horizontal direction
/// (each leg at least `leg` px, all within a second) count as a shake. Fires once per hold.
#[derive(Default)]
struct Shake {
    dir: f64,
    turns: Vec<Instant>,
    leg_from: f64,
    fired: bool,
}

impl Shake {
    fn step(&mut self, x: f64, held: bool, leg: f64, need: usize, now: Instant) -> bool {
        if !held {
            *self = Self { leg_from: x, ..Default::default() };
            return false;
        }
        let dx = x - self.leg_from;
        if self.dir != 0. && dx * self.dir > 0. {
            self.leg_from = x; // still going the same way: this is the new far end
        } else if dx.abs() >= leg {
            if self.dir != 0. {
                self.turns.push(now); // came back 30 px from the far end: a reversal
            }
            self.dir = dx.signum();
            self.leg_from = x;
        }
        self.turns.retain(|t| now.duration_since(*t).as_millis() <= 1000);
        if self.turns.len() >= need && !self.fired {
            self.fired = true; // one open per held button
            return true;
        }
        false
    }
}

/// Explorer (and most apps) show the shell's drag image while a file drag is running.
fn file_drag() -> bool {
    use windows::Win32::UI::WindowsAndMessaging::{FindWindowExW, IsWindowVisible};
    let mut h = None;
    // a hidden one can linger from an earlier drag, so look at every one
    while let Ok(w) = unsafe { FindWindowExW(None, h, windows::core::w!("SysDragImage"), None) } {
        if unsafe { IsWindowVisible(w) }.as_bool() {
            return true;
        }
        h = Some(w);
    }
    false
}

/// Polls the cursor and focus. Opening needs a slam: with the cursor pinned on the edge zone, the
/// mouse must keep moving into the wall (raw input) by `slam_push` counts, so merely resting on
/// the edge (browser tabs, taskbar) does nothing. Devices without relative raw input (touchpads,
/// pens, remote desktop) fall back to holding at the edge for `slam_dwell_ms`. Closes on focus
/// loss, or when the cursor wanders off an unfocused panel.
pub(crate) fn watch_mouse(app: AppHandle) {
    let st = app.state::<Pad>();
    let t0 = Instant::now();
    let (mut slam, mut away_since, mut opened_at) = (Slam::default(), None::<Instant>, t0);
    let (mut armed, mut had_focus, mut reached, mut raw_ok) = (true, false, false, true);
    let (mut last_pos, mut fullscreen, mut screen, mut tick) = (cursor().unwrap_or_default(), false, None, 0u32);
    let mut over_alert = false; // cursor over the alert card, which is then the only clickable part
    let mut bar_through = false; // open quick-capture bar: the window lets clicks through outside it
    let mut shake = Shake::default();
    let ms = |t: Instant| t.elapsed().as_secs_f64() * 1000.;
    loop {
        thread::sleep(Duration::from_millis(16));
        tick = tick.wrapping_add(1);
        if tick % 60 == 0 {
            // ~1s: re-dock after resolution / scaling changes, and track fullscreen apps
            let now = app.primary_monitor().ok().flatten().map(|m| {
                let wa = m.work_area();
                (*m.position(), *m.size(), wa.position, wa.size, m.scale_factor().to_bits())
            });
            if now != screen {
                screen = now;
                let _ = place(&app);
            }
            if fullscreen != fullscreen_app() {
                fullscreen = !fullscreen;
                let _ = app.emit("fullscreen", fullscreen);
            }
        }
        let (dx, dy) = (RAW_DX.swap(0, Relaxed) as f64, RAW_DY.swap(0, Relaxed) as f64);
        let Some((x, y)) = cursor() else { continue };
        // does the pointer report raw input? (no: touchpad, pen, remote desktop). Raw packets can
        // lag the cursor by a tick, so any raw movement sets it and only raw-less motion clears it.
        if dx != 0. || dy != 0. {
            raw_ok = true;
        } else if (x, y) != last_pos {
            raw_ok = false;
        }
        last_pos = (x, y);
        let has_focus = focused(&app);
        if !has_focus {
            // what the user is in right now: paste and focus hand-back target it, open or not
            let fg = foreground();
            if app_window(fg) {
                st.prev_window.store(fg, Relaxed);
            }
        }
        if st.detached.load(Relaxed) {
            // popped out: a normal window, no slams and no auto-close
            (slam, armed, away_since, had_focus, reached) = (Slam::default(), false, None, false, false);
            continue;
        }
        let geo = *st.geo.lock().unwrap();
        let c = st.cfg.lock().unwrap().clone();
        let at_edge = geo.zone.contains(x, y);
        if st.open.load(Relaxed) {
            (slam, armed) = (Slam::default(), false);
            if st.dragging.load(Relaxed) {
                // dragging a file out: focus and pointer leave on purpose, that's not a dismissal
                (had_focus, away_since) = (has_focus, None);
                continue;
            }
            let pinned = st.pinned.load(Relaxed);
            if had_focus && !has_focus && c.collapse_on_blur && !pinned {
                had_focus = false;
                set_open_later(&app, false, false);
                continue;
            }
            had_focus = has_focus;
            // quick capture: the page marks the bar (set_interactive) as the only part that takes clicks
            let bar = if st.interactive.load(Relaxed) { *st.alert_rect.lock().unwrap() } else { None };
            let through = bar.is_some_and(|r| !Rect { x: geo.win.x + r[0], y: geo.win.y + r[1], w: r[2], h: r[3] }.contains(x, y));
            if through != bar_through {
                bar_through = through;
                set_click_through(&app, through);
            }
            // a slam far along the edge (zone = whole edge) needs time to travel to the panel
            let inside = geo.hover.contains(x, y);
            reached |= inside;
            // a panel opened for a drag (shake) stays until the button is released away from it
            let away = c.collapse_on_leave && !pinned && !has_focus && !inside && !mouse_down() && (reached || ms(opened_at) > 1500.);
            match (away, away_since) {
                (false, _) => away_since = None,
                (true, None) => away_since = Some(Instant::now()),
                (true, Some(t)) if ms(t) >= c.leave_delay_ms => {
                    away_since = None;
                    set_open_later(&app, false, false);
                }
                _ => {}
            }
        } else {
            (away_since, had_focus, reached) = (None, false, false);
            let card = *st.alert_rect.lock().unwrap();
            let hot = st.interactive.load(Relaxed)
                && card.is_some_and(|r| Rect { x: geo.win.x + r[0], y: geo.win.y + r[1], w: r[2], h: r[3] }.contains(x, y));
            if hot != over_alert && card.is_some() {
                set_click_through(&app, !hot);
            }
            over_alert = hot && card.is_some();
            armed |= !at_edge; // the cursor must leave the edge before the next slam counts
            // shaking a file you're dragging (button held, quick left-right wiggles) opens the Shelf;
            // a real file drag needs less of it than any other held-button wiggle (selecting, drawing)
            let held = mouse_down();
            let scale = screen.map_or(1., |s| f64::from_bits(s.4));
            let (leg, need) = if held && file_drag() { (16. * scale, 3) } else { (24. * scale, 4) };
            if c.shake_open && shake.step(x, held, leg, need, Instant::now()) && !fullscreen {
                let _ = app.emit("shake", ());
                opened_at = Instant::now();
                set_open_later(&app, true, false); // never focus mid-drag: it breaks Explorer's drag loop
            }
            let (into, along) = (dx * geo.out.0 + dy * geo.out.1, (dx * geo.out.1 - dy * geo.out.0).abs());
            let slammed = slam.step(at_edge, into, along, raw_ok, Instant::now(), c.slam_push, c.slam_dwell_ms);
            if c.slam && armed && slammed && !fullscreen {
                (slam, armed, opened_at) = (Slam::default(), false, Instant::now());
                // focusing mid-drag breaks Explorer's drag loop, so never while a button is held
                set_open_later(&app, true, c.slam_focus && !mouse_down());
            }
        }
    }
}

/// Collects relative raw mouse movement (even while other apps have focus) into RAW_DX/RAW_DY.
/// GetCursorPos stops at the screen edge; raw input keeps reporting the hand pushing past it.
pub(crate) fn watch_raw_mouse() -> windows::core::Result<()> {
    use windows::Win32::{
        Foundation::*,
        System::LibraryLoader::GetModuleHandleW,
        UI::{Input::*, WindowsAndMessaging::*},
    };
    use windows::core::w;
    unsafe extern "system" fn proc(h: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
        if msg == WM_INPUT {
            let mut ri = RAWINPUT::default();
            let mut size = std::mem::size_of::<RAWINPUT>() as u32;
            let header = std::mem::size_of::<RAWINPUTHEADER>() as u32;
            let data = Some(&mut ri as *mut RAWINPUT as *mut core::ffi::c_void);
            let got = unsafe { GetRawInputData(HRAWINPUT(lp.0 as _), RID_INPUT, data, &mut size, header) };
            if got != u32::MAX && ri.header.dwType == RIM_TYPEMOUSE.0 {
                let m = unsafe { ri.data.mouse };
                if m.usFlags.0 & MOUSE_MOVE_ABSOLUTE.0 == 0 {
                    RAW_DX.fetch_add(m.lLastX, Relaxed);
                    RAW_DY.fetch_add(m.lLastY, Relaxed);
                }
            }
        }
        unsafe { DefWindowProcW(h, msg, wp, lp) }
    }
    unsafe {
        let instance: HINSTANCE = GetModuleHandleW(None)?.into();
        let class = WNDCLASSW { lpfnWndProc: Some(proc), hInstance: instance, lpszClassName: w!("crashpad-raw"), ..Default::default() };
        RegisterClassW(&class);
        let hwnd = CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            w!("crashpad-raw"),
            None,
            WINDOW_STYLE::default(),
            0,
            0,
            0,
            0,
            Some(HWND_MESSAGE),
            None,
            Some(instance),
            None,
        )?;
        // replaces tao's own mouse registration (one target per device class per process);
        // crashpad doesn't use tao's device events
        let mouse = RAWINPUTDEVICE { usUsagePage: 1, usUsage: 2, dwFlags: RIDEV_INPUTSINK, hwndTarget: hwnd };
        RegisterRawInputDevices(&[mouse], std::mem::size_of::<RAWINPUTDEVICE>() as u32)?;
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            DispatchMessageW(&msg);
        }
    }
    Ok(())
}

/// Give focus back to what the user was in before crashpad (prev_window). True once the
/// foreground is no longer crashpad.
pub(crate) fn hand_focus_back(app: &AppHandle) -> bool {
    activate(app.state::<Pad>().prev_window.load(Relaxed));
    !focused(app)
}

// ---------- pop-out ----------

/// Every window event (main.rs forwards them): remembers the popped-out window's rect.
pub(crate) fn window_event(app: &AppHandle, event: &WindowEvent) {
    static SAVE_QUEUED: AtomicBool = AtomicBool::new(false);
    let Some(st) = app.try_state::<Pad>() else { return }; // events can precede setup
    if !st.detached.load(Relaxed) {
        return;
    }
    // a maximized or minimized window reports the screen's (or -32000,-32000) rect: not ours to keep
    let w = main_window(app);
    if w.is_maximized().unwrap_or(false) || w.is_minimized().unwrap_or(false) {
        return;
    }
    {
        let mut c = st.cfg.lock().unwrap();
        match event {
            WindowEvent::Moved(p) => (c.float_rect[0], c.float_rect[1]) = (p.x as f64, p.y as f64),
            WindowEvent::Resized(s) if s.width > 0 && s.height > 0 => {
                (c.float_rect[2], c.float_rect[3]) = (s.width as f64, s.height as f64)
            }
            _ => return,
        }
    }
    // a drag fires dozens of these a second: save at most every 600ms, always including the last
    if !SAVE_QUEUED.swap(true, Relaxed) {
        let app = app.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(600));
            SAVE_QUEUED.store(false, Relaxed); // before reading cfg, so a later change queues again
            let _ = save_config(&app);
        });
    }
}

/// Pop the panel out into a free floating, resizable window (on) or dock it back (off).
/// Calling it with `on` while popped out re-applies cfg.floatOnTop.
#[tauri::command]
pub fn set_detached(app: AppHandle, on: bool) -> Res<()> {
    let st = app.state::<Pad>();
    let w = main_window(&app);
    let cfg = st.cfg.lock().unwrap().clone();
    if on {
        let was = st.detached.swap(true, Relaxed);
        w.set_always_on_top(cfg.float_on_top).map_err(err)?;
        if !was {
            w.set_resizable(true).map_err(err)?;
            w.set_min_size(Some(tauri::LogicalSize::new(360., 320.))).map_err(err)?;
            let r = cfg.float_rect;
            let on_screen =
                r[2] > 0. && r[3] > 0. && app.monitor_from_point(r[0] + r[2] / 2., r[1] + 24.).ok().flatten().is_some();
            let [mut x, mut y, mut fw, mut fh] = if on_screen {
                r
            } else {
                let m = app.primary_monitor().map_err(err)?.ok_or("No monitor found")?;
                let (p, s) = (m.work_area().position, m.work_area().size);
                let (fw, fh) = (s.width as f64 * 0.62, s.height as f64 * 0.72);
                [p.x as f64 + (s.width as f64 - fw) / 2., p.y as f64 + (s.height as f64 - fh) / 2., fw, fh]
            };
            // never taller or wider than the work area it's on (a maximized rect must not stick)
            if let Ok(Some(m)) = app.monitor_from_point(x + fw / 2., y + 24.) {
                let (p, sz) = (m.work_area().position, m.work_area().size);
                fw = fw.min(sz.width as f64);
                fh = fh.min(sz.height as f64);
                x = x.clamp(p.x as f64, (p.x as f64 + sz.width as f64 - fw).max(p.x as f64));
                y = y.clamp(p.y as f64, (p.y as f64 + sz.height as f64 - fh).max(p.y as f64));
            }
            let at = PhysicalPosition::new(x.round() as i32, y.round() as i32);
            w.set_position(at).map_err(err)?;
            w.set_size(PhysicalSize::new(fw.round() as u32, fh.round() as u32)).map_err(err)?;
            w.set_position(at).map_err(err)?; // again: crossing monitors may have rescaled it
        }
        set_open(&app, true, true); // not click-through, re-marked as a tool window, focused
    } else {
        if !st.detached.swap(false, Relaxed) {
            return Ok(());
        }
        if w.is_minimized().unwrap_or(false) {
            let _ = w.unminimize(); // an iconic window reports a -32000,-32000 rect
        }
        if w.is_maximized().unwrap_or(false) {
            let _ = w.unmaximize(); // else the docked window would keep the maximized bounds
        }
        if let (Ok(p), Ok(s)) = (w.outer_position(), w.inner_size()) {
            st.cfg.lock().unwrap().float_rect = [p.x as f64, p.y as f64, s.width as f64, s.height as f64];
            let _ = save_config(&app);
        }
        w.set_resizable(false).map_err(err)?;
        w.set_min_size(None::<tauri::Size>).map_err(err)?; // the docked window can be smaller
        w.set_always_on_top(true).map_err(err)?;
        place(&app).map_err(err)?;
        set_open(&app, true, true);
    }
    let _ = app.emit("mode", serde_json::json!({ "detached": on }));
    Ok(())
}

/// Pin the panel open: it ignores focus loss and the mouse leaving (Esc and the hotkey still close it).
#[tauri::command]
pub fn set_pinned(app: AppHandle, on: bool) {
    app.state::<Pad>().pinned.store(on, Relaxed);
}

/// Let the collapsed island take clicks while it shows a reminder alert. `rect` is the card
/// ([x, y, w, h] physical px inside the window): then only the card takes clicks (the mouse thread
/// flips click-through as the cursor enters/leaves it) and the rest of the window stays see-through.
#[tauri::command]
pub fn set_interactive(app: AppHandle, on: bool, rect: Option<[f64; 4]>) {
    let st = app.state::<Pad>();
    st.interactive.store(on, Relaxed);
    *st.alert_rect.lock().unwrap() = rect.filter(|_| on);
    if !st.open.load(Relaxed) {
        set_click_through(&app, !(on && rect.is_none()));
        if !on && focused(&app) {
            activate(st.prev_window.load(Relaxed)); // clicking the alert focused us; hand it back
        }
    }
}

// ---------- materials ----------

/// Frosted / liquid-glass materials: WebView2 can't blur what's behind a window, so capture it
/// (minus ourselves), shrink it and send it to the page as the `backdrop` event.
pub(crate) fn watch_backdrop(app: AppHandle) {
    use image::{ExtendedColorType, ImageEncoder, codecs::png::PngEncoder};
    use std::hash::{DefaultHasher, Hash, Hasher};
    const M: i32 = 48; // physical px captured past each side, so the blur has something to pull in
    let st = app.state::<Pad>();
    let w = main_window(&app);
    let (mut last, mut excluded) = (0u64, false);
    loop {
        let f = match st.cfg.lock().unwrap().material.as_str() {
            "frosted" => 8.,
            "glass" => 3.,
            _ => 0.,
        };
        if (f > 0.) != excluded {
            // WDA_EXCLUDEFROMCAPTURE while on, so we never capture ourselves (set before sleeping)
            excluded = f > 0.;
            let _ = w.set_content_protected(excluded);
            last = 0;
        }
        let active = st.open.load(Relaxed) || st.detached.load(Relaxed);
        thread::sleep(Duration::from_millis(if active { 200 } else { 1000 }));
        if !excluded {
            continue;
        }
        let hwnd = windows::Win32::Foundation::HWND(st.own_window.load(Relaxed) as _);
        let Some((bw, bh, rgb)) = grab(hwnd, M, f) else { continue };
        let mut h = DefaultHasher::new();
        (&rgb, active).hash(&mut h); // opening re-sends, in case the page missed the last one
        let h = h.finish();
        if h == last {
            continue;
        }
        last = h;
        let mut png = Vec::new();
        if PngEncoder::new(&mut png).write_image(&rgb, bw, bh, ExtendedColorType::Rgb8).is_err() {
            continue;
        }
        let margin = M as f64 / w.scale_factor().unwrap_or(1.);
        let url = format!("data:image/png;base64,{}", base64(&png));
        let _ = app.emit("backdrop", serde_json::json!({ "url": url, "margin": margin }));
    }
}

/// The screen behind `hwnd` plus `m` px on each side, shrunk `f` times: (width, height, RGB).
/// Parts off the window's monitor repeat its edge pixels instead of going black.
fn grab(hwnd: windows::Win32::Foundation::HWND, m: i32, f: f64) -> Option<(u32, u32, Vec<u8>)> {
    use windows::Win32::{Foundation::RECT, Graphics::Gdi::*, UI::WindowsAndMessaging::GetWindowRect};
    let mut r = RECT::default();
    let mut mi = MONITORINFO { cbSize: size_of::<MONITORINFO>() as u32, ..Default::default() };
    unsafe {
        GetWindowRect(hwnd, &mut r).ok()?;
        if !GetMonitorInfoW(MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST), &mut mi).as_bool() {
            return None;
        }
    }
    let (l, t, sw, sh) = (r.left - m, r.top - m, r.right - r.left + 2 * m, r.bottom - r.top + 2 * m);
    let (w, h) = (((sw as f64 / f).round() as i32).max(1), ((sh as f64 / f).round() as i32).max(1));
    let on = mi.rcMonitor;
    let (cl, ct, cr, cb) = (l.max(on.left), t.max(on.top), (l + sw).min(on.right), (t + sh).min(on.bottom));
    if cr <= cl || cb <= ct {
        return None;
    }
    // the on-screen part, in output pixels
    let ox = |v: i32| ((v - l) as f64 * w as f64 / sw as f64).round() as i32;
    let oy = |v: i32| ((v - t) as f64 * h as f64 / sh as f64).round() as i32;
    let (x0, y0) = (ox(cl), oy(ct));
    let (cw, ch) = ((ox(cr) - x0).max(1), (oy(cb) - y0).max(1));
    let mut px = vec![0u8; (cw * ch * 4) as usize];
    let mut bi = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: cw,
            biHeight: -ch, // top-down
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };
    // every GDI object is released on the single path through: this runs forever
    let ok = unsafe {
        let screen = GetDC(None);
        let dc = CreateCompatibleDC(Some(screen));
        let bmp = CreateCompatibleBitmap(screen, cw, ch);
        let old = SelectObject(dc, bmp.into());
        SetStretchBltMode(dc, HALFTONE);
        let _ = SetBrushOrgEx(dc, 0, 0, None);
        let blt = StretchBlt(dc, 0, 0, cw, ch, Some(screen), cl, ct, cr - cl, cb - ct, SRCCOPY | CAPTUREBLT).as_bool();
        SelectObject(dc, old);
        let rows = GetDIBits(dc, bmp, 0, ch as u32, Some(px.as_mut_ptr().cast()), &mut bi, DIB_RGB_COLORS);
        let _ = DeleteObject(bmp.into());
        let _ = DeleteDC(dc);
        ReleaseDC(None, screen);
        blt && rows == ch
    };
    if !ok {
        return None;
    }
    // BGRA → RGB (opaque), clamping into the captured part
    let mut rgb = Vec::with_capacity((w * h * 3) as usize);
    for y in 0..h {
        let row = (y - y0).clamp(0, ch - 1) * cw;
        for x in 0..w {
            let i = ((row + (x - x0).clamp(0, cw - 1)) * 4) as usize;
            rgb.extend_from_slice(&[px[i + 2], px[i + 1], px[i]]);
        }
    }
    Some((w as u32, h as u32, rgb))
}

/// Standard base64 with padding (no crate for one call site).
fn base64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::with_capacity(data.len().div_ceil(3) * 4);
    for c in data.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            s.push(if i <= c.len() { T[(n >> (18 - 6 * i) & 63) as usize] as char } else { '=' });
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slam_zone_and_hover_follow_the_edge() {
        let mon = Rect { x: 0., y: 0., w: 1920., h: 1080. };
        let work = Rect { h: 1032., ..mon }; // taskbar at the bottom
        let mut c = Config::default(); // top edge, centred, slam zone = panel width
        let (win, g) = layout(&c, mon, work, 1.0);
        assert_eq!((win.y, win.x + win.w / 2.), (0., 960.));
        assert!(g.zone.contains(960., 0.) && !g.zone.contains(960., 1.) && !g.zone.contains(5., 0.));
        assert!(g.hover.contains(960., 0.) && g.hover.contains(960., 300.) && !g.hover.contains(960., 600.));

        c.edge = "bottom".into();
        c.slam_zone = "edge".into();
        let (win, g) = layout(&c, mon, work, 1.5);
        assert!((win.y + win.h - 1032.).abs() < 1e-6, "sits above the taskbar");
        assert!(g.zone.contains(5., 1079.) && !g.zone.contains(5., 1078.));
        assert!(g.hover.contains(960., 1079.) && !g.hover.contains(960., 100.));

        c.edge = "right".into();
        c.offset = 0.;
        let (win, g) = layout(&c, mon, work, 1.0);
        assert_eq!((win.x + win.w, win.y), (1920., 0.));
        assert!(g.zone.contains(1919., 500.) && !g.zone.contains(1918., 500.));

        // corner, flush style: no gap, offset and "edge" zone ignored, 3x3 slam square, diagonal out
        c.edge = "top-right".into();
        c.dock_style = "notch".into();
        let (win, g) = layout(&c, mon, work, 1.0);
        assert_eq!((win.x + win.w, win.y, win.h), (1920., 0., 400. + pad(&c)));
        assert!(g.zone.contains(1919., 0.) && g.zone.contains(1917., 2.));
        assert!(!g.zone.contains(1916., 0.) && !g.zone.contains(1919., 3.) && !g.zone.contains(960., 0.));
        assert!(g.hover.contains(1919., 0.) && g.hover.contains(1600., 200.));
        assert!(!g.hover.contains(1000., 200.) && !g.hover.contains(1600., 450.));
        assert!((g.out.0 - std::f64::consts::FRAC_1_SQRT_2).abs() < 1e-9 && g.out.0 == -g.out.1);
    }

    #[test]
    fn base64_matches_the_standard() {
        let enc = |s: &str| base64(s.as_bytes());
        assert_eq!([enc(""), enc("M"), enc("Ma"), enc("Man"), enc("Many!")], ["", "TQ==", "TWE=", "TWFu", "TWFueSE="]);
    }

    #[test]
    fn shake_needs_quick_reversals_while_holding() {
        let t = Instant::now();
        let at = |ms: u64| t + Duration::from_millis(ms);
        let mut s = Shake::default();
        // a slow drag across the screen is not a shake
        assert!(!(0..40).any(|i| s.step(i as f64 * 20., true, 30., 4, at(i * 16))));
        // four quick wiggles of 60 px are
        let mut s = Shake::default();
        let mut fired = false;
        for (i, x) in [0., 60., 0., 60., 0., 60., 0.].iter().enumerate() {
            fired |= s.step(*x, true, 30., 4, at(i as u64 * 60));
        }
        assert!(fired);
        // and only once while the button stays down; releasing re-arms
        assert!(!s.step(60., true, 30., 4, at(500)));
        assert!(!s.step(60., false, 30., 4, at(520)));
        assert!(!s.fired);
        // a modest 45 px wiggle sampled every 16 ms (5 px steps) after a steady drag also fires
        let mut s = Shake::default();
        let (mut x, mut fired, mut i) = (0., false, 0u64);
        for _ in 0..40 {
            x += 5.;
            s.step(x, true, 30., 4, at(i * 16));
            i += 1;
        }
        for leg in 0..6 {
            for _ in 0..9 {
                x += if leg % 2 == 0 { -5. } else { 5. };
                fired |= s.step(x, true, 30., 4, at(i * 16));
                i += 1;
            }
        }
        assert!(fired, "45 px triangle shake should open");
        // dragging a file: three relaxed wiggles (~4 per second, 30 px at 150%) are enough
        let mut s = Shake::default();
        let fired = [0., 30., 0., 30., 0.].iter().enumerate().any(|(i, x)| s.step(*x, true, 24., 3, at(i as u64 * 240)));
        assert!(fired, "a relaxed shake while dragging a file");
        let mut s = Shake::default();
        let fired = [0., 30., 0., 30., 0.].iter().enumerate().any(|(i, x)| s.step(*x, true, 36., 4, at(i as u64 * 240)));
        assert!(!fired, "the same wiggle without a file drag");
    }

    #[test]
    fn slam_needs_a_push_not_a_rest() {
        let t = Instant::now();
        let at = |ms: u64| t + Duration::from_millis(ms);
        // resting on the edge (browser tab, taskbar) never opens
        let mut s = Slam::default();
        assert!(!(0..100).any(|i| s.step(true, 0., 0., true, at(i * 16), 150., 150.)));
        // sliding along the edge between tabs, drifting slightly into it, never opens
        let mut s = Slam::default();
        assert!(!(0..100).any(|i| s.step(true, 10., 60., true, at(i * 16), 150., 150.)));
        // the arriving tick's movement doesn't count; pushing while pinned does
        let mut s = Slam::default();
        assert!(!s.step(true, 500., 0., true, at(0), 150., 150.));
        assert!(!s.step(true, 100., 0., true, at(16), 150., 150.));
        assert!(s.step(true, 60., 0., true, at(32), 150., 150.));
        // nudges further apart than 300ms don't add up
        let mut s = Slam::default();
        s.step(true, 0., 0., true, at(0), 150., 150.);
        assert!(!s.step(true, 100., 0., true, at(16), 150., 150.));
        assert!(!s.step(true, 100., 0., true, at(400), 150., 150.));
        // leaving the edge resets
        assert!(!s.step(false, 0., 0., true, at(416), 150., 150.));
        assert!(!s.step(true, 100., 0., true, at(432), 150., 150.));
        // no raw input (touchpad): holding at the edge for the dwell opens
        let mut s = Slam::default();
        assert!(!s.step(true, 0., 0., false, at(0), 150., 150.));
        assert!(s.step(true, 0., 0., false, at(160), 150., 150.));
    }

}
