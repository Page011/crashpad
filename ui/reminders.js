// Reminders tab: natural-language add bar, grouped list, snooze, and an island alert when one is due.
import { state, $, $$, h, icon, iconBtn, call, listen, shell, clamp } from './core.js';

const MIN = 60e3, HOUR = 60 * MIN;
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const GROUPS = [['overdue', 'Overdue'], ['today', 'Today'], ['upcoming', 'Upcoming'], ['nodate', 'No date'], ['done', 'Done']];

/** ms timestamp of hh:mm, `days` from today. */
const dayAt = (days, hh, mm = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.setHours(hh, mm, 0, 0);
};
/** The next hh:00 still ahead: today, else tomorrow. */
const nextAt = hh => (dayAt(0, hh) > Date.now() ? dayAt(0, hh) : dayAt(1, hh));
const QUICK = [['+15m', () => Date.now() + 15 * MIN], ['+1h', () => Date.now() + HOUR], ['Tonight', () => nextAt(20)], ['Tomorrow 9am', () => dayAt(1, 9)]];
const SNOOZE = [['10 min', () => Date.now() + 10 * MIN], ['1 hour', () => Date.now() + HOUR], ['Tonight', () => nextAt(20)], ['Tomorrow', () => dayAt(1, 9)]];

/**
 * "call mum tomorrow 5pm" → { text: 'call mum', due: ms }. Understands "in 10m / in 2 hours / in 3 days",
 * "at 5pm / at 17:30 / 5:30pm", today, tonight (20:00), tomorrow (09:00), next week and weekday names.
 * due is null when there's no time phrase.
 */
export function parseWhen(input, now = new Date()) {
  let s = ` ${input} `, found = false, rel = 0, days = null, time = null, deflt = null, weekday = false;
  const take = (re, fn) => {
    let hit = false;
    s = s.replace(re, (m, ...g) => (hit || fn(...g) === false ? m : ((hit = found = true), ' ')));
  };
  take(/\sin\s+(\d+|an?)\s*(m(?:in(?:ute)?s?)?|h(?:(?:ou)?rs?)?|d(?:ays?)?|w(?:(?:ee)?ks?)?)(?=[\s,.;!?])/gi, (n, u) => {
    n = /^an?$/i.test(n) ? 1 : +n;
    const k = u[0].toLowerCase();
    if (k === 'd' || k === 'w') days = n * (k === 'w' ? 7 : 1);
    else rel = n * (k === 'h' ? HOUR : MIN);
  });
  take(/\s(?:(?:by|on)\s+)?(today|tonight|tomorrow|tmrw|next week)(?=[\s,.;!?])/gi, w => {
    w = w.toLowerCase();
    days = { today: 0, tonight: 0, 'next week': 7 }[w] ?? 1;
    deflt = w === 'tonight' ? [20, 0] : w === 'today' ? [17, 0] : [9, 0];
  });
  take(/\s(?:(?:by|on|this|next)\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)(?=[\s,.;!?])/gi, w => {
    days = (DAYS.indexOf(w.toLowerCase()) - now.getDay() + 7) % 7;
    deflt = [9, 0];
    weekday = true;
  });
  take(/\s(at\s+|by\s+|@\s*)?(\d{1,2})(?::([0-5]\d))?\s*(am|pm)?(?=[\s,.;!?])/gi, (at, hs, mm, mer) => {
    let hr = +hs;
    if (!at && !mm && !mer) return false; // a bare number ("buy 3 eggs") isn't a time
    if (mer ? hr < 1 || hr > 12 : hr > 23) return false;
    if (mer) hr = (hr % 12) + (mer.toLowerCase() === 'pm' ? 12 : 0);
    else if (hr >= 1 && hr <= 7 && hs[0] !== '0') hr += 12; // "at 5" means 5pm
    time = [hr, +(mm ?? 0)];
  });
  if (!found) return { text: input.trim(), due: null };
  const d = new Date(+now + rel);
  if (days != null) d.setDate(d.getDate() + days);
  const t = time ?? deflt;
  if (t) d.setHours(t[0], t[1], 0, 0);
  if (d <= now) {
    if (weekday) d.setDate(d.getDate() + 7); // "friday 3pm" on Friday at 4pm → next week
    else if (days == null) d.setDate(d.getDate() + 1); // "at 9am" after 9 → tomorrow
    else if (!time) d.setTime(+now + HOUR); // "tonight" after 20:00
  }
  const text = s.replace(/\s+/g, ' ').replace(/ ([,.;!?])/g, '$1').replace(/^[\s,;]+|[\s,;]+$/g, '');
  return { text: text || input.trim(), due: +d };
}

