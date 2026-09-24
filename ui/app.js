// The shell: boots the page and owns open/closed, tabs, keyboard, drops, config and the alert card.
// Feature tabs are modules (see SPEC "Tab modules"); they reach the shell through core.js `shell`.
import { T, state, emit, $, $$, h, icon, iconBtn, toast, peek, call, listen, clamp, shell } from './core.js';
import clips from './clips.js';
import notes from './notes.js';
import shots from './shots.js';
import reminders from './reminders.js';
import shelf from './shelf.js';
import live from './live.js';
import settings from './settings.js';
import { mountActivity } from './activity.js';
import palette from './palette.js';
import { mountPicker } from './picker.js';

const mods = [clips, notes, shots, reminders, shelf, live, settings];
const island = $('#island'), tabs = $('#tabs'), root = document.documentElement, body = document.body;
const ind = h('span.tab-ind', { 'aria-hidden': 'true' }); // sliding highlight behind the active tab
const tools = h('span.tab-tools');
const banner = h('div#banner.banner', { role: 'alert', hidden: true }); // the alert, while the panel is open
$('.panes').prepend(banner);
let current = null; // module on screen

/** Call a module hook; a broken module logs instead of taking the shell down with it. */
function run(m, hook, ...args) {
  try {
    return m[hook]?.(...args);
  } catch (e) {
    console.error(`${m.id}.${hook}`, e);
  }
}
const active = () => mods.find(m => m.id === state.tab) ?? notes;

// ---------- look ----------

/** Spring step response sampled into a CSS linear() curve. Fast rise, soft landing: most of the
 *  travel happens in the first third, and the default bounce (0.18) overshoots only ~0.5%. */
function spring(bounce) {
  // dock.rs pad() sizes the window margin for damping (1 - bounce), i.e. more overshoot than this
  const z = clamp(1 - bounce * 0.8, 0.4, 1), w = 12, wd = w * Math.sqrt(1 - z * z), pts = [];
  for (let i = 0; i < 48; i++) {
    const t = i / 48;
    const x = z >= 1 ? 1 - Math.exp(-w * t) * (1 + w * t)
      : 1 - Math.exp(-z * w * t) * (Math.cos(wd * t) + (z * w / wd) * Math.sin(wd * t));
    pts.push(+x.toFixed(4));
  }
  return `linear(${pts.join(', ')}, 1)`;
}

/** Relative luminance of #rgb / #rrggbb, 0 (black) … 1 (white). */
function lum(hex) {
  let x = String(hex).replace('#', '');
  if (x.length === 3) x = x.replace(/./g, '$&$&');
  const n = parseInt(x, 16) || 0;
  return .2126 * ((n >> 16 & 255) / 255) ** 2.2 + .7152 * ((n >> 8 & 255) / 255) ** 2.2 + .0722 * ((n & 255) / 255) ** 2.2;
}

const EASE = 'cubic-bezier(.2,.9,.25,1)';

function applyConfig() {
  const c = state.cfg, px = v => v + 'px', set = (k, v) => root.style.setProperty(k, v);
  const side = c.edge === 'left' || c.edge === 'right';
  set('--bg', c.bg); set('--fg', c.fg); set('--accent', c.accent);
  set('--on-accent', lum(c.accent) > .45 ? '#000' : '#fff');
  root.style.colorScheme = lum(c.fg) > .45 ? 'dark' : 'light'; // native controls, pickers, scrollbars
  set('--alpha', c.opacity * 100 + '%'); set('--radius', px(c.radius)); set('--blur', px(c.blur));
  set('--font', CSS.supports('font-family', c.font) ? c.font : ''); // a bad name falls back, not breaks
  set('--fs', px(c.fontSize));
  set('--panel-w', px(side ? c.panelDepth : c.panelLength));
  set('--panel-h', px(side ? c.panelLength : c.panelDepth));
  set('--pill-l', px(c.pillLength)); set('--pill-t', px(c.pillThickness));
  set('--gap', px(c.dockStyle === 'notch' || c.dockStyle === 'fade' ? 0 : c.gap));
  const snappy = c.animStyle === 'snappy';
  set('--dur', c.animMs * (snappy ? .65 : 1) + 'ms');
  set('--ease', EASE);
  set('--spring', c.animStyle === 'spring' ? spring(c.bounce) : snappy ? spring(.1) : EASE);
  set('--spring-close', spring(c.bounce * .4)); // a big undershoot would squash the pill flat
  Object.assign(body.dataset, {
    edge: c.edge, orient: side && !state.detached ? 'vertical' : 'horizontal',
    style: c.dockStyle, anim: c.animStyle, material: c.material,
  });
  placeIndicator();
  emit('config', c);
}

