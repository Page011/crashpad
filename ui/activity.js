// Pill activities: while collapsed the island shows what's live, Dynamic-Island style — a running
// timer, else music, else the next reminder within the hour. A change of volume, mute or power
// source flashes over those for a moment (a HUD). Off with cfg.pillActivities.
// island.css sizes the island from --i-al (the content's length) and hides it when open/peeking/alerting.
import { T, state, $, h, icon, on, listen, call } from './core.js';
import { mmss, withArt } from './live.js';

const MIN = 60e3;
const MUSIC = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/></svg>';
let el, island, media = null, timers = [], reminders = [], key = '';
let flash = null, flashTimer, sound = null, power; // power: charging (bool) once a battery was seen

export function mountActivity(root) {
  el = root;
  island = $('#island');
  if (!el || !island) return;
  listen('media', m => { media = withArt(m); render(); }).then(() => call('get_media')).then(m => { if (m && !media) { media = withArt(m); render(); } });
  listen('timers', t => { timers = t ?? []; render(); });
  listen('reminders', r => { reminders = r ?? []; render(); });
  on('config', render);
  on('close', render);
  call('get_timers').then(t => { if (t) { timers = t; render(); } });
  // a moment later: reminders.js's own fetch must reach Rust first (it arms the due alerts)
  setTimeout(() => call('get_reminders').then(r => { if (r) { reminders = r; render(); } }), 1500);
  setInterval(render, 1000);
  // the HUDs: only changes (never the first reading) and only while collapsed
  listen('audio', a => {
    const was = sound;
    sound = a;
    if (!was) return;
    if (a.micMuted != null && was.micMuted != null && a.micMuted !== was.micMuted)
      show({ kind: 'mic', id: a.micMuted, icon: a.micMuted ? 'mic-off' : 'mic', cls: a.micMuted ? 'act-off' : '', text: a.micMuted ? 'Mic muted' : 'Mic on' }, 1500);
    const v = Math.round(a.volume * 100);
    if (a.muted !== was.muted || v !== Math.round(was.volume * 100))
      show({ kind: 'volume', id: a.muted, muted: a.muted, icon: a.muted ? 'volume-x' : 'volume', level: v, text: `${v}%` }, 1500);
  }).then(() => T.core.invoke('get_audio')).then(a => (sound ??= a), () => {}); // no output device: no baseline, no toast
  listen('stats', s => {
    const was = power;
    power = s.battery == null ? undefined : s.charging;
    if (was !== undefined && power !== undefined && power !== was)
      show({ kind: 'power', id: power, icon: power ? 'bolt' : 'battery', cls: power ? 'act-ok' : '', text: `${power ? 'Charging' : 'On battery'} ${s.battery}%` }, 3000);
  });
}

/** A transient activity: wins over the others for `ms`, then they come back. */
function show(a, ms) {
  if (state.isOpen) return;
  flash = a;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { flash = null; render(); }, ms);
  render();
}

/** What to show: a HUD > timer > music > reminder. */
function pick() {
  if (flash) return flash;
  const now = Date.now();
  const t = timers.filter(t => !t.done && t.end > 0).sort((a, b) => a.end - b.end)[0];
  if (t) return { kind: 'timer', id: t.id, text: mmss(t.end - now) };
  const m = media;
  if (m && (m.status === 'playing' || m.status === 'paused') && (m.title || m.thumb)) return { kind: 'music', id: `${m.title}\0${m.artist}`, thumb: m.thumb, paused: m.status !== 'playing' };
  const r = reminders.filter(r => !r.done && r.due != null && r.due > now && r.due - now <= 60 * MIN).sort((a, b) => a.due - b.due)[0];
  if (r) return { kind: 'reminder', id: r.id, text: r.text, when: `in ${Math.max(1, Math.round((r.due - now) / MIN))}m` };
  return null;
}

function build(a) {
  if (a.kind === 'timer') return [h('span.act-ico.act-timer', { html: icon('clock') }), h('span.act-text', {}, a.text)];
  if (a.kind === 'reminder') return [h('span.act-ico', { html: icon('bell') }), h('span.act-text', {}, a.text), h('span.act-when', {}, a.when)];
  if (a.icon) return [h(`span.act-ico${a.cls ? '.' + a.cls : ''}`, { html: icon(a.icon) }), a.level != null && h(`span.act-level${a.muted ? '.off' : ''}`, {}, h('i')), h('span.act-text', {}, a.text)].filter(Boolean);
  return [
    a.thumb?.startsWith('data:image/') ? h('img.act-art', { src: a.thumb, alt: '' }) : h('span.act-ico', { html: MUSIC }),
    h(`span.act-eq${a.paused ? '.paused' : ''}`, { 'aria-label': a.paused ? 'Paused' : 'Playing' }, h('i'), h('i'), h('i'), h('i')),
  ];
}

function render() {
  const a = state.cfg.pillActivities === false ? null : pick();
  island.classList.toggle('activity', !!a);
  if (!a) {
    key = '';
    el.replaceChildren();
    island.style.removeProperty('--i-al');
    return;
  }
  const k = `${a.kind}:${a.id}:${a.paused ?? ''}`;
  if (k !== key) {
    key = k;
    el.dataset.kind = a.kind;
    el.replaceChildren(...build(a));
  }
  if (a.text != null) $('.act-text', el).textContent = a.text; // timer ticks, HUD values
  if (a.kind === 'reminder') $('.act-when', el).textContent = a.when;
  if (a.level != null) $('.act-level', el).style.setProperty('--v', `${a.level}%`);
  // the island grows along the edge to fit (island.css caps it)
  const vertical = document.body.dataset.orient === 'vertical';
  island.style.setProperty('--i-al', `${vertical ? el.scrollHeight : el.scrollWidth}px`);
}
