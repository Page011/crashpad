// Shelf tab: park files for a moment (drop them here, or shake one you're dragging), then drag
// them out into any app, copy them, or zip them. Items are references; nothing is copied or moved.
import { h, icon, iconBtn, call, listen, toast, assetUrl, ago, clamp, menu } from './core.js';

const MOVES = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
const ZIP = icon('file').replace('</svg>', '<path d="M9.5 8.5h2M9.5 11.5h2M9.5 14.5h2M10.5 17v1.5"/></svg>'); // a file with a zipper
let pane, grid, bar, zipRow, zipInput, count;
let items = [], cards = [], known = null, cur = 0, anchor = 0, collapseOn = -1, noClick = false;
let lifting = false, dragging = 0; // a native drag is running / a drop landing now is our own drag coming back
const sel = new Set();

function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
}

/** Restart a one-shot CSS animation class; the pane's animationend handler removes it. */
function play(el, cls) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

// ---------- list ----------
function card(it) {
  const img = it.kind === 'image' && h('img', { alt: '', loading: 'lazy', decoding: 'async', draggable: 'false', src: assetUrl(it.path) });
  const ext = it.kind === 'file' && it.name.match(/\.([a-z0-9]{1,5})$/i)?.[1].toUpperCase();
  return h('div.shelf-card', {
    id: 'shelf-' + it.id, role: 'option', dataset: { id: it.id },
    title: `${it.path}\nClick: select · Drag: drop into any app · Double-click: open · Right-click: menu`,
  },
    h(`div.shelf-thumb${img ? '' : '.glyph'}`, {}, img || h('span.shelf-glyph', { html: icon(it.kind === 'folder' ? 'folder' : 'file') }), ext && h('span.shelf-ext', {}, ext)),
    h('div.shelf-name', {}, it.name), h('div.shelf-meta'), h('span.shelf-check', { html: icon('check') }));
}

/** Show a list from Rust; cards that are new drop in. Returns the ids that just arrived. */
function set(list) {
  if (!list) return [];
  const old = new Map(cards.map(c => [+c.dataset.id, c])), born = [];
  cards = list.map(it => {
    let c = old.get(it.id);
    if (!c) {
      c = card(it);
      if (known && !known.has(it.id)) {
        c.classList.add('new');
        c.style.animationDelay = Math.min(born.length, 8) * 45 + 'ms';
        born.push(it.id);
      }
    }
    return c;
  });
  items = list;
  known = new Set(list.map(i => i.id));
  for (const id of sel) if (!known.has(id)) sel.delete(id);
  grid.classList.toggle('blank', !cards.length);
  grid.replaceChildren(...(cards.length ? cards : [h('div.empty.shelf-empty', {},
    h('span.shelf-empty-ico', { html: icon('folder') }), h('b', {}, 'Nothing on the shelf'),
    'Drop files here, or shake a file you\'re dragging.', h('br'), 'Drag them out later, copy, or zip.')]));
  cur = clamp(cur, 0, Math.max(cards.length - 1, 0));
  paint();
  return born;
}

function paint() {
  cards.forEach((c, i) => {
    const it = items[i], on = sel.has(it.id);
    c.classList.toggle('sel', on);
    c.classList.toggle('cur', i === cur);
    c.setAttribute('aria-selected', on);
    c.querySelector('.shelf-meta').textContent = `${it.kind === 'folder' ? 'Folder' : fmtSize(it.size)} · ${ago(it.added)}`;
  });
  grid.setAttribute('aria-activedescendant', cards[cur]?.id ?? '');
  const n = items.length, s = sel.size;
  count.textContent = !n ? '' : s ? `${s} of ${n} selected` : `${n} item${n > 1 ? 's' : ''}`;
  for (const b of bar.querySelectorAll('[data-need]')) b.disabled = b.dataset.need === 'sel' ? !s : !n;
}

