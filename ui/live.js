// Live tab: what's playing, countdown timers, the next reminders, system gauges and this PC's specs.
import { state, $, $$, h, icon, iconBtn, call, listen, shell } from './core.js';

const MIN = 60e3;
const QUICK = [['1m', MIN], ['5m', 5 * MIN], ['10m', 10 * MIN], ['25m', 25 * MIN]];
// transport icons (icons.js has none); our own markup, so innerHTML is fine
const ICO = {
  play: '<path d="M7.5 4.5v15l12-7.5z" fill="currentColor" stroke="none"/>',
  pause: '<rect x="6" y="4.5" width="4.2" height="15" rx="1.2" fill="currentColor" stroke="none"/><rect x="13.8" y="4.5" width="4.2" height="15" rx="1.2" fill="currentColor" stroke="none"/>',
  next: '<path d="M5 5.5v13l10-6.5z" fill="currentColor" stroke="none"/><path d="M18.5 5.5v13" stroke-width="2.4"/>',
  prev: '<path d="M19 5.5v13L9 12z" fill="currentColor" stroke="none"/><path d="M5.5 5.5v13" stroke-width="2.4"/>',
  restart: '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 4v4.5H9"/>',
  music: '<path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>',
};
const ico = n => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICO[n]}</svg>`;

// ---------- parsing / formatting ----------
/** "12m" · "1h30" · "1:30" · "25" (minutes) · "tea 10 min" → { ms, label }; null without a duration. */
export function parseTimer(input) {
  let s = ` ${input.trim().toLowerCase()} `
    .replace(/(\d)\s*(?:hours?|hrs?)\b/g, '$1h').replace(/(\d)\s*(?:minutes?|mins?)\b/g, '$1m').replace(/(\d)\s*(?:seconds?|secs?)\b/g, '$1s');
  let ms = 0, last = '', hit = false;
  s = s.replace(/(\d+):(\d{1,2})(?::(\d{1,2}))?(?![\d:])/, (_, a, b, c) => { hit = true; ms += c ? (a * 3600 + b * 60 + +c) * 1e3 : (a * 60 + +b) * 1e3; return ' '; });
  s = s.replace(/(\d+(?:\.\d+)?)\s*(?:([hms])(?![a-z])|(?![a-z\d.]))/g, (_, n, u) => {
    u ||= last === 'h' ? 'm' : last === 'm' ? 's' : 'm'; // "1h30" → 30 minutes; a bare number is minutes
    [hit, last] = [true, u];
    ms += n * { h: 3600e3, m: MIN, s: 1e3 }[u];
    return ' ';
  });
  return hit && ms > 0 ? { ms: Math.round(ms), label: s.replace(/\s+/g, ' ').trim() } : null;
}
const pad2 = n => String(n).padStart(2, '0');
/** 95000 → "1:35" · 3725000 → "1:02:05" */
export function mmss(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000)), hh = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return `${hh ? `${hh}:${pad2(m)}` : m}:${pad2(s % 60)}`;
}
/** 90000 → "1m 30s" · 5400000 → "1h 30m" · 93784000 → "1d 2h" */
const dur = ms => {
  const s = Math.round(ms / 1000), d = Math.floor(s / 86400), hh = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return d ? `${d}d${hh ? ` ${hh}h` : ''}` : hh ? `${hh}h${m ? ` ${m}m` : ''}` : m ? `${m}m${ss ? ` ${ss}s` : ''}` : `${ss}s`;
};
const bytes = n => {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  for (; n >= 1024 && i < 4; i++) n /= 1024;
  return `${i >= 3 ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
};
const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0);
/** "in 12m" · "5m ago" · "17:30" · "Tomorrow 9:00" · "Tue 9:00" · "12 Mar 9:00" */
function when(ms) {
  const diff = ms - Date.now(), d = new Date(ms), t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const days = Math.round((new Date(ms).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 864e5);
  if (Math.abs(diff) < MIN) return 'now';
  if (Math.abs(diff) < 3600e3) return diff > 0 ? `in ${Math.round(diff / MIN)}m` : `${Math.round(-diff / MIN)}m ago`;
  if (days === 0) return t;
  if (days === 1) return `Tomorrow ${t}`;
  if (days > 1 && days < 7) return `${d.toLocaleDateString([], { weekday: 'short' })} ${t}`;
  return `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${t}`;
}

// ---------- state ----------
let pane, input, hint, tlist, np, rlist, tiles, specsEl, audio;
let timers = [], media = null, stats = null, reminders = [], specs = null, sel = null;
const tileEls = new Map();
const visible = () => state.isOpen && state.tab === 'live';
const left = t => (t.done ? 0 : t.end ? t.end - Date.now() : t.left);
const rows = () => $$('.lv-t', tlist);

// ---------- now playing ----------
function renderMedia() {
  const m = media, live = m && m.status !== 'none' && (m.title || m.status === 'playing');
  np.classList.toggle('lv-off', !live);
  if (!live) return np.replaceChildren(h('div.lv-art.lv-art-none', { html: ico('music') }), h('div.lv-np-text', {}, h('div.lv-np-title.muted', {}, 'Nothing playing')));
  const playing = m.status === 'playing', ctl = (n, title, action) => h('button.lv-btn', { type: 'button', title, 'aria-label': title, html: ico(n), onclick: () => call('media_control', { action }) });
  np.replaceChildren(
    m.thumb?.startsWith('data:image/') ? h('img.lv-art', { src: m.thumb, alt: '' }) : h('div.lv-art.lv-art-none', { html: ico('music') }),
    h('div.lv-np-text', {},
      h('div.lv-np-title', { title: m.title }, m.title || 'Unknown'),
      h('div.lv-np-sub.muted', {}, [m.artist, m.album].filter(Boolean).join(' · ') || m.app),
      m.duration > 0 && h('div.lv-np-time', {},
        h('div.lv-prog', { role: 'progressbar', 'aria-valuenow': pct(m.position, m.duration) }, h('i', { style: `width:${pct(m.position, m.duration)}%` })),
        h('span.muted', {}, `${mmss(m.position)} / ${mmss(m.duration)}`))),
    h('div.lv-ctl', {}, ctl('prev', 'Previous', 'prev'), ctl(playing ? 'pause' : 'play', playing ? 'Pause' : 'Play', 'toggle'), ctl('next', 'Next', 'next')));
}

// ---------- timers ----------
function preview() {
  const p = parseTimer(input.value);
  hint.textContent = p ? `${dur(p.ms)}${p.label ? ` · ${p.label}` : ''}` : input.value.trim() ? 'e.g. 12m, 1h30, 1:30 or “tea 10 min”' : '';
}
async function add(ms, label = '') {
  if (!ms) return;
  if ((await call('add_timer', { label, ms })) === undefined) return;
  input.value = '';
  preview();
}
function submit() {
  const p = parseTimer(input.value);
  p ? add(p.ms, p.label) : preview();
}
const act = (id, action) => call('update_timer', { id, action });
const remove = id => call('remove_timer', { id });
function toggle(t) {
  act(t.id, t.done ? 'restart' : t.end ? 'pause' : 'resume');
}

function row(t) {
  const paused = !t.done && !t.end, ring = h('span.lv-ring', { html: '<svg viewBox="0 0 36 36" aria-hidden="true"><circle cx="18" cy="18" r="15.5" pathLength="100"/><circle class="fg" cx="18" cy="18" r="15.5" pathLength="100"/></svg>' });
  const btn = (n, title, fn) => Object.assign(h('button.icon-btn', { type: 'button', title, 'aria-label': title, html: n in ICO ? ico(n) : icon(n), onclick: fn }), { tabIndex: -1 });
  return h(`div.lv-t${t.done ? '.done' : paused ? '.paused' : ''}`, {
    role: 'option', dataset: { id: t.id }, 'aria-label': `${t.label || dur(t.total)} timer`,
    onpointerdown: e => select(t.id, !e.target.closest('button')),
  },
    ring,
    h('div.lv-t-body', {}, h('div.lv-t-time', {}, mmss(left(t))), h('div.lv-t-label.muted', {}, t.done ? 'Done' : paused ? `Paused · ${t.label || dur(t.total)}` : t.label || dur(t.total))),
    h('div.lv-t-actions', {},
      t.done ? btn('restart', 'Restart (Enter)', () => act(t.id, 'restart'))
        : [btn(t.end ? 'pause' : 'play', t.end ? 'Pause (Space)' : 'Resume (Space)', () => toggle(t)), btn('restart', 'Restart (Enter)', () => act(t.id, 'restart'))],
      btn('x', 'Remove (Del)', () => remove(t.id))));
}

function renderTimers() {
  const hadFocus = tlist.contains(document.activeElement), prev = rows().findIndex(el => +el.dataset.id === sel);
  tlist.replaceChildren(...(timers.length ? timers.map(row) : [h('div.empty.lv-empty', {}, 'No timers running.')]));
  const ids = timers.map(t => t.id);
  if (!ids.includes(sel)) sel = prev >= 0 && ids.length ? ids[Math.min(prev, ids.length - 1)] : null;
  select(sel, hadFocus);
  if (hadFocus && sel == null) input.focus();
  tick();
}

/** Roving tabindex: the selected row (else the first) is the list's Tab stop. */
function select(id, focus = true) {
  sel = id;
  const all = rows(), stop = all.find(el => +el.dataset.id === id) ?? all[0];
  for (const el of all) {
    el.tabIndex = el === stop ? 0 : -1;
    el.setAttribute('aria-selected', String(+el.dataset.id === id));
  }
  if (focus && stop && +stop.dataset.id === id) stop.focus({ preventScroll: true }), stop.scrollIntoView({ block: 'nearest' });
}
function step(dir) {
  const ids = timers.map(t => t.id), i = ids.indexOf(sel);
  if (!ids.length) return;
  if (document.activeElement === input || i < 0) return select(ids[Math.max(i, 0)]);
  if (i + dir < 0) return input.focus();
  select(ids[Math.min(i + dir, ids.length - 1)]);
}

/** Once a second: remaining time and the progress rings (Rust fires "timer-done" itself). */
function tick() {
  if (!visible()) return;
  for (const el of rows()) {
    const t = timers.find(t => t.id === +el.dataset.id);
    if (!t) continue;
    const l = left(t);
    $('.lv-t-time', el).textContent = mmss(l);
    $('.fg', el).style.strokeDashoffset = 100 - pct(t.total - l, t.total);
  }
}

function onDone(t) {
  const label = t.label || dur(t.total);
  shell.alert({
    title: 'Timer done', text: label,
    actions: [
      { label: 'Done', primary: true, run: () => remove(t.id) },
      { label: '+5 min', run: async () => { await remove(t.id); add(5 * MIN, t.label); } },
    ],
  });
  chime();
}

/** Soft two-tone chime (G5 → D6, sine, gentle decay). */
function chime() {
  try {
    audio ??= new AudioContext();
    audio.resume();
    const t = audio.currentTime;
    for (const [f, at] of [[783.99, 0], [1174.66, 0.16]]) {
      const o = audio.createOscillator(), g = audio.createGain();
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + at);
      g.gain.exponentialRampToValueAtTime(0.12, t + at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + at + 1.1);
      o.connect(g).connect(audio.destination);
      o.start(t + at);
      o.stop(t + at + 1.15);
    }
  } catch {}
}