// ---------- formatting ----------
const hm = d => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const midnight = ms => new Date(ms).setHours(0, 0, 0, 0);
const dayDiff = ms => Math.round((midnight(ms) - midnight(Date.now())) / 864e5);
const full = ms => new Date(ms).toLocaleString([], { weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' });
/** "in 12m", "5m ago", "17:30" ("Today 17:30" if long), "Tomorrow 9:00", "Tue 9:00", "12 Mar 9:00". */
function when(ms, long = false) {
  const diff = ms - Date.now(), d = new Date(ms), dd = dayDiff(ms), t = hm(d);
  if (Math.abs(diff) < MIN) return 'now';
  if (Math.abs(diff) < HOUR) return diff > 0 ? `in ${Math.round(diff / MIN)}m` : `${Math.round(-diff / MIN)}m ago`;
  if (dd === 0) return long ? `Today ${t}` : t;
  if (dd === 1) return `Tomorrow ${t}`;
  if (dd === -1) return `Yesterday ${t}`;
  if (dd > 1 && dd < 7) return `${d.toLocaleDateString([], { weekday: 'short' })} ${t}`;
  const year = d.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined;
  return `${d.toLocaleDateString([], { day: 'numeric', month: 'short', year })} ${t}`;
}
/** ms → the local "YYYY-MM-DDTHH:MM" a datetime-local input wants. */
const toInput = ms => {
  const d = new Date(ms);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};

// ---------- state ----------
let pane, input, field, whenChip, chips, listEl, dt, menu, onPick, audio, armTimer, alertTimer;
let list = [], known = null, sel = null, editing = null, arming = null, showDone = false;
let pick, pickLabel = null; // pick: undefined = read the time from the text, null = no time, ms = chosen
const alerting = new Map(); // fired reminders the island alert is showing

const find = id => list.find(r => r.id === id);
const rowEl = id => listEl.querySelector(`.rm-row[data-id="${id}"]`);
const ic = name => h('span.rm-ic', { html: icon(name) });
const btn = (name, title, fn) => Object.assign(iconBtn(name, title, fn), { tabIndex: -1 });
const save = (id, patch) => {
  const r = find(id);
  return r ? call('update_reminder', { reminder: { ...r, ...patch } }) : Promise.resolve();
};
const draftDue = () => (pick !== undefined ? pick : parseWhen(input.value).due);

// ---------- add bar ----------
function preview() {
  if (!input.value.trim() && pick === null) pick = undefined; // emptied: read times from the text again
  const d = draftDue();
  field.classList.toggle('has-text', !!input.value.trim());
  whenChip.title = d == null ? '' : full(d);
  whenChip.replaceChildren(...(d == null ? [] : [ic('clock'), when(d, true), iconBtn('x', 'No time', () => setPick(null, null))]));
  for (const c of $$('.chip', chips)) c.classList.toggle('on', c.dataset.label === pickLabel);
}

function setPick(ms, label) {
  [pick, pickLabel] = label && label === pickLabel && label !== 'pick' ? [undefined, null] : [ms, label];
  preview();
  input.focus();
}

async function add() {
  const raw = input.value.trim();
  if (!raw) return;
  const { text, due } = pick === undefined ? parseWhen(raw) : { text: raw, due: pick };
  if ((await call('add_reminder', { text, due })) === undefined) return;
  input.value = '';
  [pick, pickLabel] = [undefined, null];
  preview();
}

/** Open the native date-time picker over `anchor`; fn(ms) gets the chosen time. */
function pickTime(anchor, ms, fn) {
  const a = anchor.getBoundingClientRect(), b = pane.getBoundingClientRect();
  Object.assign(dt.style, { left: `${a.left - b.left}px`, top: `${a.top - b.top}px`, width: `${a.width}px`, height: `${a.height}px` });
  dt.value = toInput(ms ?? dayAt(0, new Date().getHours() + 1));
  onPick = fn;
  try { dt.showPicker(); } catch {} // only throws without a user gesture, and every caller is one
}

// ---------- list ----------
function render() {
  const now = Date.now(), g = Object.fromEntries(GROUPS.map(([k]) => [k, []]));
  for (const r of list) g[r.done ? 'done' : r.due == null ? 'nodate' : r.due <= now ? 'overdue' : dayDiff(r.due) === 0 ? 'today' : 'upcoming'].push(r);
  document.body.classList.toggle('has-due', g.overdue.length > 0);
  if (editing != null && $('.rm-edit', listEl)) return; // don't yank the editor mid-typing; ending the edit re-renders
  const prevIdx = $$('.rm-row', listEl).findIndex(el => +el.dataset.id === sel);
  const hadFocus = listEl.contains(document.activeElement);
  const kids = [];
  for (const [key, label] of GROUPS) {
    const rs = g[key];
    if (!rs.length) continue;
    const count = h('span.rm-count', {}, rs.length);
    if (key !== 'done') kids.push(h(`div.rm-head.rm-${key}`, { role: 'presentation' }, label, count));
    else {
      kids.push(h('div.rm-head', { role: 'presentation' },
        h('button.rm-fold', { type: 'button', 'aria-expanded': String(showDone), html: icon('chevron-right'), onclick: () => { showDone = !showDone; render(); } }, label, count),
        h('button.chip.rm-clear', { type: 'button', onclick: clearDone }, 'Clear done')));
      if (!showDone) continue;
    }
    kids.push(...rs.map(r => row(r, key === 'overdue')));
  }
  if (!list.length) kids.push(h('div.empty', {}, 'Nothing to remember yet.', h('div.muted', {}, 'Try “water plants tonight” or “call Sam friday 3pm”.')));
  else if (list.length === g.done.length) kids.unshift(h('div.empty', {}, 'All clear.'));
  listEl.replaceChildren(...kids);
  const ids = $$('.rm-row', listEl).map(el => +el.dataset.id);
  if (!ids.includes(sel)) sel = prevIdx >= 0 && ids.length ? ids[Math.min(prevIdx, ids.length - 1)] : null;
  select(sel, hadFocus);
  if (hadFocus && sel == null) input.focus();
  $('.rm-new', listEl)?.scrollIntoView({ block: 'nearest' });
}

function row(r, overdue) {
  const cls = (r.done ? '.done' : '') + (overdue ? '.overdue' : '') + (known && !known.has(r.id) ? '.rm-new' : '');
  return h(`div.rm-row${cls}`, {
    role: 'option', dataset: { id: r.id },
    // pointerdown, so the row is selected before its buttons' click handlers run (and re-render)
    onpointerdown: e => select(r.id, !e.target.closest('button, input')),
    oncontextmenu: e => { e.preventDefault(); openMenu(r.id); },
  },
    h('button.rm-check', { type: 'button', tabIndex: -1, title: r.done ? 'Not done (Space)' : 'Done (Space)', 'aria-label': r.done ? 'Mark not done' : 'Mark done', html: icon('check'), onclick: () => toggle(r.id) }),
    h('div.rm-body', {},
      editing === r.id ? editor(r) : h('div.rm-text', { ondblclick: () => edit(r.id) }, h('span', {}, r.text)),
      r.due != null && h('button.chip.rm-due', {
        type: 'button', tabIndex: -1, title: `${full(r.due)} · click to change`,
        onclick: e => pickTime(e.currentTarget, r.due, ms => save(r.id, { due: ms, done: false })),
      }, ic('clock'), when(r.due))),
    h('div.rm-actions', {},
      btn('snooze', r.due == null ? 'Remind me… (Shift+S)' : 'Snooze (S)', () => openMenu(r.id)),
      arming === r.id
        ? h('button.rm-confirm', { type: 'button', tabIndex: -1, onclick: () => remove(r.id) }, 'Delete?')
        : btn('trash', 'Delete (Del)', e => (e.shiftKey ? remove(r.id) : arm(r.id)))));
}

/** Select a row (roving tabindex: the selected row, else the first, is the list's Tab stop). */
function select(id, focus = true) {
  sel = id;
  const rows = $$('.rm-row', listEl), stop = rows.find(el => +el.dataset.id === id) ?? rows[0];
  for (const el of rows) {
    el.tabIndex = el === stop ? 0 : -1;
    el.setAttribute('aria-selected', String(+el.dataset.id === id));
  }
  if (focus && stop && +stop.dataset.id === id) {
    stop.focus({ preventScroll: true });
    stop.scrollIntoView({ block: 'nearest' });
  }
}

function step(dir) {
  const ids = $$('.rm-row', listEl).map(el => +el.dataset.id), i = ids.indexOf(sel);
  if (!ids.length) return;
  if (document.activeElement === input || i < 0) return select(ids[Math.max(i, 0)]);
  if (i + dir < 0) return input.focus();
  select(ids[Math.min(i + dir, ids.length - 1)]);
}

async function toggle(id) {
  const r = find(id), el = rowEl(id);
  if (!r || el?.classList.contains('rm-checking')) return;
  if (!r.done) {
    el?.classList.add('rm-checking'); // check pops, text strikes through, row slides away
    const ids = $$('.rm-row', listEl).map(x => +x.dataset.id), i = ids.indexOf(id);
    if (sel === id) sel = ids[i + 1] ?? ids[i - 1] ?? null;
    await new Promise(res => setTimeout(res, 520));
  }
  if ((await save(id, { done: !r.done })) === undefined) render(); // failed: bring the row back
}

function arm(id) {
  arming = id;
  render();
  clearTimeout(armTimer);
  armTimer = setTimeout(() => arming === id && ((arming = null), render()), 3000);
}

function remove(id) {
  arming = null;
  call('delete_reminder', { id });
}

async function clearDone() {
  for (const r of list.filter(r => r.done)) await call('delete_reminder', { id: r.id });
}

function edit(id) {
  [editing, arming] = [id, null];
  render();
}

function editor(r) {
  const inp = h('input.rm-edit', { type: 'text', value: r.text, spellcheck: 'false', 'aria-label': 'Edit reminder', onblur: () => endEdit(true) });
  requestAnimationFrame(() => { inp.focus(); inp.select(); });
  return inp;
}

function endEdit(commit) {
  const id = editing, text = $('.rm-edit', listEl)?.value.trim(), r = find(id);
  if (id == null) return;
  editing = null;
  if (commit && r && text && text !== r.text) {
    r.text = text; // shown right away; Rust's list follows
    save(id, { text });
  }
  render();
}

// ---------- snooze menu ----------
const closeMenu = () => menu.matches(':popover-open') && menu.hidePopover();

function openMenu(id) {
  const r = find(id), el = rowEl(id);
  if (!r || !el) return;
  const item = (label, fn) => h('button', { type: 'button', role: 'menuitem', onclick: () => { closeMenu(); fn(); } }, label);
  const setDue = due => save(id, { due, done: false });
  menu.replaceChildren(...[
    h('div.rm-menu-title', {}, r.due == null || r.done ? 'Remind me' : 'Snooze'),
    ...SNOOZE.map(([label, fn]) => item(label, () => setDue(fn()))),
    item('Pick a time…', () => pickTime(rowEl(id)?.querySelector('.rm-actions') ?? input, r.due, setDue)),
    r.due != null && item('Remove time', () => save(id, { due: null })),
  ].filter(Boolean));
  menu.showPopover();
  const a = el.querySelector('.rm-actions').getBoundingClientRect(), b = pane.getBoundingClientRect(), m = menu.getBoundingClientRect();
  menu.style.left = `${clamp(a.right - m.width, b.left, b.right - m.width)}px`;
  menu.style.top = `${a.bottom + 4 + m.height <= b.bottom ? a.bottom + 4 : Math.max(b.top, a.top - m.height - 4)}px`;
  menu.querySelector('button').focus();
}

// ---------- alerts ----------
function set(l) {
  if (!l) return;
  list = l;
  const had = alerting.size;
  for (const id of alerting.keys()) if (!find(id)?.fired || find(id).done) alerting.delete(id);
  if (had && !alerting.size) shell.dismissAlert(); // handled elsewhere (list, snooze, delete)
  render();
  known = new Set(list.map(r => r.id));
}

function onDue(r) {
  alerting.set(r.id, r);
  clearTimeout(alertTimer); // several due at once (e.g. at startup) → one alert, one chime
  alertTimer = setTimeout(showAlert, 60);
}

function showAlert() {
  const rs = [...alerting.values()];
  if (!rs.length) return;
  const act = patch => () => {
    const ids = [...alerting.keys()];
    alerting.clear();
    shell.dismissAlert();
    for (const id of ids) save(id, patch());
  };
  shell.alert({
    title: rs.length > 1 ? `${rs.length} reminders` : 'Reminder',
    text: rs.map(x => x.text).join(' · '),
    actions: [
      { label: 'Done', primary: true, run: act(() => ({ done: true })) },
      { label: 'Snooze 10m', run: act(() => ({ due: Date.now() + 10 * MIN })) },
      { label: 'Open', run: async () => { if (!state.isOpen) await call('open_panel'); shell.showTab('reminders'); } },
    ].filter(Boolean),
  });
  if (state.cfg.reminderSound) chime();
}

/** Soft two-tone chime (E5 → B5, sine, gentle decay). */
function chime() {
  audio ??= new AudioContext();
  audio.resume();
  const t = audio.currentTime;
  for (const [f, at] of [[659.25, 0], [987.77, 0.16]]) {
    const o = audio.createOscillator(), g = audio.createGain();
    o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t + at);
    g.gain.exponentialRampToValueAtTime(0.14, t + at + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + at + 1.1);
    o.connect(g).connect(audio.destination);
    o.start(t + at);
    o.stop(t + at + 1.15);
  }
}

// ---------- keyboard ----------
function keydown(e) {
  const k = e.key, t = e.target, done = () => (e.preventDefault(), true);
  if (menu.matches(':popover-open')) {
    if (k === 'Escape') return closeMenu(), done();
    if (k !== 'ArrowDown' && k !== 'ArrowUp') return false;
    const items = $$('button', menu), i = items.indexOf(document.activeElement);
    items[(i + (k === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
    return done();
  }
  if (t.classList?.contains('rm-edit')) return (k === 'Enter' || k === 'Escape') && !e.isComposing ? (endEdit(k === 'Enter'), done()) : false;
  if (e.ctrlKey || e.altKey || e.metaKey) return false;
  if (t === input) {
    if (k === 'Enter' && !e.isComposing) return add(), done();
    if (k === 'ArrowDown') return step(1), done();
    if (k === 'Escape' && (input.value || pick !== undefined)) {
      input.value = '';
      setPick(undefined, null);
      return done();
    }
    return false;
  }
  if (k === 'ArrowDown' || k === 'ArrowUp') return step(k === 'ArrowDown' ? 1 : -1), done();
  const id = t.classList?.contains('rm-row') ? +t.dataset.id : null;
  if (id != null) {
    if (k === ' ') return toggle(id), done();
    if (k === 'Enter') return edit(id), done();
    if (k === 's' || k === 'S') return (e.shiftKey ? openMenu(id) : save(id, { due: Date.now() + 10 * MIN, done: false })), done();
    if (k === 'Delete') return (e.shiftKey || arming === id ? remove(id) : arm(id)), done();
    if (k === 'Escape' && arming != null) return (arming = null), render(), done();
  }
  // typing anywhere lands in the add box (Space stays with buttons)
  if (k.length === 1 && k !== ' ' && !t.matches?.('input, textarea, select, [contenteditable]')) input.focus();
  return false;
}

export default {
  id: 'reminders', label: 'Reminders', icon: 'bell',

  mount(p) {
    pane = p;
    input = h('input.rm-input', { type: 'text', placeholder: 'Remind me to…  try “call Sam friday 3pm”', 'aria-label': 'New reminder', spellcheck: 'false', autocomplete: 'off', oninput: preview });
    whenChip = h('span.rm-when');
    field = h('div.rm-field', {}, ic('bell'), input, whenChip, iconBtn('plus', 'Add (Enter)', () => { add(); input.focus(); }, 'rm-go'));
    chips = h('div.rm-chips', {},
      ...QUICK.map(([label, fn]) => h('button.chip', { type: 'button', dataset: { label }, onclick: () => setPick(fn(), label) }, label)),
      h('button.chip', { type: 'button', dataset: { label: 'pick' }, title: 'Pick a date and time', onclick: e => pickTime(e.currentTarget, draftDue(), ms => setPick(ms, 'pick')) }, ic('calendar'), 'Pick…'));
    listEl = h('div.rm-list.scroll', { role: 'listbox', 'aria-label': 'Reminders' });
    dt = h('input.rm-dt', { type: 'datetime-local', tabIndex: -1, 'aria-hidden': 'true', onchange: () => dt.value && onPick?.(new Date(dt.value).getTime()) });
    menu = h('div.rm-menu', { popover: 'auto', role: 'menu', onfocusout: e => !menu.contains(e.relatedTarget) && closeMenu() });
    pane.append(
      h('div.rm-add', {}, field, chips), listEl,
      h('div.rm-hint.muted', {}, '↑↓ select · Space done · Enter edit · S snooze 10m · Shift+S more · Del delete'),
      dt, menu);
    preview();
    (async () => {
      await listen('reminders', set);
      await listen('reminder-due', onDue);
      set(await call('get_reminders')); // after listening: Rust holds due alerts until the page asks
    })();
    setInterval(() => state.isOpen && state.tab === 'reminders' && (render(), preview()), 30e3);
  },
  show() { render(); preview(); input.focus(); },
  hide() { closeMenu(); endEdit(true); },
  onOpen() { if (state.tab === 'reminders') render(); },
  onClose() { closeMenu(); endEdit(true); },
  keydown,
  dropFiles() {},
  dropText(text) {
    input.value = `${input.value.trim()} ${text.trim().split(/\r?\n/)[0]}`.trim();
    preview();
    input.focus();
    return true;
  },
  paste() { return false; },
};
