//! Live: system stats, what's playing (Windows media sessions) and countdown timers.

use super::*;
use windows::{
    Media::Control::{
        GlobalSystemMediaTransportControlsSessionManager as Smtc,
        GlobalSystemMediaTransportControlsSessionMediaProperties as Props,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
    },
    Storage::Streams::DataReader,
    Win32::{
        Foundation::FILETIME,
        Graphics::Dxgi::{
            CreateDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE, DXGI_MEMORY_SEGMENT_GROUP_LOCAL, DXGI_QUERY_VIDEO_MEMORY_INFO,
            IDXGIAdapter3, IDXGIFactory1,
        },
        NetworkManagement::{
            IpHelper::{FreeMibTable, GetIfTable2, IF_TYPE_SOFTWARE_LOOPBACK, MIB_IF_ROW2, MIB_IF_TABLE2},
            Ndis::IfOperStatusUp,
        },
        Storage::FileSystem::GetDiskFreeSpaceExW,
        System::{
            Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS},
            Registry::{HKEY_LOCAL_MACHINE, RRF_RT_REG_DWORD, RRF_RT_REG_SZ, RegGetValueW},
            SystemInformation::{GetLogicalProcessorInformationEx, GetTickCount64, GlobalMemoryStatusEx, MEMORYSTATUSEX, RelationProcessorCore},
            Threading::GetSystemTimes,
            WinRT::{RO_INIT_MULTITHREADED, RoInitialize},
        },
    },
    core::{HSTRING, Interface},
};

/// Set once the page has fetched the list, i.e. it's listening for "timer-done"; until then timers
/// that ran out while crashpad was off wait (they still alert, once).
static PAGE_READY: AtomicBool = AtomicBool::new(false);

/// A countdown. While running `end` is the absolute end (ms since the epoch) and `left` is
/// unused; while paused `left` holds the remaining ms and `end` is 0.
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Timer {
    pub id: u64,
    pub label: String,
    pub total: u64,
    pub end: u64,
    pub left: u64,
    pub done: bool,
}

/// Static machine facts for the Live tab.
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Specs {
    pub cpu: String,
    pub cores: u32,
    pub threads: u32,
    pub ram_total: u64,
    pub gpus: Vec<String>,
    pub os: String,
    pub host: String,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct Stats {
    cpu: f64,
    mem_used: u64,
    mem_total: u64,
    gpus: Vec<Gpu>,
    disk_used: u64,
    disk_total: u64,
    net_up: u64,
    net_down: u64,
    battery: Option<u8>,
    charging: bool,
    uptime: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Gpu {
    name: String,
    vram_used: u64,
    vram_total: u64,
}

#[derive(Serialize, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Media {
    title: String,
    artist: String,
    album: String,
    app: String,
    /// playing | paused | stopped | none
    status: String,
    position: u64,
    duration: u64,
    /// data:image/… URL, or "" when the app gives none.
    thumb: String,
}

// ---------- timers ----------

fn file(app: &AppHandle) -> PathBuf {
    data_dir(app).join("timers.json")
}

/// Running (soonest first), then paused, then done.
fn sort(list: &mut [Timer]) {
    list.sort_by_key(|t| (t.done, t.end == 0, if t.end > 0 { t.end } else { t.left }));
}

/// Mark running timers whose end has passed as done and return them.
fn finish(list: &mut [Timer], now: u64) -> Vec<Timer> {
    list.iter_mut()
        .filter(|t| !t.done && t.end > 0 && t.end <= now)
        .map(|t| {
            t.done = true;
            t.clone()
        })
        .collect()
}

/// pause | resume | restart; pause/resume are no-ops when the timer is already in that state.
fn apply(t: &mut Timer, action: &str, now: u64) -> Res<()> {
    match action {
        "pause" if t.end > 0 && !t.done => (t.left, t.end) = (t.end.saturating_sub(now), 0),
        "resume" if t.end == 0 && !t.done => (t.end, t.left) = (now + t.left, 0),
        "restart" => (t.end, t.left, t.done) = (now + t.total, 0, false),
        "pause" | "resume" => {}
        _ => return Err(format!("Unknown timer action: {action}")),
    }
    Ok(())
}

pub(crate) fn load(app: &AppHandle) {
    let path = file(app);
    let mut list: Vec<Timer> = match fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_else(|e| {
            eprintln!("crashpad: unreadable timers ({e}); kept a copy as timers.json.bad");
            let _ = fs::copy(&path, path.with_extension("json.bad"));
            Vec::new()
        }),
        Err(_) => Vec::new(),
    };
    sort(&mut list);
    *app.state::<Pad>().timers.lock().unwrap() = list;
}