// ---------- reminders (next 3) ----------
function renderReminders() {
  const now = Date.now();
  const next = reminders.filter(r => !r.done && r.due != null).sort((a, b) => a.due - b.due).slice(0, 3);
  rlist.replaceChildren(...(next.length ? next.map(r => h('button.lv-r', {
    type: 'button', title: 'Open in Reminders', onclick: () => shell.showTab('reminders'),
  }, h('span.lv-ic', { html: icon('bell') }), h('span.lv-r-text', {}, r.text), h(`span.lv-r-when${r.due < now ? '.overdue' : ''}`, {}, when(r.due))))
    : [h('div.empty.lv-empty', {}, 'Nothing coming up.')]));
}

// ---------- system ----------
function tile(id, label, value, fill) {
  let el = tileEls.get(id);
  if (!el) {
    el = h('div.lv-tile', { dataset: { id } }, h('div.lv-tile-h', {}, h('span.lv-tile-l', {}, label), h('span.lv-tile-v', {})), h('div.lv-bar', {}, h('i')));
    tileEls.set(id, el);
  }
  $('.lv-tile-v', el).textContent = value;
  const bar = $('.lv-bar', el);
  bar.hidden = fill == null;
  if (fill != null) {
    $('i', bar).style.width = `${Math.min(100, fill)}%`;
    bar.classList.toggle('hot', fill >= 90);
  }
  return el;
}