// ---------- config: apply now, save debounced ----------

let cfgTimer = 0, saving = Promise.resolve(), waiting = [];
const dirty = new Set();

function setConfig(patch, delay = 300) {
  Object.assign(state.cfg, patch);
  for (const k in patch) dirty.add(k);
  applyConfig();
  clearTimeout(cfgTimer);
  cfgTimer = setTimeout(() => (saving = saving.then(saveConfig)), delay);
  return new Promise(r => waiting.push(r));
}

// Sends only the keys edited here on top of Rust's current config, so fields Rust changes itself
// (pinned notes, the popped-out window rect) are never overwritten with stale copies.
async function saveConfig() {
  cfgTimer = 0;
  const done = waiting.splice(0), mine = {};
  for (const k of dirty) mine[k] = state.cfg[k];
  dirty.clear();
  const base = await call('get_config');
  const saved = base && (await call('set_config', { cfg: { ...base, ...mine } }));
  const now = saved ?? (await call('get_config')); // rejected (e.g. hotkey taken): show what Rust kept
  // edited again meanwhile: that save is queued and reconciles; else take Rust's clamps and its own fields
  if (now && !dirty.size && JSON.stringify(now) !== JSON.stringify(state.cfg)) {
    Object.assign(state.cfg, now);
    applyConfig();
  }
  done.forEach(r => r());
}

function flushConfig() {
  if (cfgTimer) {
    clearTimeout(cfgTimer);
    saving = saving.then(saveConfig);
  }
  return saving;
}

// ---------- tabs ----------

function buildTabs() {
  tabs.replaceChildren(ind, ...mods.map((m, i) => h('button.tab', {
    type: 'button', role: 'tab', id: 'tab-' + m.id, dataset: { tab: m.id }, 'aria-label': m.label,
    title: `${m.label} (Ctrl+${i + 1})`, html: icon(m.icon), onclick: () => showTab(m.id),
  }, h('span', {}, m.label))), h('span.spacer'), tools);
  renderTools();
}

let pinnedOpen = false; // docked panel pinned open: no auto-close (Esc / hotkey still close)

function togglePinned(on = !pinnedOpen) {
  pinnedOpen = on;
  island.classList.toggle('pinned', on);
  call('set_pinned', { on });
  renderTools();
}

function renderTools() {
  const d = state.detached, top = state.cfg.floatOnTop, had = document.activeElement?.dataset?.act;
  const pop = iconBtn(d ? 'shrink' : 'expand', d ? 'Dock back (F11)' : 'Pop out (F11)', () => shell.setDetached(!state.detached));
  const pin = d && iconBtn(top ? 'lock' : 'unlock', top ? 'Stays on top of other windows' : 'Keep on top of other windows', toggleOnTop, top ? 'on' : '');
  const keep = !d && iconBtn(pinnedOpen ? 'pin' : 'pin-off', pinnedOpen ? 'Pinned open (Ctrl+Shift+P)' : 'Pin open (Ctrl+Shift+P)', () => togglePinned(), pinnedOpen ? 'on' : '');
  pop.dataset.act = 'pop';
  if (pin) pin.dataset.act = 'top';
  if (keep) keep.dataset.act = 'keep';
  tools.replaceChildren(...[keep, pin, pop].filter(Boolean));
  if (had) tools.querySelector(`[data-act="${had}"]`)?.focus(); // keep keyboard focus through the swap
}

