// Screenshots tab: big, crisp previews of the screenshots folder. Click copies, right-click
// quick-looks, click-and-drag drops the real file into any app, paste / drop adds images.
// The ⋯ button (or Shift+F10) has the rest: mark up (M), copy text (T), open, show in Explorer.
import { state, on, h, icon, iconBtn, clamp, call, toast, assetUrl, ago, shell, menu } from './core.js';
import { openMarkup } from './markup.js';
import { copyTextFrom } from './ocr.js';

const cfg = () => state.cfg;
const MOVES = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
let pane, strip, slider, layoutBtn, fitBtn, look, lookImg, lookCap;
let shots = [], tiles = [], sel = 0, first = true, dir;
let lookAt = -1, anims = []; // quick look: index shown (-1 closed), running zoom animations
let noClick = false, dragging = 0;

const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const easing = n => (CSS.supports('animation-timing-function', cssVar(n)) ? cssVar(n) : 'cubic-bezier(.2,.8,.2,1)');
const dur = () => clamp(parseFloat(cssVar('--dur')) || 0, 0, 600);
const visible = () => state.isOpen && state.tab === 'shots';

/** Restart a one-shot CSS animation class; the pane's animationend handler removes it. */
function play(el, cls) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

/** Where a w×h image lands inside rect r with object-fit: contain. */
function fitRect(r, w, hgt) {
  const s = Math.min(r.width / w, r.height / hgt);
  return { x: r.left + (r.width - w * s) / 2, y: r.top + (r.height - hgt * s) / 2, width: w * s, height: hgt * s };
}

// ---------- list ----------
/** Refresh from disk; `want` (a file name) gets selected, e.g. a just-saved marked copy. */
async function load(want) {
  const list = await call('list_shots');
  if (!list) return;
  const key = s => s.path + '|' + s.modified;
  if (!first && list.map(key).join() === shots.map(key).join()) return captions();
  closeLook(true); // indexes are about to shift
  const selName = shots[sel]?.name, old = new Map(tiles.map(t => [t.dataset.key, t]));
  let born = 0, firstNew = -1;
  tiles = list.map((s, i) => {
    let t = old.get(key(s));
    if (!t) {
      t = tile(s, key(s));
      if (!first) {
        t.classList.add('new'); // drop in, staggered
        t.style.animationDelay = Math.min(born++, 8) * 45 + 'ms';
        if (firstNew < 0) firstNew = i;
      }
    }
    return t;
  });
  shots = list;
  first = false;
  strip.replaceChildren(...(tiles.length ? tiles
    : [h('div.empty', {}, 'No screenshots yet.', h('br'), 'Press S to snip, or paste / drop an image here.')]));
  captions();
  const kept = list.findIndex(s => s.name === (want ?? selName));
  select(firstNew >= 0 && !want ? firstNew : Math.max(kept, 0), firstNew >= 0 || want ? 'smooth' : undefined);
}

function tile(s, key) {
  // loading/decoding before src so the lazy hint applies to the first fetch
  const img = h('img', { alt: '', loading: 'lazy', decoding: 'async', draggable: 'false', src: assetUrl(s.path) });
  return h('figure.tile', {
    role: 'option', 'aria-label': s.name, dataset: { key },
    title: `${s.name}\nClick: copy · Right-click: quick look · Drag: drop into any app · Double-click: open · M: mark up`,
  }, img, h('figcaption'), h('span.badge', { html: icon('check') }), moreBtn('more'));
}

const captions = () => tiles.forEach((t, i) => (t.querySelector('figcaption').textContent = ago(shots[i].modified)));

/** Select tile i; `scroll` ('smooth' | 'auto') also brings it into view. */
function select(i, scroll) {
  if (!tiles.length) return;
  sel = clamp(i, 0, tiles.length - 1);
  tiles.forEach((t, n) => t.setAttribute('aria-selected', n === sel));
  if (scroll) tiles[sel].scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: scroll });
}

function move(k) {
  const n = tiles.length;
  if (!n) return;
  if (k === 'Home' || k === 'End') return select(k === 'Home' ? 0 : n - 1, 'smooth');
  if (k === 'ArrowLeft' || k === 'ArrowRight') return select(sel + (k === 'ArrowLeft' ? -1 : 1), 'smooth');
  if (cfg().shotLayout === 'row') return;
  const c = tiles.findIndex(t => t.offsetTop !== tiles[0].offsetTop), cols = c < 0 ? n : c; // real columns
  const j = sel + (k === 'ArrowUp' ? -cols : cols);
  if (j >= 0 && j < n) select(j, 'smooth');
  else if (k === 'ArrowDown' && Math.floor(sel / cols) < Math.floor((n - 1) / cols)) select(n - 1, 'smooth');
}