/// Sort, broadcast and save. Callers hold the timers lock, so saves and events stay in order.
fn commit(app: &AppHandle, list: &mut [Timer]) -> Res<Vec<Timer>> {
    sort(list);
    let _ = app.emit("timers", &*list);
    let json = serde_json::to_vec_pretty(&*list).map_err(err)?;
    write_atomic(&file(app), json).map_err(|e| format!("Couldn't save timers: {e}"))?;
    Ok(list.to_vec())
}

fn edit(app: &AppHandle, f: impl FnOnce(&mut Vec<Timer>) -> Res<()>) -> Res<Vec<Timer>> {
    let st = app.state::<Pad>();
    let mut list = st.timers.lock().unwrap();
    f(&mut list)?;
    commit(app, &mut list)
}

fn finish_due(app: &AppHandle) {
    if !PAGE_READY.load(Relaxed) {
        return;
    }
    let st = app.state::<Pad>();
    let mut list = st.timers.lock().unwrap();
    let done = finish(&mut list, now_ms());
    if !done.is_empty() {
        let _ = commit(app, &mut list);
        for t in done {
            let _ = app.emit("timer-done", t);
        }
    }
}

#[tauri::command]
pub fn get_timers(st: State<Pad>) -> Vec<Timer> {
    PAGE_READY.store(true, Relaxed);
    st.timers.lock().unwrap().clone()
}

#[tauri::command]
pub fn add_timer(app: AppHandle, label: String, ms: u64) -> Res<Vec<Timer>> {
    if ms == 0 {
        return Err("A timer needs a duration".into());
    }
    edit(&app, |list| {
        let now = now_ms();
        let id = list.iter().map(|t| t.id + 1).max().unwrap_or(0).max(now);
        list.push(Timer { id, label: label.trim().into(), total: ms, end: now + ms, ..Default::default() });
        Ok(())
    })
}

/// action: "pause" | "resume" | "restart"
#[tauri::command]
pub fn update_timer(app: AppHandle, id: u64, action: String) -> Res<Vec<Timer>> {
    edit(&app, |list| {
        let t = list.iter_mut().find(|t| t.id == id).ok_or("That timer is gone")?;
        apply(t, &action, now_ms())
    })
}

#[tauri::command]
pub fn remove_timer(app: AppHandle, id: u64) -> Res<Vec<Timer>> {
    edit(&app, |list| {
        list.retain(|t| t.id != id);
        Ok(())
    })
}

// ---------- stats (Win32) ----------

fn ft(f: FILETIME) -> u64 {
    (f.dwHighDateTime as u64) << 32 | f.dwLowDateTime as u64
}

/// (idle, kernel + user) in 100 ns ticks; kernel time includes idle.
fn cpu_times() -> Option<(u64, u64)> {
    let (mut i, mut k, mut u) = (FILETIME::default(), FILETIME::default(), FILETIME::default());
    unsafe { GetSystemTimes(Some(&mut i), Some(&mut k), Some(&mut u)).ok()? };
    Some((ft(i), ft(k) + ft(u)))
}

fn memory() -> Option<MEMORYSTATUSEX> {
    let mut m = MEMORYSTATUSEX { dwLength: size_of::<MEMORYSTATUSEX>() as u32, ..Default::default() };
    unsafe { GlobalMemoryStatusEx(&mut m).ok()? };
    Some(m)
}

/// (used, total) bytes on the system drive.
fn disk() -> Option<(u64, u64)> {
    let root = format!("{}\\", std::env::var("SystemDrive").unwrap_or("C:".into()));
    let (mut total, mut free) = (0u64, 0u64);
    unsafe { GetDiskFreeSpaceExW(&HSTRING::from(root), None, Some(&mut total), Some(&mut free)).ok()? };
    Some((total.saturating_sub(free), total))
}