async function toggleOnTop() {
  await setConfig({ floatOnTop: !state.cfg.floatOnTop }, 0);
  renderTools();
  call('set_detached', { on: true }); // re-applies the window flags
}

function placeIndicator() {
  const b = tabs.querySelector('.tab[aria-selected=true]');
  if (b) ind.style.cssText = `translate:${b.offsetLeft}px ${b.offsetTop}px;width:${b.offsetWidth}px;height:${b.offsetHeight}px`;
}
new ResizeObserver(placeIndicator).observe(tabs);

function showTab(id) {
  const m = mods.find(x => x.id === id) ?? notes, was = current;
  if (was && was !== m) run(was, 'hide');
  state.tab = m.id;
  current = m;
  for (const b of $$('.tab', tabs)) b.setAttribute('aria-selected', b.dataset.tab === m.id);
  for (const s of $$('.panes > section')) s.classList.toggle('active', s.dataset.pane === m.id);
  placeIndicator();
  run(m, 'show');
  if (was !== m) emit('tab', m.id);
  if (was && was !== m && m.id !== 'settings' && state.cfg.notesDir) setConfig({ lastTab: m.id }, 1500); // survives restarts
}

/** Which tab an opening panel should show. */
const openTab = () => (state.cfg.defaultTab === 'last' ? state.tab : state.cfg.defaultTab);

/** Arrow keys on a focused tab button move between tabs (standard tablist behaviour). */
function tabArrows(e) {
  const b = e.target.closest?.('.tab'), d = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key];
  if (!b || !d) return false;
  e.preventDefault();
  const next = mods[(mods.findIndex(m => m.id === b.dataset.tab) + d + mods.length) % mods.length];
  showTab(next.id);
  $('#tab-' + next.id).focus();
  return true;
}

// ---------- open / close / pop out ----------

function setOpen(open) {
  if (open === state.isOpen) return;
  state.isOpen = open;
  island.classList.remove('peeking', 'dropping');
  island.classList.toggle('open', open);
  for (const m of mods) run(m, open ? 'onOpen' : 'onClose');
  if (open) {
    placeIndicator();
    const to = pendingTab ?? openTab();
    pendingTab = null;
    if (to !== state.tab) showTab(to);
    else run(active(), 'show');
  } else document.activeElement?.blur();
  renderAlert();
  if (!open && alertNow) interactive(); // closing made the window click-through
  emit(open ? 'open' : 'close');
}

let pendingTab = null; // a shake mid-drag opens straight onto the Shelf

function setDetachedUI(on) {
  if (on === state.detached) return;
  state.detached = on;
  body.classList.toggle('detached', on);
  if (on) tabs.dataset.tauriDragRegion = 'deep'; // drag the window by its header (buttons still click)
  else delete tabs.dataset.tauriDragRegion;
  applyConfig();
  renderTools();
  emit('detached', on);
  if (on) setOpen(true);
}

// ---------- alert (island card when collapsed, banner when open) ----------

let alertNow = null, alertTimer;

function showAlert(a) {
  alertNow = a;
  clearTimeout(alertTimer);
  alertTimer = setTimeout(dismissAlert, 20000);
  renderAlert();
  if (!state.isOpen) interactive();
}

// Only the card takes clicks: tell Rust where it is once the island has grown into it.
let cardTimer;
function interactive() {
  clearTimeout(cardTimer);
  cardTimer = setTimeout(() => {
    if (!alertNow || state.isOpen) return;
    const r = $('#alert').getBoundingClientRect(), d = devicePixelRatio, m = 6;
    call('set_interactive', { on: true, rect: [(r.left - m) * d, (r.top - m) * d, (r.width + 2 * m) * d, (r.height + 2 * m) * d] });
  }, (state.cfg.animMs ?? 460) + 60);
}

function dismissAlert() {
  if (!alertNow) return;
  alertNow = null;
  clearTimeout(alertTimer);
  renderAlert();
  clearTimeout(cardTimer);
  call('set_interactive', { on: false });
}