/** ⋯ on a tile / the quick look. Not a tab stop (Shift+F10 opens the same menu). */
function moreBtn(cls, onclick) {
  const b = iconBtn('more', 'More (Shift+F10)', onclick, cls);
  b.tabIndex = -1;
  return b;
}

/** The actions menu for shot i, dropped under `at` (an element) or at a mouse event. */
function shotMenu(i, at) {
  const s = shots[i];
  if (!s) return;
  select(i, 'auto'); // on screen, so the menu drops next to it
  strip.focus({ preventScroll: true }); // not the clicked ⋯: Enter / Space afterwards must act on the selection
  menu([
    { label: 'Copy', icon: 'copy', kbd: 'Enter', run: () => copy(i, lookAt === i ? look : tiles[i]) },
    { label: 'Mark up', icon: 'pen', kbd: 'M', run: () => openMarkup(s) },
    { label: 'Copy text', icon: 'scan-text', kbd: 'T', run: () => copyTextFrom(s.path) },
    'sep',
    { label: 'Open', icon: 'expand', kbd: 'O', run: () => call('open_shot', { name: s.name }) },
    { label: 'Show in Explorer', icon: 'folder', kbd: 'R', run: () => call('reveal_shot', { name: s.name }) },
  ], at);
}

const markupEl = () => pane.querySelector('.mk:not(.mk-out)');

// ---------- actions ----------
async function copy(i, fx = tiles[i]) {
  const s = shots[i];
  if (s && (await call('copy_image', { name: s.name })) !== undefined) play(fx, 'copied');
}

async function snip() {
  await shell.close();
  call('snip');
}

async function savePasted(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if ((await call('save_image', bytes, { headers: { ext: file.type.split('/')[1] } })) !== undefined) {
    toast('Screenshot saved');
    load();
  }
}

/** Left button went down on a tile or the quick-look image: a click copies, moving > 6 px drags the file out. */
function press(e, i, el) {
  noClick = false;
  if (e.button !== 0) return;
  const x = e.clientX, y = e.clientY;
  const stop = () => {
    window.removeEventListener('pointermove', moved);
    window.removeEventListener('pointerup', stop);
    window.removeEventListener('pointercancel', stop);
  };
  const moved = ev => {
    if (Math.hypot(ev.clientX - x, ev.clientY - y) <= 6) return;
    stop();
    noClick = true;
    dragOut(i, el);
  };
  window.addEventListener('pointermove', moved);
  window.addEventListener('pointerup', stop);
  window.addEventListener('pointercancel', stop);
}

async function dragOut(i, el) {
  const s = shots[i];
  if (!s) return;
  dragging++;
  el.classList.add('lift'); // floats while the OS drag image follows the cursor
  const r = await call('drag_shot', { name: s.name }); // resolves when the file is dropped or the drag cancelled
  el.classList.remove('lift'); // cancel: the transition drops it back into place
  if (r === 'dropped' && el.matches('.tile')) play(el, 'sent');
  // ponytail: a drop back onto our own window reaches dropFiles a moment later; ignore it for 1.5 s
  setTimeout(() => dragging--, 1500);
}

// ---------- quick look ----------
function openLook(i) {
  if (!tiles[i]) return;
  select(i, 'auto'); // the zoom starts from the tile, so it must be on screen
  lookAt = i;
  look.hidden = false;
  showInLook(i);
  zoom(i, true);
}

function showInLook(i) {
  pane.querySelector('.looking')?.classList.remove('looking');
  tiles[i].classList.add('looking'); // the image "leaves" its tile while it's enlarged
  const s = shots[i];
  lookImg.src = tiles[i].querySelector('img').src;
  const when = new Date(s.modified).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  lookCap.replaceChildren(h('b', {}, s.name), h('span', {}, `${when} · ${i + 1}/${shots.length}`), h('span.dims'));
  showDims(tiles[i].querySelector('img'));
  look.querySelector('.ql-prev').disabled = i === 0;
  look.querySelector('.ql-next').disabled = i === shots.length - 1;
}

const showDims = img => img.naturalWidth && (lookCap.querySelector('.dims').textContent = `${img.naturalWidth} × ${img.naturalHeight}`);

/** FLIP between tile i and the enlarged view. Resolves when done (rejects if interrupted). */
function zoom(i, opening) {
  const src = tiles[i]?.querySelector('img'), w = src?.naturalWidth, hgt = src?.naturalHeight;
  const E = lookImg.getBoundingClientRect(), d = dur();
  let from = { opacity: 0, transform: 'translateY(14px)' }; // not decoded yet: plain fade
  if (w && E.width) {
    const a = fitRect(src.getBoundingClientRect(), w, hgt), b = fitRect(E, w, hgt); // b is centred in E
    const dx = a.x + a.width / 2 - (E.x + E.width / 2), dy = a.y + a.height / 2 - (E.y + E.height / 2);
    from = { opacity: 1, transform: `translate(${dx}px, ${dy}px) scale(${a.width / b.width})` };
  }
  const img = [from, { opacity: 1, transform: 'none' }], dim = [{ opacity: 0 }, { opacity: 1 }];
  anims.forEach(a => a.cancel());
  const opts = { duration: d, easing: easing(opening ? '--spring' : '--spring-close'), fill: opening ? 'none' : 'forwards' };
  anims = [
    lookImg.animate(opening ? img : img.reverse(), opts),
    look.querySelector('.ql-dim').animate(opening ? dim : dim.reverse(), { duration: d * 0.7, fill: opts.fill }),
  ];
  return anims[0].finished;
}

