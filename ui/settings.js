// Settings tab. Built once; every control writes through shell.setConfig (applied live, saved by the
// shell) and is re-synced from state.cfg on every 'config', so Rust's clamps and presets show up.
import { state, h, icon, iconBtn, on, call, shell } from './core.js';

// [id, name, bg, fg, accent, material, opacity]
const PRESETS = [
  ['island', 'Island', '#000000', '#f5f5f7', '#0a84ff'],
  ['graphite', 'Graphite', '#1c1c1e', '#f2f2f7', '#ff9f0a'],
  ['paper', 'Paper', '#fbfbfd', '#1d1d1f', '#0071e3'],
  ['frost', 'Frost', '#16161a', '#ffffff', '#64d2ff', 'frosted', .55],
  ['frost-light', 'Frost light', '#f2f2f7', '#1d1d1f', '#007aff', 'frosted', .6],
  ['liquid-glass', 'Liquid glass', '#ffffff', '#ffffff', '#5ac8fa', 'glass', .14],
  ['liquid-dark', 'Liquid dark', '#000000', '#ffffff', '#bf5af2', 'glass', .22],
  ['midnight', 'Midnight', '#0b1020', '#e6e9f5', '#7c8cff'],
  ['nord', 'Nord', '#2e3440', '#eceff4', '#88c0d0'],
  ['dracula', 'Dracula', '#282a36', '#f8f8f2', '#ff79c6'],
  ['rose-pine', 'Rosé Pine', '#191724', '#e0def4', '#ebbcba'],
  ['forest', 'Forest', '#0f1a14', '#e3efe6', '#34c759'],
  ['sunset', 'Sunset', '#1f1016', '#ffe9e0', '#ff6b4a'],
  ['solarized-light', 'Solarized', '#fdf6e3', '#073642', '#b58900'],
  ['mono', 'Mono', '#ffffff', '#000000', '#000000'],
];
// picking a material starts from an opacity where it actually shows
const MATERIAL_ALPHA = { opaque: 1, translucent: .82, frosted: .55, glass: .18 };
const FONTS = [
  ['"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif', 'System'],
  ['Bahnschrift, "Segoe UI", sans-serif', 'Bahnschrift'],
  ['"Cascadia Code", Consolas, monospace', 'Cascadia Code'],
  ['Consolas, monospace', 'Consolas'],
  ['Georgia, serif', 'Georgia'],
  ['"Palatino Linotype", serif', 'Palatino'],
  ['"Segoe Print", cursive', 'Segoe Print'],
];
const EDGES = [
  ['top-left', 'Top left corner'], ['top', 'Top edge'], ['top-right', 'Top right corner'], ['left', 'Left edge'],
  ['right', 'Right edge'], ['bottom-left', 'Bottom left corner'], ['bottom', 'Bottom edge'], ['bottom-right', 'Bottom right corner'],
];

const syncers = [];
const set = patch => shell.setConfig(patch);
const sync = () => syncers.forEach(f => f(state.cfg));
const px = v => `${v}px`, ms = v => `${v} ms`;

// ---------- controls ----------

function row(label, control, { id, hint, when } = {}) {
  const el = h('div.set-row', {},
    h(id ? 'label.set-label' : 'span.set-label', { for: id }, label, hint ? h('small', {}, hint) : null),
    control);
  if (when) syncers.push(c => (el.hidden = !when(c)));
  return el;
}

function range(k, label, min, max, step, fmt, opts) {
  const id = 'set-' + k, out = h('output', { for: id });
  const el = h('input', { type: 'range', id, min, max, step, oninput: () => set({ [k]: +el.value }) });
  syncers.push(c => {
    el.value = c[k];
    el.style.setProperty('--p', `${((el.value - min) / (max - min)) * 100}%`); // accent fill up to the thumb
    out.textContent = fmt(c[k]);
  });
  return row([label, out], el, { id, ...opts });
}

function toggle(k, label, opts) {
  const id = 'set-' + k;
  const el = h('input.switch', { type: 'checkbox', role: 'switch', id, onchange: () => set({ [k]: el.checked }) });
  syncers.push(c => (el.checked = !!c[k]));
  return row(label, el, { id, ...opts });
}

