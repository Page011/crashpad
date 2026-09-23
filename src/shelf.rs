//! Shelf: files parked for a moment (drop or shake-drop them in), to drag out later, copy, or zip.
//! Items are references to files that live elsewhere; the shelf never copies or moves them.

use super::*;
use std::os::windows::process::CommandExt as _;

/// A parked file (a reference, not a copy). `kind`: "image" | "file" | "folder".
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Item {
    pub id: u64,
    pub path: String,
    pub name: String,
    pub kind: String,
    pub size: u64,
    pub added: u64,
}

fn file(app: &AppHandle) -> PathBuf {
    data_dir(app).join("shelf.json")
}

/// What an existing path is (kind, size); None if it's gone. Folders have size 0.
fn describe(p: &Path) -> Option<(&'static str, u64)> {
    let meta = fs::metadata(p).ok()?;
    Some(if meta.is_dir() { ("folder", 0) } else if is_image(p) { ("image", meta.len()) } else { ("file", meta.len()) })
}

/// Put a path on top of the shelf unless it's already there (Windows paths: case doesn't matter).
fn park(list: &mut Vec<Item>, path: PathBuf, kind: &str, size: u64, now: u64) -> bool {
    let p: String = path.to_string_lossy().into();
    if list.iter().any(|i| i.path.eq_ignore_ascii_case(&p)) {
        return false;
    }
    let id = list.iter().map(|i| i.id + 1).max().unwrap_or(0).max(now);
    let name = path.file_name().map_or_else(|| p.clone(), |n| n.to_string_lossy().into());
    list.insert(0, Item { id, path: p, name, kind: kind.into(), size, added: now });
    true
}

pub(crate) fn load(app: &AppHandle) {
    let path = file(app);
    let mut list: Vec<Item> = match fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_else(|e| {
            eprintln!("crashpad: unreadable shelf ({e}); kept a copy as shelf.json.bad");
            let _ = fs::copy(&path, path.with_extension("json.bad"));
            Vec::new()
        }),
        Err(_) => Vec::new(),
    };
    list.retain(|i| Path::new(&i.path).exists());
    let scope = app.asset_protocol_scope(); // thumbnails: the scope isn't persisted
    for i in list.iter().filter(|i| i.kind == "image") {
        let _ = scope.allow_file(&i.path);
    }
    *app.state::<Pad>().shelf.lock().unwrap() = list;
}

/// Broadcast and save. Callers hold the shelf lock, so events and saves stay in order.
fn commit(app: &AppHandle, list: &[Item]) -> Res<Vec<Item>> {
    let _ = app.emit("shelf", list);
    let json = serde_json::to_vec_pretty(list).map_err(err)?;
    write_atomic(&file(app), json).map_err(|e| format!("Couldn't save the shelf: {e}"))?;
    Ok(list.to_vec())
}

fn edit(app: &AppHandle, f: impl FnOnce(&mut Vec<Item>) -> Res<()>) -> Res<Vec<Item>> {
    let st = app.state::<Pad>();
    let mut list = st.shelf.lock().unwrap();
    f(&mut list)?;
    commit(app, &list)
}

/// Paths of the items with these ids that still exist, in shelf order.
fn paths(app: &AppHandle, ids: &[u64]) -> Res<Vec<PathBuf>> {
    let st = app.state::<Pad>();
    let list = st.shelf.lock().unwrap();
    let wanted: Vec<PathBuf> = list.iter().filter(|i| ids.contains(&i.id)).map(|i| PathBuf::from(&i.path)).collect();
    if wanted.is_empty() {
        return Err("Nothing selected".into());
    }
    let paths: Vec<PathBuf> = wanted.into_iter().filter(|p| p.exists()).collect();
    if paths.is_empty() {
        return Err("Those files no longer exist".into());
    }
    Ok(paths)
}

// ---------- zip helpers ----------