/// Total (in, out) bytes over every up, non-loopback interface.
fn octets() -> Option<(u64, u64)> {
    let mut table: *mut MIB_IF_TABLE2 = std::ptr::null_mut();
    unsafe {
        if !GetIfTable2(&mut table).is_ok() || table.is_null() {
            return None;
        }
        let n = (*table).NumEntries as usize;
        let rows = std::slice::from_raw_parts(std::ptr::addr_of!((*table).Table).cast::<MIB_IF_ROW2>(), n);
        let up = |r: &MIB_IF_ROW2| r.Type != IF_TYPE_SOFTWARE_LOOPBACK && r.OperStatus == IfOperStatusUp;
        // physical NICs only, else a VPN or virtual switch counts the same bytes twice; a VM may have none
        let hw = |r: &MIB_IF_ROW2| r.InterfaceAndOperStatusFlags._bitfield & 1 != 0;
        let any_hw = rows.iter().any(|r| up(r) && hw(r));
        let (mut i, mut o) = (0u64, 0u64);
        for r in rows.iter().filter(|r| up(r) && (!any_hw || hw(r))) {
            (i, o) = (i + r.InOctets, o + r.OutOctets);
        }
        FreeMibTable(table.cast());
        Some((i, o))
    }
}

/// (battery % or None without one, on AC power)
fn power() -> (Option<u8>, bool) {
    let mut s = SYSTEM_POWER_STATUS::default();
    if unsafe { GetSystemPowerStatus(&mut s) }.is_err() {
        return (None, false);
    }
    let pct = (s.BatteryFlag & 128 == 0 && s.BatteryLifePercent <= 100).then_some(s.BatteryLifePercent);
    (pct, s.ACLineStatus == 1)
}

/// Real GPUs (name, dedicated VRAM, adapter); software renderers are skipped.
fn adapters() -> Vec<(String, u64, IDXGIAdapter3)> {
    let mut out = Vec::new();
    unsafe {
        let Ok(factory) = CreateDXGIFactory1::<IDXGIFactory1>() else { return out };
        for i in 0.. {
            let Ok(a) = factory.EnumAdapters1(i) else { break };
            let Ok(d) = a.GetDesc1() else { continue };
            let name = String::from_utf16_lossy(&d.Description).trim_end_matches('\0').trim().to_string();
            if d.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 != 0 || name.contains("Microsoft Basic Render") {
                continue;
            }
            if let Ok(a3) = a.cast::<IDXGIAdapter3>() {
                out.push((name, d.DedicatedVideoMemory as u64, a3));
            }
        }
    }
    out
}

fn vram(a: &IDXGIAdapter3) -> Option<DXGI_QUERY_VIDEO_MEMORY_INFO> {
    let mut m = DXGI_QUERY_VIDEO_MEMORY_INFO::default();
    unsafe { a.QueryVideoMemoryInfo(0, DXGI_MEMORY_SEGMENT_GROUP_LOCAL, &mut m).ok()? };
    Some(m)
}

// ---------- specs (registry) ----------

fn reg_str(sub: &str, name: &str) -> String {
    let (sub, name) = (HSTRING::from(sub), HSTRING::from(name));
    let mut len = 0u32;
    unsafe {
        if !RegGetValueW(HKEY_LOCAL_MACHINE, &sub, &name, RRF_RT_REG_SZ, None, None, Some(&mut len)).is_ok() {
            return String::new();
        }
        let mut buf = vec![0u16; len as usize / 2 + 1];
        if !RegGetValueW(HKEY_LOCAL_MACHINE, &sub, &name, RRF_RT_REG_SZ, None, Some(buf.as_mut_ptr().cast()), Some(&mut len)).is_ok() {
            return String::new();
        }
        String::from_utf16_lossy(&buf[..len as usize / 2]).trim_end_matches('\0').trim().to_string()
    }
}

fn reg_dword(sub: &str, name: &str) -> u32 {
    let (mut v, mut len) = (0u32, 4u32);
    let _ = unsafe {
        RegGetValueW(HKEY_LOCAL_MACHINE, &HSTRING::from(sub), &HSTRING::from(name), RRF_RT_REG_DWORD, None, Some((&mut v as *mut u32).cast()), Some(&mut len))
    };
    v
}