// ---------- selection ----------
const ids = () => [...sel];
/** The selection, else the card under the cursor (keyboard Enter / R without a selection). */
const picked = () => (sel.size ? ids() : items[cur] ? [items[cur].id] : []);
/** Copy / zip fall back to the whole shelf. */
const targets = () => (sel.size ? ids() : items.map(i => i.id));

/** Click semantics: plain = only this; Ctrl = toggle; Shift = range from the anchor (Ctrl+Shift adds it). */
function select(i, ctrl = false, shift = false) {
  if (!cards.length) return;
  i = clamp(i, 0, cards.length - 1);
  if (shift) {
    if (!ctrl) sel.clear();
    for (let k = Math.min(anchor, i); k <= Math.max(anchor, i); k++) sel.add(items[k].id);
  } else {
    const id = items[i].id;
    if (!ctrl) sel.clear();
    if (ctrl && sel.has(id)) sel.delete(id);
    else sel.add(id);
    anchor = i;
  }
  cur = i;
  paint();
  cards[i].scrollIntoView({ block: 'nearest' });
}

function selectAll() {
  for (const it of items) sel.add(it.id);
  paint();
}

function move(k, shift) {
  const n = cards.length;
  if (!n) return;
  let j = cur;
  if (k === 'Home') j = 0;
  else if (k === 'End') j = n - 1;
  else if (k === 'ArrowLeft' || k === 'ArrowRight') j = cur + (k === 'ArrowLeft' ? -1 : 1);
  else {
    const c = cards.findIndex(c => c.offsetTop !== cards[0].offsetTop), cols = c < 0 ? n : c; // real columns
    j = cur + (k === 'ArrowUp' ? -cols : cols);
    if (j >= n && k === 'ArrowDown' && Math.floor(cur / cols) < Math.floor((n - 1) / cols)) j = n - 1;
  }
  if (j >= 0 && j < n) select(j, false, shift);
}

// ---------- actions ----------
async function copy() {
  const t = targets();
  if (!t.length || (await call('shelf_copy', { ids: t })) === undefined) return;
  toast(`Copied ${t.length > 1 ? `${t.length} files` : 'file'} · paste into Explorer or any app`);
  for (const c of cards) if (t.includes(+c.dataset.id)) play(c, 'copied');
}

const open = () => picked().forEach(id => call('shelf_open', { id }));
const reveal = () => picked().length && call('shelf_reveal', { id: picked()[0] });

async function remove() {
  const t = ids();
  if (!t.length) return;
  for (const c of cards) if (sel.has(+c.dataset.id)) c.classList.add('gone');
  await new Promise(r => setTimeout(r, 150));
  set(await call('shelf_remove', { ids: t }));
}

async function clear() {
  if (items.length) set(await call('shelf_clear'));
}