function renderStats() {
  if (!stats || !visible()) return;
  const s = stats, list = [
    tile('cpu', 'CPU', `${Math.round(s.cpu)}%`, s.cpu),
    tile('mem', 'Memory', `${bytes(s.memUsed)} / ${bytes(s.memTotal)}`, pct(s.memUsed, s.memTotal)),
    ...(s.gpus ?? []).map((g, i) => tile(`gpu${i}`, g.name.replace(/^(NVIDIA|AMD|Intel\(R\)|Intel)\s+(GeForce\s+)?/i, ''), `${bytes(g.vramUsed)} / ${bytes(g.vramTotal)}`, pct(g.vramUsed, g.vramTotal))),
    tile('disk', 'Disk', `${bytes(s.diskTotal - s.diskUsed)} free of ${bytes(s.diskTotal)}`, pct(s.diskUsed, s.diskTotal)),
    tile('net', 'Network', `↓ ${bytes(s.netDown)}/s  ↑ ${bytes(s.netUp)}/s`),
    s.battery != null && tile('bat', s.charging ? 'Battery ⚡' : 'Battery', `${s.battery}%`, s.battery),
    tile('up', 'Uptime', dur(s.uptime * 1000)),
  ].filter(Boolean);
  if (list.some((el, i) => tiles.children[i] !== el) || tiles.children.length !== list.length) tiles.replaceChildren(...list);
}