// applied on change (Enter / leaving the field), or when a datalist suggestion is picked
function text(k, label, opts = {}) {
  const id = 'set-' + k, commit = () => set({ [k]: el.value.trim() });
  const el = h('input', {
    type: 'text', id, spellcheck: 'false', autocomplete: 'off', placeholder: opts.placeholder, list: opts.list,
    onchange: commit, oninput: e => e.inputType === 'insertReplacementText' && commit(),
  });
  syncers.push(c => document.activeElement !== el && (el.value = c[k] ?? ''));
  return row(label, opts.extra ? h('div.set-inline', {}, el, opts.extra) : el, { id, ...opts });
}

function select(k, label, options, opts) {
  const id = 'set-' + k;
  const el = h('select', { id, onchange: () => set({ [k]: el.value }) }, options.map(([v, t]) => h('option', { value: v }, t)));
  syncers.push(c => (el.value = c[k]));
  return row(label, el, { id, ...opts });
}

/** A button that selects value `v` for key `k` (shows .on / aria-pressed when it's the current one). */
function choice(k, v, content, { cls = 'button.seg-btn', ic, patch, title } = {}) {
  const b = h(cls, {
    type: 'button', 'aria-pressed': 'false', title, 'aria-label': title, html: ic ? icon(ic) : null,
    onclick: () => set(patch ? patch(v) : { [k]: v }),
  }, content);
  syncers.push(c => {
    const on = String(c[k]) === v;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on);
  });
  return b;
}

const choices = (k, label, options, opts = {}) =>
  row(label, h('div.seg', { role: 'group', 'aria-label': label }, options.map(([v, t, ic]) => choice(k, v, t, { ic, patch: opts.patch }))), opts);

function group(id, title, ic, ...rows) {
  return h('div.set-group', { id: 'set-g-' + id, dataset: { g: id } },
    h('h3', { html: icon(ic) }, title), h('div.set-card', {}, rows));
}

// ---------- special pickers ----------

const swatches = () => h('div.swatches', { role: 'group', 'aria-label': 'Theme presets' },
  PRESETS.map(([id, name, bg, fg, accent, material = 'opaque', opacity = 1]) => {
    const face = h('span.sw-face', { dataset: { m: material } }, h('b', {}, 'Aa'), h('i'));
    face.style.cssText = `--sw-bg:${bg};--sw-fg:${fg};--sw-ac:${accent};--sw-a:${opacity * 100}%`;
    return choice('theme', id, [face, h('span.sw-name', {}, name)], {
      cls: 'button.swatch', title: name, patch: () => ({ theme: id, bg, fg, accent, material, opacity }),
    });
  }));