function renderAlert() {
  const a = alertNow, card = !!a && !state.isOpen, inPanel = !!a && state.isOpen;
  const content = () => [
    h('div.alert-text', {}, h('b', {}, a.title ?? ''), a.text ? h('span', {}, a.text) : null),
    h('div.alert-actions', {},
      ...(a.actions ?? []).map(x => h(x.primary ? 'button.btn' : 'button.chip', {
        type: 'button', onclick: () => { dismissAlert(); x.run?.(); },
      }, x.label)),
      iconBtn('x', 'Dismiss (Esc)', dismissAlert)),
  ];
  island.classList.toggle('alerting', card);
  $('#alert').replaceChildren(...(card ? content() : []));
  banner.replaceChildren(...(inPanel ? content() : []));
  banner.hidden = !inPanel;
}

// ---------- shell API for the modules ----------

async function quit() {
  await flushConfig();
  await Promise.allSettled(mods.map(m => run(m, 'onClose'))); // flush unsaved notes etc.
  call('quit');
}

Object.assign(shell, {
  close: () => call('close_panel'),
  showTab,
  setConfig,
  flushConfig, // resolves once pending config changes have reached Rust
  alert: showAlert,
  dismissAlert,
  setDetached: async on => {
    if ((await call('set_detached', { on })) !== undefined) setDetachedUI(on);
  },
  quit,
});

// ---------- input plumbing ----------

document.addEventListener('keydown', e => {
  const k = e.key;
  // WebView2 would reload the page (dropping unsaved notes and the open state)
  if (k === 'F5' || (e.ctrlKey && k.toLowerCase() === 'r')) return e.preventDefault();
  if (palette.isOpen()) return void palette.keydown(e); // it has the keyboard while it's up
  if (!state.isOpen) {
    if (k === 'Escape') {
      e.preventDefault();
      alertNow ? dismissAlert() : state.detached || shell.close();
    }
    return;
  }
  if ((k === 'Enter' || k === ' ') && e.target.closest?.('button, a[href], summary')) return; // let buttons click
  if (tabArrows(e)) return;
  // shell-wide chords win over the tab (a tab's Ctrl+P must not eat Ctrl+Shift+P)
  if (e.ctrlKey && e.shiftKey && k.toLowerCase() === 'p' && !state.detached) {
    e.preventDefault();
    return togglePinned();
  }
  if (e.ctrlKey && !e.shiftKey && !e.altKey && k.toLowerCase() === 'k') {
    e.preventDefault();
    return palette.open();
  }
  if (k === 'F11') {
    e.preventDefault();
    return shell.setDetached(!state.detached);
  }
  // the physical number row (AZERTY needs Shift for digits, so e.key alone would miss it), else the key (numpad)
  const digit = /^Digit\d$/.test(e.code) ? +e.code.slice(5) : /^\d$/.test(k) ? +k : 0;
  if (e.ctrlKey && !e.altKey && !e.shiftKey && digit >= 1 && digit <= mods.length) {
    e.preventDefault();
    return showTab(mods[digit - 1].id);
  }
  if (e.ctrlKey && k === 'Tab') {
    e.preventDefault();
    return showTab(mods[(mods.indexOf(active()) + (e.shiftKey ? -1 : 1) + mods.length) % mods.length].id);
  }
  if (run(active(), 'keydown', e) === true) return;
  if (k === 'Escape') {
    e.preventDefault();
    if (alertNow) dismissAlert();
    else if (!state.detached) shell.close();
  } else if ((e.ctrlKey && /^[fgp]$/i.test(k)) || k === 'F3') e.preventDefault(); // browser find bar / print
});

document.addEventListener('paste', e => {
  if (state.isOpen && !palette.isOpen() && run(active(), 'paste', e) === true) e.preventDefault();
});