async function loadSpecs() {
  specs ??= await call('get_specs');
  if (!specs) return;
  const row = (k, v) => v && [h('dt', {}, k), h('dd', { title: v }, v)];
  specsEl.replaceChildren(...[
    row('CPU', specs.cpu), row('Cores', specs.cores ? `${specs.cores} cores · ${specs.threads} threads` : `${specs.threads} threads`),
    row('Memory', bytes(specs.ramTotal)), row(specs.gpus.length > 1 ? 'GPUs' : 'GPU', specs.gpus.join(' · ')),
    row('Windows', specs.os.replace(/^Windows\s*/, '')), row('Name', specs.host),
  ].flat().filter(Boolean));
}

// ---------- keyboard ----------
function keydown(e) {
  const k = e.key, t = e.target, done = () => (e.preventDefault(), true);
  if (e.ctrlKey || e.altKey || e.metaKey) return false;
  if (t === input) {
    if (k === 'Enter' && !e.isComposing) return submit(), done();
    if (k === 'ArrowDown' && timers.length) return step(1), done();
    if (k === 'Escape' && input.value) return (input.value = ''), preview(), done();
    return false;
  }
  const row = t.closest?.('.lv-t'), id = row ? +row.dataset.id : null, timer = timers.find(t => t.id === id);
  if (timer) {
    if (k === 'ArrowDown' || k === 'ArrowUp') return step(k === 'ArrowDown' ? 1 : -1), done();
    if (k === ' ') return toggle(timer), done();
    if (k === 'Enter') return act(id, 'restart'), done();
    if (k === 'Delete' || k === 'Backspace') return remove(id), done();
  }
  // typing a number anywhere starts a timer (the digit lands in the input)
  if (/^\d$/.test(k) && !t.matches?.('input, textarea, select, [contenteditable]')) input.focus();
  return false;
}

export default {
  id: 'live', label: 'Live', icon: 'sparkle',

  mount(p) {
    if (!p) return;
    pane = p;
    const sec = (cls, title, ...kids) => h(`section.lv-sec.${cls}`, { 'aria-label': title }, h('h3.lv-h', {}, title), ...kids);
    np = h('div.lv-np');
    input = h('input.lv-input', { type: 'text', placeholder: 'Timer: 12m, 1h30, “tea 10 min”…', 'aria-label': 'New timer', spellcheck: 'false', autocomplete: 'off', oninput: preview });
    hint = h('div.lv-hint.muted', { 'aria-live': 'polite' });
    tlist = h('div.lv-tlist', { role: 'listbox', 'aria-label': 'Timers' });
    rlist = h('div.lv-rlist');
    tiles = h('div.lv-tiles');
    specsEl = h('dl.lv-dl');
    pane.append(h('div.lv-scroll.scroll', {}, h('div.lv-grid', {},
      sec('lv-media', 'Now playing', np),
      sec('lv-timers', 'Timers',
        h('div.lv-chips', {}, ...QUICK.map(([l, ms]) => h('button.chip', { type: 'button', onclick: () => add(ms) }, l))),
        h('div.lv-field', {}, h('span.lv-ic', { html: icon('clock') }), input, iconBtn('plus', 'Start (Enter)', () => { submit(); input.focus(); })),
        hint, tlist),
      sec('lv-next', 'Up next', rlist),
      sec('lv-sys', 'System', tiles),
      sec('lv-specs', 'This PC', specsEl))));
    renderMedia();
    renderTimers();
    renderReminders();
    listen('media', m => { media = m; renderMedia(); });
    listen('stats', s => { stats = s; renderStats(); });
    listen('reminders', r => { reminders = r ?? []; renderReminders(); });
    (async () => {
      await listen('timers', t => { timers = t ?? []; renderTimers(); });
      await listen('timer-done', onDone);
      timers = (await call('get_timers')) ?? []; // after listening: Rust holds finished timers until the page asks
      renderTimers();
    })();
    setInterval(tick, 1000);
  },
  show() {
    renderTimers();
    renderReminders();
    renderStats();
    loadSpecs();
    call('get_reminders').then(r => { if (r) { reminders = r; renderReminders(); } });
    input.focus();
  },
  hide() {},
  onOpen() {},
  onClose() {},
  keydown,
  dropFiles() {},
  dropText(text) {
    input.value = text.trim().split(/\r?\n/)[0];
    preview();
    input.focus();
    return true;
  },
  paste() { return false; },
};