const colors = () => row('Custom colours', h('div.wells', {},
  [['bg', 'Background'], ['fg', 'Text'], ['accent', 'Accent']].map(([k, t]) => {
    const el = h('input', { type: 'color', 'aria-label': t + ' colour', oninput: () => set({ [k]: el.value, theme: 'custom' }) });
    syncers.push(c => /^#[\da-f]{6}$/i.test(c[k]) && (el.value = c[k]));
    return h('label.well', {}, el, h('span', {}, t));
  })));

const edgePicker = () => row('Where it sits', h('div.edge-pick', { role: 'group', 'aria-label': 'Screen edge or corner' },
  EDGES.map(([v, t]) => {
    const b = choice('edge', v, null, { cls: 'button.edge-spot', title: t });
    b.dataset.pos = v;
    return b;
  })));

const styleCards = () => row('Collapsed look', h('div.styles', { role: 'group', 'aria-label': 'Collapsed look' },
  [['pill', 'Pill'], ['notch', 'Notch'], ['fade', 'Fade'], ['line', 'Line'], ['dot', 'Dot'], ['invisible', 'Invisible']].map(([v, t]) =>
    choice('dockStyle', v, [h('span.mini', { dataset: { s: v } }, h('i')), h('span', {}, t)], { cls: 'button.style-card' }))),
{ hint: 'Hover a card to preview the open motion' });

function quitButton() {
  let timer;
  const b = h('button.btn.danger', {
    type: 'button', html: icon('power'), onclick: () => {
      if (timer) return shell.quit();
      b.lastChild.textContent = 'Click again to quit';
      timer = setTimeout(() => ((timer = 0), (b.lastChild.textContent = 'Quit crashpad')), 3000);
    },
  }, h('span', {}, 'Quit crashpad'));
  return b;
}

function shortcuts() {
  const k = (keys, what) => h('div.set-row', {}, h('span.set-label', {}, what), h('span.keys', {}, keys.map(x => h('kbd.kbd', {}, x))));
  const hot = h('kbd.kbd');
  syncers.push(c => (hot.textContent = c.hotkey));
  return [
    h('div.set-row', {}, h('span.set-label', {}, 'Open / close from anywhere'), h('span.keys', {}, hot)),
    k(['Esc'], 'Close the panel'), k(['Ctrl', '1…5'], 'Jump to a tab'), k(['Ctrl', 'Tab'], 'Next tab'),
    k(['F11'], 'Pop out / dock back'),
  ];
}

// ---------- the tab ----------

let scroller, nav, groups;

function spy() {
  const top = scroller.scrollTop + 32, end = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
  let cur = groups[0];
  for (const g of groups) if (g.offsetTop <= top) cur = g;
  if (end) cur = groups.at(-1);
  for (const b of nav.children) b.classList.toggle('on', b.dataset.go === cur.dataset.g);
}

export default {
  id: 'settings', label: 'Settings', icon: 'settings',

  mount(pane) {
    const side = c => !c.edge.includes('-');
    groups = [
      group('theme', 'Theme', 'sparkle',
        row('Presets', swatches()),
        choices('material', 'Material', [['opaque', 'Opaque'], ['translucent', 'Translucent'], ['frosted', 'Frosted'], ['glass', 'Liquid glass']],
          { patch: v => ({ material: v, opacity: MATERIAL_ALPHA[v] }) }),
        colors(),
        range('opacity', 'Opacity', .1, 1, .01, v => `${Math.round(v * 100)}%`),
        range('blur', 'Blur', 0, 80, 1, px, { when: c => c.material === 'frosted' || c.material === 'glass' }),
        range('radius', 'Corner radius', 0, 48, 1, px),
        text('font', 'Font', { list: 'set-fonts', placeholder: 'Any installed font' }),
        range('fontSize', 'Text size', 11, 20, 1, px)),
      group('dock', 'Dock', 'sidebar',
        edgePicker(),
        styleCards(),
        range('offset', 'Position along the edge', 0, 100, 1, v => `${v}%`, { when: side }),
        range('gap', 'Gap from the edge', 0, 40, 1, px, { when: c => c.dockStyle !== 'notch' && c.dockStyle !== 'fade' }),
        range('pillLength', 'Pill length', 20, 400, 2, px, { when: c => c.dockStyle !== 'invisible' }),
        range('pillThickness', 'Pill thickness', 2, 48, 1, px, { when: c => c.dockStyle !== 'invisible' }),
        range('panelLength', 'Panel length', 280, 1600, 10, px, { hint: 'Along the edge' }),
        range('panelDepth', 'Panel depth', 200, 1100, 10, px, { hint: 'Away from the edge' })),
      group('motion', 'Motion', 'clock',
        choices('animStyle', 'Animation', [['spring', 'Spring'], ['smooth', 'Smooth'], ['snappy', 'Snappy'], ['fade', 'Fade'], ['zoom', 'Zoom'], ['slide', 'Slide']]),
        range('animMs', 'Speed', 120, 1200, 10, ms),
        range('bounce', 'Bounce', 0, .5, .01, v => (v < .01 ? 'none' : (+v).toFixed(2)), { when: c => c.animStyle === 'spring' })),
      group('behaviour', 'Behaviour', 'settings',
        text('hotkey', 'Hotkey', { placeholder: 'Alt+C', hint: 'e.g. Alt+C, Ctrl+Shift+Space' }),
        select('defaultTab', 'Open to', [['last', 'Last used tab'], ['clipboard', 'Clipboard'], ['notes', 'Notes'], ['shots', 'Screenshots'], ['reminders', 'Reminders'], ['shelf', 'Shelf'], ['live', 'Live']]),
        toggle('shakeOpen', 'Shake a file you are dragging to open the Shelf'),
        toggle('pillActivities', 'Show music, timers and the next reminder on the pill'),
        toggle('slam', 'Open when the mouse slams the edge'),
        select('slamZone', 'Slam zone', [['panel', 'Along the panel'], ['edge', 'The whole edge']], { when: c => c.slam }),
        range('slamPush', 'Slam strength', 0, 1500, 10, v => (v ? v : 'just touch'), { when: c => c.slam }),
        range('slamDwellMs', 'Touchpad / pen: hold at edge', 0, 1500, 10, ms, { when: c => c.slam }),
        toggle('slamFocus', 'Take keyboard focus on slam', { when: c => c.slam }),
        toggle('collapseOnLeave', 'Close when the mouse leaves', { hint: 'Only while you haven’t clicked into it' }),
        range('leaveDelayMs', 'Leave delay', 0, 3000, 50, ms, { when: c => c.collapseOnLeave }),
        toggle('collapseOnBlur', 'Close when focus moves elsewhere'),
        toggle('peek', 'Peek when something is copied')),
      group('clipboard', 'Clipboard', 'clipboard',
        range('clipboardMax', 'History size', 5, 500, 5, v => `${v} clips`),
        toggle('clipPersist', 'Remember history across restarts'),
        choices('clipClick', 'Clicking a clip', [['paste', 'Paste into previous window'], ['copy', 'Copy only']])),
      group('shots', 'Screenshots', 'image',
        range('shotSize', 'Preview size', 120, 600, 10, px),
        choices('shotLayout', 'Layout', [['grid', 'Grid', 'grid'], ['row', 'Row', 'rows']], { hint: 'Grid scrolls down, row scrolls across' }),
        choices('shotFit', 'Previews show', [['contain', 'Whole image'], ['cover', 'Fill the tile']])),
      group('reminders', 'Reminders', 'bell',
        toggle('reminderSound', 'Play a sound when due')),
      group('files', 'Files', 'folder',
        text('notesDir', 'Notes folder', { extra: iconBtn('folder', 'Open notes folder', () => call('open_notes_dir')) }),
        text('screenshotsDir', 'Screenshots folder', { extra: iconBtn('folder', 'Open screenshots folder', () => call('open_shots_dir')) }),
        row('Settings file', h('button.chip', { type: 'button', onclick: () => call('open_config_dir') }, 'Open config folder'))),
      group('startup', 'Startup', 'power',
        toggle('autostart', 'Launch at login'),
        row('Quit', quitButton())),
      group('keys', 'Shortcuts', 'list', ...shortcuts()),
    ];
    nav = h('nav.set-nav', {
      'aria-label': 'Settings sections',
      onwheel: e => { // a mouse wheel scrolls the chip row sideways
        if (e.deltaX || nav.scrollWidth <= nav.clientWidth) return;
        e.preventDefault();
        nav.scrollLeft += e.deltaY;
      },
    }, groups.map(g => h('button.chip', {
      type: 'button', dataset: { go: g.dataset.g },
      onclick: () => {
        scroller.scrollTo({ top: g.offsetTop, behavior: 'smooth' }); // not scrollIntoView: it would shift the island too
        g.querySelector('input, select, button')?.focus({ preventScroll: true });
      },
    }, g.querySelector('h3').textContent)));
    scroller = h('div.set-scroll.scroll', { tabindex: '-1', onscroll: spy }, groups);
    pane.append(h('div.set-wrap', {}, nav, scroller), h('datalist#set-fonts', {}, FONTS.map(([v, t]) => h('option', { value: v, label: t }))));
    on('config', sync);
    sync();
  },

  show() {
    sync();
    if (!scroller.contains(document.activeElement)) scroller.focus({ preventScroll: true }); // arrows/PgDn scroll
    spy();
  },
};