async function closeLook(instant) {
  const i = lookAt;
  if (i < 0) return;
  lookAt = -1;
  if (!instant && tiles[i]) {
    tiles[i].scrollIntoView({ block: 'nearest', inline: 'nearest' });
    try { await zoom(i, false); } catch { return; } // reopened mid-zoom
  }
  if (lookAt >= 0) return;
  anims.forEach(a => a.cancel());
  look.hidden = true;
  tiles[i]?.classList.remove('looking');
}

function step(d) {
  const j = clamp(lookAt + d, 0, shots.length - 1);
  if (j === lookAt) return;
  lookAt = j;
  select(j, 'auto');
  showInLook(j);
  lookImg.animate([{ opacity: 0, transform: `translateX(${d * 28}px)` }, { opacity: 1, transform: 'none' }],
    { duration: 220, easing: 'cubic-bezier(.2,.8,.2,1)' });
}

// ---------- config ----------
function applyCfg() {
  const c = cfg(), row = c.shotLayout === 'row', cover = c.shotFit === 'cover', size = c.shotSize ?? 220;
  pane.style.setProperty('--shot', size + 'px');
  strip.classList.toggle('row', row);
  strip.classList.toggle('cover', cover);
  slider.value = size;
  const label = (btn, name, text) => {
    btn.innerHTML = icon(name);
    btn.title = text;
    btn.setAttribute('aria-label', text);
  };
  label(layoutBtn, row ? 'rows' : 'grid', row ? 'Row, scroll across (click for grid)' : 'Grid, scroll down (click for one row)');
  label(fitBtn, cover ? 'expand' : 'shrink', cover ? 'Filling tiles (click to show whole images)' : 'Whole images (click to fill tiles)');
  if (c.screenshotsDir !== dir) {
    dir = c.screenshotsDir;
    if (visible()) load();
  }
}