/// "Windows 11 Pro 24H2 (build 26200.1234)". ProductName still says "Windows 10" on 11, so the
/// build number decides.
fn os_name() -> String {
    const K: &str = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion";
    let (build, mut product) = (reg_str(K, "CurrentBuildNumber"), reg_str(K, "ProductName"));
    if build.parse::<u32>().unwrap_or(0) >= 22000 {
        product = product.replace("Windows 10", "Windows 11");
    }
    let s = format!("{product} {} (build {build}.{})", reg_str(K, "DisplayVersion"), reg_dword(K, "UBR"));
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Physical cores: RelationProcessorCore entries of GetLogicalProcessorInformationEx (each entry is
/// (relationship: u32, size: u32, …), variable length).
fn core_count() -> u32 {
    let mut len = 0u32;
    unsafe {
        let _ = GetLogicalProcessorInformationEx(RelationProcessorCore, None, &mut len);
        let mut buf = vec![0u8; len as usize];
        if len == 0 || GetLogicalProcessorInformationEx(RelationProcessorCore, Some(buf.as_mut_ptr().cast()), &mut len).is_err() {
            return 0;
        }
        count_cores(&buf[..len as usize])
    }
}

fn count_cores(buf: &[u8]) -> u32 {
    let (mut off, mut n) = (0, 0);
    while off + 8 <= buf.len() {
        let u32_at = |i: usize| u32::from_ne_bytes(buf[i..i + 4].try_into().unwrap());
        let (rel, size) = (u32_at(off), u32_at(off + 4));
        if size == 0 {
            break;
        }
        n += (rel == RelationProcessorCore.0 as u32) as u32;
        off += size as usize;
    }
    n
}

#[tauri::command]
pub async fn get_specs(app: AppHandle) -> Res<Specs> {
    let _ = app;
    Ok(Specs {
        cpu: reg_str(r"HARDWARE\DESCRIPTION\System\CentralProcessor\0", "ProcessorNameString"),
        cores: core_count(),
        threads: thread::available_parallelism().map_or(0, |n| n.get() as u32),
        ram_total: memory().map_or(0, |m| m.ullTotalPhys),
        gpus: adapters().into_iter().map(|(name, ..)| name).collect(),
        os: os_name(),
        host: std::env::var("COMPUTERNAME").unwrap_or_default(),
    })
}

// ---------- media (WinRT GlobalSystemMediaTransportControls) ----------

/// Standard base64 with padding (dock.rs has the same for the backdrop; both private).
fn b64(data: &[u8]) -> String {
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

/// The album art as a data: URL (up to 4 MB).
fn thumb(p: &Props) -> Option<String> {
    let stream = p.Thumbnail().ok()?.OpenReadAsync().ok()?.get().ok()?;
    let size = stream.Size().ok()?;
    if size == 0 || size > 4 << 20 {
        return None;
    }
    let mime = stream.ContentType().map(|h| h.to_string()).unwrap_or_default();
    let reader = DataReader::CreateDataReader(&stream).ok()?;
    reader.LoadAsync(size as u32).ok()?.get().ok()?;
    let mut buf = vec![0u8; size as usize];
    reader.ReadBytes(&mut buf).ok()?;
    let mime = if mime.starts_with("image/") { mime } else { "image/png".into() };
    Some(format!("data:{mime};base64,{}", b64(&buf)))
}

/// Windows FILETIME-style now: 100 ns ticks since 1601 (what a WinRT DateTime holds).
fn ticks_now() -> i64 {
    (now_ms() as i64 + 11_644_473_600_000) * 10_000
}

#[derive(Default)]
struct MediaWatch {
    mgr: Option<Smtc>,
    last: Media,
    /// title + artist the cached thumbnail belongs to
    key: String,
    thumb: String,
    /// art re-reads left for this track (players publish the art a little after the title)
    tries: u8,
    /// which track's art the page already has (the 1 Hz payload carries it only once)
    sent_key: String,
}

/// The last full media state, for a page that (re)loads while nothing is changing.
static LAST_MEDIA: Mutex<Option<Media>> = Mutex::new(None);

#[tauri::command]
pub fn get_media() -> Option<Media> {
    LAST_MEDIA.lock().unwrap().clone()
}

impl MediaWatch {
    fn read(&mut self) -> Option<Media> {
        if self.mgr.is_none() {
            self.mgr = Smtc::RequestAsync().ok()?.get().ok();
        }
        let s = self.mgr.as_ref()?.GetCurrentSession().ok()?;
        let status = s.GetPlaybackInfo().ok()?.PlaybackStatus().ok()?;
        let playing = status == Status::Playing;
        let status = match status {
            Status::Playing => "playing",
            Status::Paused => "paused",
            Status::Closed => return None,
            _ => "stopped",
        };
        let p = s.TryGetMediaPropertiesAsync().ok()?.get().ok()?;
        let text = |r: windows::core::Result<HSTRING>| r.map(|h| h.to_string()).unwrap_or_default();
        let (title, artist, album) = (text(p.Title()), text(p.Artist()), text(p.AlbumTitle()));
        let key = format!("{title}\0{artist}");
        if key != self.key {
            (self.key, self.thumb, self.tries) = (key, String::new(), 0);
        }
        if self.thumb.is_empty() && self.tries < 5 {
            self.tries += 1;
            self.thumb = thumb(&p).unwrap_or_default();
        }
        let (mut position, mut duration) = (0, 0);
        if let Ok(tl) = s.GetTimelineProperties() {
            let start = tl.StartTime().map_or(0, |t| t.Duration);
            duration = (tl.EndTime().map_or(0, |t| t.Duration) - start).max(0);
            position = tl.Position().map_or(0, |t| t.Duration) - start;
            // apps report the position as of LastUpdatedTime (many only on seek); run it forward
            let upd = tl.LastUpdatedTime().map_or(0, |t| t.UniversalTime);
            if playing && upd > 0 {
                position += (ticks_now() - upd).max(0);
            }
            position = position.clamp(0, duration.max(position.min(0)));
        }
        Some(Media {
            title,
            artist,
            album,
            app: text(s.SourceAppUserModelId()),
            status: status.into(),
            position: position as u64 / 10_000,
            duration: duration as u64 / 10_000,
            thumb: self.thumb.clone(),
        })
    }

    /// Emit "media" when anything changed (the position ticks while playing).
    fn tick(&mut self, app: &AppHandle) {
        let m = self.read().unwrap_or(Media { status: "none".into(), ..Default::default() });
        if m != self.last {
            // the art (up to MBs) rides along only when the page doesn't have this track's yet;
            // an empty thumb with an unchanged title means "keep what you have"
            let art_key = format!("{}\0{}\0{}", m.title, m.artist, !m.thumb.is_empty());
            let fresh = art_key != self.sent_key;
            let _ = app.emit("media", Media { thumb: if fresh { m.thumb.clone() } else { String::new() }, ..m.clone() });
            if fresh {
                self.sent_key = art_key;
            }
            *LAST_MEDIA.lock().unwrap() = Some(m.clone());
            self.last = m;
        }
    }
}

/// action: "toggle" | "play" | "pause" | "next" | "prev"
#[tauri::command]
pub async fn media_control(app: AppHandle, action: String) -> Res<()> {
    let _ = app;
    // WinRT wants an initialised thread; the async runtime's workers aren't
    tauri::async_runtime::spawn_blocking(move || {
        unsafe { let _ = RoInitialize(RO_INIT_MULTITHREADED); }
        let s = Smtc::RequestAsync().and_then(|op| op.get()).and_then(|m| m.GetCurrentSession()).map_err(|_| "Nothing is playing")?;
        let op = match action.as_str() {
            "toggle" => s.TryTogglePlayPauseAsync(),
            "play" => s.TryPlayAsync(),
            "pause" => s.TryPauseAsync(),
            "next" => s.TrySkipNextAsync(),
            "prev" => s.TrySkipPreviousAsync(),
            _ => return Err(format!("Unknown media action: {action}")),
        };
        match op.and_then(|op| op.get()) {
            Ok(true) => Ok(()),
            Ok(false) => Err("The player refused".into()),
            Err(e) => Err(err(e)),
        }
    })
    .await
    .map_err(err)?
}

// ---------- the 1 Hz watcher ----------

/// 1 Hz: emits "stats", "media" (when it changes) and "timers"/"timer-done".
pub(crate) fn watch(app: AppHandle) {
    unsafe { let _ = RoInitialize(RO_INIT_MULTITHREADED); }
    // ponytail: adapters enumerated once; a GPU hot-plug needs a restart
    let gpus = adapters();
    let (mut cpu, mut net, mut media) = (cpu_times(), octets(), MediaWatch::default());
    let mut at = Instant::now();
    loop {
        thread::sleep(Duration::from_secs(1));
        finish_due(&app);
        let dt = at.elapsed().as_secs_f64().max(0.001);
        at = Instant::now();
        let (c, n) = (cpu_times(), octets());
        let rate = |a: u64, b: u64| (b.saturating_sub(a) as f64 / dt) as u64;
        let mem = memory();
        let (battery, charging) = power();
        let stats = Stats {
            cpu: match (cpu, c) {
                (Some((i0, t0)), Some((i1, t1))) if t1 > t0 => (100. * (1. - (i1 - i0) as f64 / (t1 - t0) as f64)).clamp(0., 100.),
                _ => 0.,
            },
            mem_used: mem.map_or(0, |m| m.ullTotalPhys - m.ullAvailPhys),
            mem_total: mem.map_or(0, |m| m.ullTotalPhys),
            gpus: gpus
                .iter()
                .map(|(name, dedicated, a)| {
                    let v = vram(a);
                    Gpu {
                        name: name.clone(),
                        vram_used: v.as_ref().map_or(0, |v| v.CurrentUsage),
                        vram_total: (*dedicated).max(v.as_ref().map_or(0, |v| v.Budget)),
                    }
                })
                .collect(),
            disk_used: disk().map_or(0, |d| d.0),
            disk_total: disk().map_or(0, |d| d.1),
            net_down: match (net, n) { (Some((i0, _)), Some((i1, _))) => rate(i0, i1), _ => 0 },
            net_up: match (net, n) { (Some((_, o0)), Some((_, o1))) => rate(o0, o1), _ => 0 },
            battery,
            charging,
            uptime: unsafe { GetTickCount64() } / 1000,
        };
        (cpu, net) = (c, n);
        let _ = app.emit("stats", &stats);
        media.tick(&app);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timer_lifecycle() {
        let mut t = Timer { id: 1, total: 60_000, end: 100_000, ..Default::default() };
        apply(&mut t, "pause", 40_000).unwrap();
        assert_eq!((t.end, t.left), (0, 60_000), "pausing banks what's left");
        apply(&mut t, "pause", 45_000).unwrap();
        assert_eq!((t.end, t.left), (0, 60_000), "pausing twice changes nothing");
        apply(&mut t, "resume", 50_000).unwrap();
        assert_eq!((t.end, t.left), (110_000, 0), "resuming re-arms from now");
        assert!(finish(&mut [t.clone()], 109_999).is_empty());
        let mut list = vec![t.clone(), Timer { id: 2, end: 0, left: 5, ..Default::default() }];
        assert_eq!(finish(&mut list, 110_000).len(), 1, "running timers past their end finish; paused ones don't");
        assert!(list[0].done && finish(&mut list, 200_000).is_empty(), "each finishes once");
        apply(&mut list[0], "restart", 200_000).unwrap();
        assert_eq!((list[0].end, list[0].done), (260_000, false));
        assert!(apply(&mut t, "explode", 0).is_err());
        let mut list = vec![Timer { id: 1, done: true, ..Default::default() }, Timer { id: 2, end: 0, left: 9, ..Default::default() }, Timer { id: 3, end: 500, ..Default::default() }, Timer { id: 4, end: 300, ..Default::default() }];
        sort(&mut list);
        assert_eq!(list.iter().map(|t| t.id).collect::<Vec<_>>(), [4, 3, 2, 1], "running by end, then paused, then done");
    }

    #[test]
    fn cores_and_base64() {
        // two entries: (RelationProcessorCore, 16 bytes …) then (RelationCache = 2, 8 bytes)
        let mut buf = vec![];
        buf.extend(0u32.to_ne_bytes());
        buf.extend(16u32.to_ne_bytes());
        buf.extend([0u8; 8]);
        buf.extend(2u32.to_ne_bytes());
        buf.extend(8u32.to_ne_bytes());
        assert_eq!(count_cores(&buf), 1);
        assert_eq!(b64(b"Man"), "TWFu");
        assert_eq!(b64(b"Ma"), "TWE=");
        assert_eq!(b64(b"M"), "TQ==");
    }
}
