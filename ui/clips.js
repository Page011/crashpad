// Clipboard tab: history of text, images and files (newest first, pinned on top). Clicking a clip
// pastes it into the window you were in (or copies it; Settings > clipClick, Shift flips it).
'use strict';
import { state, on, h, icon, iconBtn, toast, peek, call, listen, assetUrl, ago, clamp, menu } from './core.js';

const FILTERS = [['all', 'All'], ['text', 'Text'], ['image', 'Images'], ['files', 'Files']];
const rows = new Map(); // clip id -> row, reused across updates so thumbnails don't reload
let list, search, clearBtn, hint, chips, selEl;
let clips = [], view = [], sel = 0, selId = null, filter = 'all', armed = 0, heard = false;

const fileName = p => p.split(/[\\/]/).pop() || p;
const glyph = name => h('span.clip-glyph', { html: icon(name) });

/** One line for the collapsed island's "Copied" peek. */
function preview(c) {
  if (c.kind === 'image') return 'Image';
  if (c.kind === 'files') return c.files.length === 1 ? fileName(c.files[0]) : `${c.files.length} files`;
  return c.text;
}

function row(c) {
  const lead = c.kind === 'image'
    ? h('img.clip-thumb', {
        src: assetUrl(c.image), alt: '', loading: 'lazy', decoding: 'async', draggable: false,
        onerror: e => e.target.replaceWith(glyph('image')),
      })
    : glyph(c.kind === 'files' ? 'file' : 'note');
  const n = c.files.length;
  const [text, meta] =
    c.kind === 'image' ? ['Image', c.text]
    : c.kind === 'files' ? [c.files.map(fileName).join(', '), n === 1 ? 'File' : `${n} files`]
    : [c.text.trim().slice(0, 400), `${c.text.length.toLocaleString()} chars`];
  const pin = iconBtn('pin', c.pinned ? 'Unpin (Ctrl+P)' : 'Pin (Ctrl+P)', e => { e.stopPropagation(); togglePin(c); }, 'clip-pin');
  const del = iconBtn('trash', 'Delete (Shift+Del)', e => { e.stopPropagation(); call('remove_clip', { id: c.id }); });
  pin.setAttribute('aria-pressed', c.pinned);
  pin.tabIndex = del.tabIndex = -1; // Ctrl+P / Shift+Del cover the keyboard; rows stay one tab stop
  return h(`div.clip${c.pinned ? '.pinned' : ''}`, {
    id: `clip-${c.id}`, role: 'option', 'aria-selected': 'false',
    title: c.kind === 'files' ? c.files.join('\n') : null,
    onclick: e => act(c.id, e.shiftKey),
    oncontextmenu: e => { e.preventDefault(); rowMenu(c, e); },
    onanimationend: e => e.currentTarget.classList.remove('enter'), // else re-inserting replays it
  },
  lead,
  h('div.clip-body', {}, h('div.clip-text', {}, text), h('div.clip-meta', {}, meta, ' · ', h('span.clip-time'))),
  h('div.clip-acts', {}, pin, del));
}

function render() {
  const q = search.value.trim().toLowerCase();
  const hit = c => (filter === 'all' || c.kind === filter) &&
    (!q || `${c.kind === 'image' ? 'image ' : ''}${c.text}\n${c.files.join('\n')}`.toLowerCase().includes(q));
  const shown = clips.filter(hit), pinned = shown.filter(c => c.pinned);
  view = [...pinned, ...shown.filter(c => !c.pinned)];
  const ids = new Set(clips.map(c => c.id));
  for (const id of rows.keys()) if (!ids.has(id)) rows.delete(id);
  const els = view.map(c => {
    let el = rows.get(c.id);
    if (!el || el.classList.contains('pinned') !== c.pinned) rows.set(c.id, (el = row(c)));
    el.querySelector('.clip-time').textContent = ago(c.time);
    return el;
  });
  const head = t => h('div.clips-head', { role: 'presentation' }, t);
  const p = pinned.length;
  list.replaceChildren(
    ...(p ? [head('Pinned'), ...els.slice(0, p), ...(els.length > p ? [head('Recent')] : [])] : []),
    ...els.slice(p),
    ...(view.length ? [] : [h('div.empty', {}, clips.length ? 'No matches' : 'Copy something and it lands here')]),
  );
  const i = view.findIndex(c => c.id === selId);
  select(i >= 0 ? i : sel); // a removed clip hands the selection to the one now in its place
  clearBtn.disabled = !clips.some(c => !c.pinned);
}