function setCfg(patch) {
  shell.setConfig(patch);
  applyCfg();
  if (!('shotSize' in patch)) strip.animate([{ opacity: 0.35 }, { opacity: 1 }], { duration: 220, easing: 'ease-out' });
  tiles[sel]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

const setSize = v => {
  v = clamp(Math.round(v / 10) * 10, 120, 560);
  if (v !== cfg().shotSize) setCfg({ shotSize: v });
};

// ---------- tab module ----------
export default {
  id: 'shots', label: 'Shots', icon: 'image',

  mount(p) {
    pane = p;
    slider = h('input', { type: 'range', min: 120, max: 560, step: 10, 'aria-label': 'Preview size', oninput: () => setSize(+slider.value) });
    layoutBtn = iconBtn('grid', 'Layout', () => setCfg({ shotLayout: cfg().shotLayout === 'row' ? 'grid' : 'row' }));
    fitBtn = iconBtn('shrink', 'Fit', () => setCfg({ shotFit: cfg().shotFit === 'cover' ? 'contain' : 'cover' }));
    const bar = h('div.toolbar.shots-bar', {},
      h('label.size', { title: 'Preview size (Ctrl+wheel)' }, h('span', { html: icon('image') }), slider),
      layoutBtn, fitBtn,
      h('button.chip.snip', { type: 'button', title: 'Snip a screenshot (S)', onclick: snip }, h('span', { html: icon('scissors') }), h('span.lbl', {}, 'Snip')),
      iconBtn('folder', 'Open screenshots folder', () => call('open_shots_dir')));

    strip = h('div.strip', { role: 'listbox', 'aria-label': 'Screenshots', tabIndex: 0 });
    const at = e => tiles.indexOf(e.target.closest('.tile'));
    strip.addEventListener('pointerdown', e => {
      const i = at(e);
      if (i < 0) return;
      select(i);
      if (!e.target.closest('.more')) press(e, i, tiles[i]);
    });
    strip.addEventListener('click', e => {
      const i = at(e), more = e.target.closest('.more');
      if (more) return shotMenu(i, more);
      if (noClick || e.detail > 1) return void (noClick = false); // after a drag / 2nd click of a double-click
      if (i >= 0) copy(i);
    });
    strip.addEventListener('dblclick', e => at(e) >= 0 && !e.target.closest('.more') && call('open_shot', { name: shots[at(e)].name }));
    strip.addEventListener('contextmenu', e => {
      e.preventDefault();
      if (at(e) >= 0) openLook(at(e));
    });
    strip.addEventListener('wheel', e => {
      const d = e.deltaY * (e.deltaMode ? 40 : 1);
      if (e.ctrlKey) return e.preventDefault(), setSize((cfg().shotSize ?? 220) - Math.sign(d) * 20);
      if (cfg().shotLayout !== 'row' || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      e.preventDefault(); // row layout: the wheel scrolls across
      strip.scrollBy({ left: d, behavior: Math.abs(d) >= 50 ? 'smooth' : 'auto' });
    }, { passive: false });

    lookImg = h('img.ql-img', {
      alt: '', decoding: 'async', draggable: 'false',
      onpointerdown: e => press(e, lookAt, lookImg),
      onload: () => showDims(lookImg),
    });
    lookCap = h('div.ql-cap');
    look = h('div.ql', {
      hidden: true,
      title: 'Click: copy · Drag: drop into any app · ←/→: browse · M: mark up · Right-click / Esc: close',
      onclick: e => {
        if (e.target.closest('button')) return;
        if (noClick) return void (noClick = false);
        copy(lookAt, look);
      },
      oncontextmenu: e => {
        e.preventDefault();
        closeLook();
      },
    }, h('div.ql-dim'), lookImg, lookCap, h('span.badge', { html: icon('check') }),
      iconBtn('chevron-left', 'Previous (←)', () => step(-1), 'ql-prev'),
      iconBtn('chevron-right', 'Next (→)', () => step(1), 'ql-next'),
      iconBtn('x', 'Close (Esc)', () => closeLook(), 'ql-x'),
      moreBtn('ql-more', e => shotMenu(lookAt, e.currentTarget)));

    pane.append(bar, strip, look);
    // one-shot animation classes (new, sent, copied) clear themselves: keyframes are named shot-<class>
    pane.addEventListener('animationend', e => {
      if (!e.animationName.startsWith('shot-')) return; // not ours (e.g. the markup editor's mk-out)
      const c = e.animationName.slice(5);
      e.target.closest?.('.' + c)?.classList.remove(c);
    });
    applyCfg();
    on('config', applyCfg);
    on('markup-done', saved => {
      if (saved) load(saved);
      if (visible()) strip.focus({ preventScroll: true });
    });
  },

  show() {
    applyCfg();
    load();
    (markupEl() ?? strip).focus({ preventScroll: true });
  },
  hide() { closeLook(true) },
  onOpen() { if (visible()) load() },
  onClose() { closeLook(true) },

  keydown(e) {
    const k = e.key, t = e.target, s = shots[sel], looking = lookAt >= 0, key = k.toLowerCase(), mk = markupEl();
    if (mk) { // the editor has its own keys (they only reach it while it has focus)
      if (!mk.contains(t)) mk.focus();
      return false;
    }
    if (e.ctrlKey || e.altKey || e.metaKey || t.closest?.('input, textarea, select, [contenteditable]')) return false;
    if ((k === 'Enter' || k === ' ') && t.closest?.('button')) return false; // let buttons click
    let done = true;
    if (looking && (k === 'Escape' || k === ' ')) closeLook();
    else if (looking && (k === 'ArrowLeft' || k === 'ArrowRight')) step(k === 'ArrowLeft' ? -1 : 1);
    else if (!looking && MOVES.includes(k)) move(k);
    else if (!looking && k === ' ' && s) openLook(sel);
    else if (k === 'Enter' && s) copy(sel, looking ? look : tiles[sel]);
    else if (key === 's') snip();
    else if (key === 'o' && s) call('open_shot', { name: s.name });
    else if (key === 'r' && s) call('reveal_shot', { name: s.name });
    else if (key === 'm' && s) openMarkup(s);
    else if (key === 't' && s) copyTextFrom(s.path);
    else if ((k === 'ContextMenu' || (k === 'F10' && e.shiftKey)) && s)
      shotMenu(sel, looking ? look.querySelector('.ql-more') : tiles[sel].querySelector('.more'));
    else done = false;
    if (done) e.preventDefault();
    return done;
  },

  async dropFiles(paths) {
    if (dragging) return; // our own drag-out landed back on the panel
    const n = await call('import_files', { paths });
    if (n === undefined) return;
    toast(n ? `Added ${n} image${n > 1 ? 's' : ''}` : 'No new images to add');
    if (n) load();
  },

  dropText() { return false },

  paste(e) {
    const file = [...(e.clipboardData?.files ?? [])].find(f => /^image\/(png|jpe?g|gif|webp|bmp)$/.test(f.type));
    if (!file) return false;
    e.preventDefault();
    savePasted(file);
    return true;
  },
};