// Drops are plain HTML5. Files carry no path in WebView2, so they're handed to Rust
// (postMessageWithAdditionalObjects), which answers with a 'files-dropped' event.
const editable = el => el?.closest?.('input, textarea, [contenteditable]:not([contenteditable=false])');
document.addEventListener('dragover', e => {
  e.preventDefault();
  if (!state.isOpen) return;
  island.classList.add('dropping');
  if (e.dataTransfer.types.includes('Files')) e.dataTransfer.dropEffect = 'copy';
  const t = e.target.closest?.('#tabs .tab')?.dataset.tab; // hovering a tab while dragging switches to it
  if (t && t !== state.tab) showTab(t);
});
document.addEventListener('dragleave', e => { if (!e.relatedTarget) island.classList.remove('dropping'); });
document.addEventListener('dragend', () => island.classList.remove('dropping'));
document.addEventListener('drop', e => {
  island.classList.remove('dropping');
  const dt = e.dataTransfer;
  if (palette.isOpen()) { // modal: text lands in its field, nothing reaches the tab behind it
    if (dt.files.length || !editable(e.target)) e.preventDefault();
    return;
  }
  if (dt.files.length) {
    e.preventDefault();
    const wv = window.chrome?.webview;
    if (wv?.postMessageWithAdditionalObjects) wv.postMessageWithAdditionalObjects('crashpad-drop', dt.files);
    else toast("Can't read dropped files here", true);
    return;
  }
  const text = dt.getData('text/plain');
  if (!text) return e.preventDefault();
  if (run(active(), 'dropText', text, e.target) === true) return e.preventDefault();
  if (editable(e.target)) return; // the field inserts it at the drop point natively
  e.preventDefault();
  call('copy_text', { text }).then(r => r !== undefined && toast('Added to clipboard'));
});

function dropFiles(paths) {
  if (!paths?.length || palette.isOpen()) return; // (a drop that raced the palette opening)
  const m = active();
  if (m.dropFiles) run(m, 'dropFiles', paths);
  else call('copy_text', { text: paths.join('\n') }).then(r => r !== undefined && toast('Paths copied'));
}

// the page itself never scrolls (html can't be overflow: clip, so guard it here)
addEventListener('scroll', () => (scrollX || scrollY) && scrollTo(0, 0));

document.addEventListener('mousedown', e => {
  if (state.isOpen && !state.detached && !pinnedOpen && !island.contains(e.target)) shell.close();
});

// ---------- boot ----------

(async () => {
  Object.assign(state.cfg, await T.core.invoke('get_config'));
  applyConfig();
  buildTabs();
  for (const m of mods) run(m, 'mount', $(`section[data-pane="${m.id}"]`));
  await Promise.all([
    listen('open', setOpen),
    // Rust only sends this when it shrank the panel to fit a smaller screen
    listen('config', c => {
      Object.assign(state.cfg, { panelLength: c.panelLength, panelDepth: c.panelDepth });
      applyConfig();
    }),
    listen('fullscreen', on => body.classList.toggle('fullscreen', on)),
    listen('notice', msg => toast(msg, true)),
    listen('backdrop', b => {
      const ok = typeof b?.url === 'string' && !/["\\\n]/.test(b.url);
      root.style.setProperty('--backdrop', ok ? `url("${b.url}")` : 'none');
      root.style.setProperty('--bd-m', (+b?.margin || 0) + 'px');
    }),
    listen('mode', m => setDetachedUI(!!m?.detached)),
    listen('files-dropped', dropFiles),
    listen('shake', () => (state.isOpen ? showTab('shelf') : (pendingTab = 'shelf'))),
    listen('capture', () => palette.open({ capture: !state.isOpen })),
  ]);
  mountActivity($('#activity'));
  palette.mount(island);
  mountPicker();
  showTab(state.cfg.defaultTab === 'last' ? state.cfg.lastTab : state.cfg.defaultTab);
  body.classList.add('ready');
  const r = await T.core.invoke('ready');
  if (r.detached) setDetachedUI(true);
  if (r.open) setOpen(true); // e.g. the hotkey during startup, before 'open' was being listened to
  if (r.notice) toast(r.notice, true);
})().catch(e => {
  console.error(e);
  body.classList.add('ready');
  peek('crashpad', `Couldn't start: ${e}`);
});