function askZip() {
  if (!items.length) return;
  const d = new Date(), p = n => String(n).padStart(2, '0');
  zipInput.value = `shelf-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  zipRow.hidden = false;
  bar.hidden = true;
  zipInput.focus();
  zipInput.select();
}

function cancelZip(refocus = true) {
  if (zipRow.hidden) return;
  zipRow.hidden = true;
  bar.hidden = false;
  if (refocus) grid.focus({ preventScroll: true });
}

async function doZip() {
  const t = targets(), name = zipInput.value.trim();
  if (!t.length || !name || zipRow.classList.contains('busy')) return;
  zipRow.classList.add('busy');
  const r = await call('shelf_zip', { ids: t, name });
  zipRow.classList.remove('busy');
  if (!r) return zipInput.focus();
  set(r);
  cancelZip();
  select(0); // the zip lands on top
  toast(`Zipped ${t.length} item${t.length > 1 ? 's' : ''} into Downloads`);
}

/** Left button went down on a card: a click selects, moving > 6 px drags the selection out. */
function press(e, i) {
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
    if (!sel.has(items[i]?.id)) select(i);
    dragOut();
  };
  window.addEventListener('pointermove', moved);
  window.addEventListener('pointerup', stop);
  window.addEventListener('pointercancel', stop);
}

async function dragOut() {
  const t = ids();
  if (!t.length || lifting) return;
  lifting = true;
  dragging++;
  const lifted = cards.filter(c => sel.has(+c.dataset.id));
  lifted.forEach((c, k) => { c.classList.add('lift'); c.style.setProperty('--k', Math.min(k, 4)); }); // fanned stack
  const r = await call('shelf_drag', { ids: t }); // resolves when dropped or cancelled
  lifting = false;
  lifted.forEach(c => c.classList.remove('lift')); // cancel: the transition settles it back
  if (r === 'dropped') lifted.forEach(c => play(c, 'sent'));
  // ponytail: a drop back onto our own window reaches dropFiles a moment later; ignore it for 1.5 s
  setTimeout(() => dragging--, 1500);
}

function openMenu(at) {
  const s = sel.size, n = items.length, some = picked().length > 0;
  menu([
    { label: s > 1 ? `Open ${s} items` : 'Open', icon: 'expand', kbd: 'Enter', run: open, disabled: !some },
    { label: 'Show in Explorer', icon: 'folder', kbd: 'R', run: reveal, disabled: !some },
    'sep',
    { label: s ? `Copy ${s > 1 ? `${s} files` : 'file'}` : 'Copy all', icon: 'copy', kbd: 'Ctrl+C', run: copy, disabled: !n },
    { label: s ? 'Zip selected…' : 'Zip all…', icon: 'file', kbd: 'Z', run: askZip, disabled: !n },
    'sep',
    { label: s > 1 ? `Remove ${s} from shelf` : 'Remove from shelf', icon: 'trash', kbd: 'Del', run: remove, danger: true, disabled: !s },
    { label: 'Clear shelf', icon: 'clear', run: clear, danger: true, disabled: !n },
  ], at);
}

// ---------- tab module ----------
export default {
  id: 'shelf', label: 'Shelf', icon: 'folder',

  mount(p) {
    pane = p;
    const act = (ico, label, title, fn, need) => h('button.chip', { type: 'button', title, 'aria-label': title, dataset: { need }, onclick: fn },
      h('span.shelf-ico', { html: ico }), h('span.lbl', {}, label));
    count = h('span.shelf-count.muted', { 'aria-live': 'polite' });
    const clearBtn = iconBtn('clear', 'Clear the shelf', clear, 'shelf-clear');
    clearBtn.dataset.need = 'any';
    bar = h('div.toolbar.shelf-bar', {},
      act(icon('copy'), 'Copy', 'Copy files to the clipboard (Ctrl+C)', copy, 'any'),
      act(ZIP, 'Zip', 'Zip into Downloads (Z)', askZip, 'any'),
      act(icon('expand'), 'Open', 'Open (Enter)', open, 'sel'),
      act(icon('folder'), 'Reveal', 'Show in Explorer (R)', reveal, 'sel'),
      act(icon('trash'), 'Remove', 'Remove from the shelf (Delete)', remove, 'sel'),
      count, clearBtn);
    zipInput = h('input.shelf-zipname', { type: 'text', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Zip file name', placeholder: 'shelf' });
    zipRow = h('div.toolbar.shelf-zip', { hidden: true },
      h('span.shelf-ico.shelf-zipico', { html: ZIP }), zipInput, h('span.muted.shelf-zipto', {}, '.zip → Downloads'),
      h('button.btn', { type: 'button', onclick: doZip }, 'Zip'), iconBtn('x', 'Cancel (Esc)', () => cancelZip()));

    grid = h('div.shelf-grid', { role: 'listbox', 'aria-multiselectable': 'true', 'aria-label': 'Shelf', tabIndex: 0 });
    const at = e => cards.indexOf(e.target.closest('.shelf-card'));
    grid.addEventListener('pointerdown', e => {
      const i = at(e);
      if (i < 0) { // empty space: drop the selection
        if (e.button === 0 && !e.ctrlKey && !e.shiftKey && sel.size) { sel.clear(); paint(); }
        return;
      }
      const keep = !e.ctrlKey && !e.shiftKey && sel.has(items[i].id); // a press on a selected card keeps the group (for dragging it)
      collapseOn = keep ? i : -1;
      if (keep) { cur = anchor = i; paint(); } else select(i, e.ctrlKey, e.shiftKey);
      press(e, i);
    });
    grid.addEventListener('click', e => {
      const i = at(e);
      if (noClick || e.detail > 1) return void (noClick = false); // after a drag / 2nd click of a double-click
      if (i >= 0 && i === collapseOn && !e.ctrlKey && !e.shiftKey) select(i); // a plain click on a group: just this one
      collapseOn = -1;
    });
    grid.addEventListener('dblclick', e => at(e) >= 0 && call('shelf_open', { id: items[at(e)].id }));
    grid.addEventListener('contextmenu', e => {
      e.preventDefault();
      const i = at(e);
      if (i >= 0 && !sel.has(items[i].id)) select(i);
      else if (i >= 0) { cur = i; paint(); }
      openMenu(e);
    });

    pane.append(bar, zipRow, grid,
      h('div.shelf-hint.muted', {}, 'Drag out · Ctrl+C copy · Z zip · Enter open · R reveal · Del remove · Ctrl+A all'));
    // one-shot animation classes (new, sent, copied) clear themselves: keyframes are named shelf-<class>
    pane.addEventListener('animationend', e => {
      const c = e.animationName.replace('shelf-', '');
      e.target.closest?.('.' + c)?.classList.remove(c);
    });
    (async () => {
      await listen('shelf', set);
      set(await call('get_shelf'));
    })();
  },

  show() {
    call('get_shelf').then(set);
    grid.focus({ preventScroll: true });
  },
  hide() { cancelZip(false); },
  onOpen() {},
  onClose() { cancelZip(false); },

  keydown(e) {
    const k = e.key, t = e.target, key = k.toLowerCase(), done = () => (e.preventDefault(), true);
    if (t === zipInput) {
      if (k === 'Enter' && !e.isComposing) return doZip(), done();
      if (k === 'Escape') return cancelZip(), done();
      return false;
    }
    if (k === 'Escape' && !zipRow.hidden) return cancelZip(), done();
    if (t.closest?.('input, textarea, select, [contenteditable]')) return false;
    if ((k === 'Enter' || k === ' ') && t.closest?.('button')) return false; // let buttons click
    if (e.ctrlKey && !e.altKey) {
      if (key === 'a') return selectAll(), done();
      if (key === 'c') return copy(), done();
      return false;
    }
    if (e.altKey || e.metaKey) return false;
    if (MOVES.includes(k)) return move(k, e.shiftKey), done();
    if (k === ' ' && cards[cur]) return select(cur, true), done(); // toggle
    if (k === 'Enter') return open(), done();
    if (key === 'r') return reveal(), done();
    if (key === 'z') return askZip(), done();
    if (k === 'Delete') return remove(), done();
    if (k === 'ContextMenu' || (k === 'F10' && e.shiftKey)) return openMenu(cards[cur] ?? grid), done();
    if (k === 'Escape' && sel.size) { sel.clear(); paint(); return done(); } // first Esc clears; the next closes
    return false;
  },

  async dropFiles(paths) {
    if (dragging) return; // our own drag-out landed back on the panel
    const before = known ?? new Set();
    const r = await call('shelf_add', { paths });
    if (!r) return;
    set(r); // no-op if the 'shelf' event got here first
    const born = r.filter(i => !before.has(i.id)).map(i => i.id);
    if (!born.length) return toast('Already on the shelf');
    sel.clear();
    born.forEach(id => sel.add(id));
    cur = anchor = 0;
    paint();
  },

  dropText() { return false; },
  paste() { return false; },
};
