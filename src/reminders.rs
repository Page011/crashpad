//! Reminders: stored in reminders.json, a watcher fires them on the island when due.

use super::*;

/// Set once the page has fetched the list, i.e. it's listening for "reminder-due". Until then the
/// watcher holds off, so reminders that came due while crashpad was off still alert (once).
static PAGE_READY: AtomicBool = AtomicBool::new(false);

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Reminder {
    pub id: u64,
    pub text: String,
    /// ms since the Unix epoch; None = no time (a plain to-do).
    pub due: Option<u64>,
    pub done: bool,
    /// The alert already went off for the current `due`.
    pub fired: bool,
    pub created: u64,
}

fn file(app: &AppHandle) -> PathBuf {
    data_dir(app).join("reminders.json")
}

/// Not done first, then by due time (none last), then oldest first.
fn sort(list: &mut [Reminder]) {
    list.sort_by_key(|r| (r.done, r.due.is_none(), r.due, r.created));
}

/// Mark reminders whose time has come (not done, not fired yet) as fired and return them.
fn fire_due(list: &mut [Reminder], now: u64) -> Vec<Reminder> {
    list.iter_mut()
        .filter(|r| !r.done && !r.fired && r.due.is_some_and(|d| d <= now))
        .map(|r| {
            r.fired = true;
            r.clone()
        })
        .collect()
}

pub(crate) fn load(app: &AppHandle) {
    let path = file(app);
    let mut list: Vec<Reminder> = match fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_else(|e| {
            eprintln!("crashpad: unreadable reminders ({e}); kept a copy as reminders.json.bad");
            let _ = fs::copy(&path, path.with_extension("json.bad"));
            Vec::new()
        }),
        Err(_) => Vec::new(),
    };
    sort(&mut list);
    *app.state::<Pad>().reminders.lock().unwrap() = list;
}

/// Sort, broadcast and save. Callers hold the reminders lock, so saves and events stay in order.
fn commit(app: &AppHandle, list: &mut [Reminder]) -> Res<Vec<Reminder>> {
    sort(list);
    let _ = app.emit("reminders", &*list);
    let json = serde_json::to_vec_pretty(&*list).map_err(err)?;
    write_atomic(&file(app), json).map_err(|e| format!("Couldn't save reminders: {e}"))?;
    Ok(list.to_vec())
}

fn edit(app: &AppHandle, f: impl FnOnce(&mut Vec<Reminder>) -> Res<()>) -> Res<Vec<Reminder>> {
    let st = app.state::<Pad>();
    let mut list = st.reminders.lock().unwrap();
    f(&mut list)?;
    commit(app, &mut list)
}

pub(crate) fn watch(app: AppHandle) {
    loop {
        thread::sleep(Duration::from_secs(2));
        if !PAGE_READY.load(Relaxed) {
            continue;
        }
        let st = app.state::<Pad>();
        let mut list = st.reminders.lock().unwrap();
        let due = fire_due(&mut list, now_ms());
        if !due.is_empty() {
            let _ = commit(&app, &mut list);
            for r in due {
                let _ = app.emit("reminder-due", r);
            }
        }
    }
}

#[tauri::command]
pub fn get_reminders(st: State<Pad>) -> Vec<Reminder> {
    PAGE_READY.store(true, Relaxed);
    st.reminders.lock().unwrap().clone()
}

#[tauri::command]
pub async fn add_reminder(app: AppHandle, text: String, due: Option<u64>) -> Res<Vec<Reminder>> {
    let text = text.trim();
    if text.is_empty() {
        return Err("A reminder needs some text".into());
    }
    edit(&app, |list| {
        let now = now_ms();
        let id = list.iter().map(|r| r.id + 1).max().unwrap_or(0).max(now);
        list.push(Reminder { id, text: text.into(), due, created: now, ..Default::default() });
        Ok(())
    })
}

/// Change text / due / done. A new due time re-arms the alert.
#[tauri::command]
pub async fn update_reminder(app: AppHandle, reminder: Reminder) -> Res<Vec<Reminder>> {
    let text = reminder.text.trim();
    if text.is_empty() {
        return Err("A reminder needs some text".into());
    }
    edit(&app, |list| {
        let r = list.iter_mut().find(|r| r.id == reminder.id).ok_or("That reminder is gone")?;
        if r.due != reminder.due {
            r.fired = false;
        }
        (r.text, r.due, r.done) = (text.into(), reminder.due, reminder.done);
        Ok(())
    })
}

#[tauri::command]
pub async fn delete_reminder(app: AppHandle, id: u64) -> Res<Vec<Reminder>> {
    edit(&app, |list| {
        list.retain(|r| r.id != id);
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn due_reminders_fire_once_then_sort() {
        let r = |id, due, done| Reminder { id, due, done, created: id, ..Default::default() };
        let mut list = vec![r(1, None, false), r(2, Some(50), false), r(3, Some(200), false), r(4, Some(10), true), r(5, Some(100), false)];
        let ids = |v: &[Reminder]| v.iter().map(|r| r.id).collect::<Vec<_>>();
        assert_eq!(ids(&fire_due(&mut list, 100)), [2, 5], "due at/before now; done ones never fire");
        assert!(fire_due(&mut list, 100).is_empty(), "each fires once");
        sort(&mut list);
        assert_eq!(ids(&list), [2, 5, 3, 1, 4], "open by due (none last), done at the end");
    }
}