function select(i, scroll = false) {
  sel = clamp(i, 0, view.length - 1);
  selId = view[sel]?.id ?? null;
  selEl?.classList.remove('sel');
  selEl?.setAttribute('aria-selected', 'false');
  selEl = rows.get(selId);
  selEl?.classList.add('sel');
  selEl?.setAttribute('aria-selected', 'true');
  search.setAttribute('aria-activedescendant', selEl?.id ?? '');
  if (scroll && selEl) sel === 0 ? (list.scrollTop = 0) : selEl.scrollIntoView({ block: 'nearest' });
}

/** Click / Enter: paste into the previous window or copy, per settings; `other` (Shift) flips it. */
async function act(id, other) {
  const i = view.findIndex(c => c.id === id);
  if (i >= 0) select(i);
  const paste = (state.cfg.clipClick === 'copy') === other;
  if ((await call('use_clip', { id, paste })) !== undefined && !paste) toast('Copied');
}

const togglePin = c => call('pin_clip', { id: c.id, pinned: !c.pinned });

/** Right-click menu for a clip (the same actions as the keys). */
function rowMenu(c, at) {
  const i = view.findIndex(x => x.id === c.id);
  if (i >= 0) select(i);
  const pasteFirst = state.cfg.clipClick !== 'copy';
  const paste = { label: 'Paste into previous window', icon: 'paste', kbd: pasteFirst ? 'Enter' : 'Shift+Enter', run: () => call('use_clip', { id: c.id, paste: true }) };
  const copy = { label: 'Copy', icon: 'copy', kbd: pasteFirst ? 'Shift+Enter' : 'Enter', run: () => call('use_clip', { id: c.id, paste: false }).then(r => r !== undefined && toast('Copied')) };
  menu([
    ...(pasteFirst ? [paste, copy] : [copy, paste]),
    { label: c.pinned ? 'Unpin' : 'Pin', icon: c.pinned ? 'pin-off' : 'pin', kbd: 'Ctrl+P', run: () => togglePin(c) },
    'sep',
    { label: 'Delete', icon: 'trash', kbd: 'Shift+Del', danger: true, run: () => call('remove_clip', { id: c.id }) },
  ], at);
}

function setFilter(f) {
  filter = f;
  chips.forEach((b, i) => { b.classList.toggle('on', FILTERS[i][0] === f); b.setAttribute('aria-pressed', FILTERS[i][0] === f); });
  selId = null;
  sel = 0;
  render();
  list.scrollTop = 0;
}

/** Clear takes two clicks: the first turns the button into the question. */
function clear() {
  if (!armed) {
    const n = clips.filter(c => !c.pinned).length;
    clearBtn.textContent = `Clear ${n} clip${n === 1 ? '' : 's'}?`;
    clearBtn.classList.add('armed');
    armed = setTimeout(disarm, 4000);
    return;
  }
  disarm();
  call('clear_clips');
}
function disarm() {
  if (!clearBtn) return;
  clearTimeout(armed);
  armed = 0;
  clearBtn.textContent = 'Clear';
  clearBtn.classList.remove('armed');
}

function updateHint() {
  const [a, b] = state.cfg.clipClick === 'copy' ? ['copy', 'paste'] : ['paste', 'copy'];
  const k = (key, what) => h('span', {}, h('span.kbd', {}, key), ` ${what}`);
  hint.replaceChildren(k('Enter', a), k('Shift+Enter', b), k('Ctrl+P', 'pin'), k('Shift+Del', 'delete'));
}