/// The bare zip stem the page asked for: file-name-safe, without a trailing .zip.
fn zip_name(name: &str) -> Res<String> {
    let mut s: String = name.trim().chars().map(|c| if r#"<>:"/\|?*"#.contains(c) || c.is_control() { '-' } else { c }).collect();
    if s.to_ascii_lowercase().ends_with(".zip") {
        s.truncate(s.len() - 4);
    }
    let s = s.trim().trim_end_matches('.').to_string();
    if s.is_empty() {
        return Err("Name the zip first".into());
    }
    bare_name(&s)?;
    Ok(s)
}

/// PowerShell single-quoted literal: nothing expands, only ' needs doubling.
fn ps_quote(p: &Path) -> String {
    format!("'{}'", p.to_string_lossy().replace('\'', "''"))
}

// ponytail: Windows PowerShell's Compress-Archive caps at 2 GB per entry; shell out to tar/7z if that bites.
fn ps_script(paths: &[PathBuf], zip: &Path) -> String {
    let list = paths.iter().map(|p| ps_quote(p)).collect::<Vec<_>>().join(",");
    format!("$ErrorActionPreference='Stop'; Compress-Archive -LiteralPath {list} -DestinationPath {} -Force", ps_quote(zip))
}

// ---------- commands ----------

#[tauri::command]
pub fn get_shelf(st: State<Pad>) -> Vec<Item> {
    st.shelf.lock().unwrap().clone()
}

/// Park files (absolute paths from a drop). Returns the whole shelf.
#[tauri::command]
pub async fn shelf_add(app: AppHandle, paths: Vec<PathBuf>) -> Res<Vec<Item>> {
    let found: Vec<_> = paths.into_iter().filter_map(|p| describe(&p).map(|(k, s)| (p, k, s))).collect();
    if found.is_empty() {
        return Err("Nothing there to park".into());
    }
    let scope = app.asset_protocol_scope();
    edit(&app, |list| {
        let now = now_ms();
        for (p, kind, size) in found {
            if kind == "image" {
                let _ = scope.allow_file(&p);
            }
            park(list, p, kind, size, now);
        }
        Ok(())
    })
}

#[tauri::command]
pub fn shelf_remove(app: AppHandle, ids: Vec<u64>) -> Res<Vec<Item>> {
    edit(&app, |list| {
        list.retain(|i| !ids.contains(&i.id));
        Ok(())
    })
}

#[tauri::command]
pub fn shelf_clear(app: AppHandle) -> Res<Vec<Item>> {
    edit(&app, |list| {
        list.clear();
        Ok(())
    })
}

#[tauri::command]
pub async fn shelf_open(app: AppHandle, id: u64) -> Res<()> {
    open_path(&app, &paths(&app, &[id])?[0])
}

#[tauri::command]
pub async fn shelf_reveal(app: AppHandle, id: u64) -> Res<()> {
    app.opener().reveal_item_in_dir(&paths(&app, &[id])?[0]).map_err(err)
}

/// Put the files on the clipboard (CF_HDROP), so they can be pasted into Explorer or any app.
#[tauri::command]
pub fn shelf_copy(app: AppHandle, ids: Vec<u64>) -> Res<()> {
    let files: Vec<String> = paths(&app, &ids)?.iter().map(|p| p.to_string_lossy().into()).collect();
    let _open = clipboard_win::Clipboard::new_attempts(10).map_err(err)?;
    clipboard_win::raw::set_file_list_with(&files, clipboard_win::options::DoClear).map_err(err)
}

/// Zip the items into `<Downloads>/<name>.zip` (name is a bare file stem); the zip joins the shelf.
#[tauri::command]
pub async fn shelf_zip(app: AppHandle, ids: Vec<u64>, name: String) -> Res<Vec<Item>> {
    let files = paths(&app, &ids)?;
    let name = zip_name(&name)?;
    let dir = app.path().download_dir().map_err(err)?;
    fs::create_dir_all(&dir).map_err(err)?;
    let zip = unique_path(&dir, &format!("{name}.zip"));
    let out = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &ps_script(&files, &zip)])
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .output()
        .map_err(|e| format!("Couldn't run PowerShell: {e}"))?;
    if !out.status.success() || !zip.is_file() {
        let msg = String::from_utf8_lossy(&out.stderr);
        return Err(format!("Zip failed: {}", msg.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("unknown error")));
    }
    let size = fs::metadata(&zip).map_or(0, |m| m.len());
    edit(&app, |list| {
        park(list, zip, "file", size, now_ms());
        Ok(())
    })
}

/// Native drag-out of the items (call while the mouse button is down). "dropped" | "cancel".
#[tauri::command]
pub async fn shelf_drag(app: AppHandle, ids: Vec<u64>) -> Res<String> {
    let files = paths(&app, &ids)?;
    let preview = match files.as_slice() {
        [p] if is_image(p) => image::open(p).ok().map(shots::preview_png),
        _ => None, // ponytail: several files / non-images drag with the bare cursor
    };
    shots::drag_out(&app, files, preview)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn park_dedupes_and_stacks_newest_first() {
        let mut list = Vec::new();
        assert!(park(&mut list, "C:\\a\\One.txt".into(), "file", 5, 1000));
        assert!(!park(&mut list, "c:\\A\\one.TXT".into(), "file", 5, 1001), "same file, other case");
        assert!(park(&mut list, "C:\\a\\pics".into(), "folder", 0, 1000));
        let names: Vec<_> = list.iter().map(|i| i.name.as_str()).collect();
        assert_eq!(names, ["pics", "One.txt"]);
        assert!(list[0].id > list[1].id && list[1].id == 1000, "ids unique, never below the clock");
    }

    #[test]
    fn zip_names_are_bare_stems() {
        assert_eq!(zip_name("  My Archive.ZIP ").unwrap(), "My Archive");
        assert_eq!(zip_name("a/b:c").unwrap(), "a-b-c");
        assert_eq!(zip_name("dots...").unwrap(), "dots");
        for bad in ["", ".zip", "..", "  "] {
            assert!(zip_name(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn powershell_script_quotes_paths() {
        let s = ps_script(&["C:\\it's\\a.txt".into(), "D:\\dir".into()], Path::new("E:\\z.zip"));
        assert_eq!(
            s,
            "$ErrorActionPreference='Stop'; Compress-Archive -LiteralPath 'C:\\it''s\\a.txt','D:\\dir' -DestinationPath 'E:\\z.zip' -Force"
        );
    }
}