function keydown(e) {
  const k = e.key, t = e.target;
  if ((k === 'Enter' || k === ' ') && t.closest?.('button')) return false; // let buttons click
  if (k === 'Escape') {
    if (armed) disarm();
    else if (search.value) { search.value = ''; search.dispatchEvent(new Event('input')); }
    else return false; // the shell closes the panel
    return true;
  }
  const step = { ArrowDown: 1, ArrowUp: -1, PageDown: 8, PageUp: -8 }[k];
  if (step && !e.altKey) { e.preventDefault(); select(sel + step, true); return true; }
  const c = view[sel];
  if (k === 'Enter' && c) { e.preventDefault(); act(c.id, e.shiftKey); return true; }
  if (e.ctrlKey && k.toLowerCase() === 'p') { e.preventDefault(); if (c) togglePin(c); return true; } // also stops print
  if (e.ctrlKey && k.toLowerCase() === 'f') { e.preventDefault(); search.focus(); search.select(); return true; }
  if (k === 'Delete' && e.shiftKey && c) { e.preventDefault(); call('remove_clip', { id: c.id }); return true; }
  // type-to-search: focusing the box during keydown lets this very key land in it
  if (t !== search && !e.ctrlKey && !e.altKey && !e.metaKey && (k.length === 1 || k === 'Backspace')) search.focus();
  return false;
}

export default {
  id: 'clipboard', label: 'Clipboard', icon: 'clipboard',

  mount(pane) {
    search = h('input.clips-q', {
      type: 'search', placeholder: 'Search clipboard', autocomplete: 'off', spellcheck: false,
      'aria-label': 'Search clipboard', 'aria-controls': 'clips-list',
      oninput: () => { selId = null; sel = 0; render(); list.scrollTop = 0; },
    });
    chips = FILTERS.map(([f, label]) =>
      h(`button.chip${f === filter ? '.on' : ''}`, { type: 'button', 'aria-pressed': String(f === filter), onclick: () => setFilter(f) }, label));
    clearBtn = h('button.chip.clips-clear', { type: 'button', title: 'Clear history (pinned clips stay)', onclick: clear, onblur: disarm }, 'Clear');
    list = h('div.clips-list.scroll#clips-list', { role: 'listbox', 'aria-label': 'Clipboard history' });
    hint = h('div.clips-hint');
    pane.append(
      h('div.clips-bar', {},
        h('label.clips-search', {}, h('span.clips-search-icon', { html: icon('search') }), search),
        h('div.clips-filters', { role: 'group', 'aria-label': 'Show' }, ...chips, clearBtn)),
      list,
      hint,
    );
    updateHint();
    on('config', updateHint);
    listen('clips', next => {
      heard = true;
      const fresh = next[0] && next[0].id !== clips[0]?.id;
      clips = next;
      render();
      if (!fresh) return;
      const el = rows.get(next[0].id); // replay the arrival animation on the new top clip
      el?.classList.remove('enter');
      void el?.offsetWidth;
      el?.classList.add('enter');
      if (!state.isOpen && state.cfg.peek) peek('Copied', preview(next[0]));
    });
    call('get_clips').then(got => {
      if (got && !heard) { clips = got; render(); }
    });
    render();
  },

  show() {
    render(); // fresh relative times
    search.focus({ preventScroll: true });
  },
  hide: () => disarm(),
  onOpen() {
    // like Win+V: every open starts at the newest clip
    search.value = '';
    selId = null;
    sel = 0;
    render();
    list.scrollTop = 0;
  },
  onClose: () => disarm(),
  keydown,
  dropFiles(paths) {
    if (!paths?.length) return;
    call('copy_text', { text: paths.join('\n') }).then(r => r !== undefined && toast(paths.length > 1 ? 'Paths copied' : 'Path copied'));
  },
  dropText(text) {
    if (!text) return false;
    call('copy_text', { text }).then(r => r !== undefined && toast('Copied'));
    return true;
  },
  paste: () => false,
};
