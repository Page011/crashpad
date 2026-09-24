// Command palette (Ctrl+K in the panel) and the quick-capture bar (global hotkey, collapsed island).
// One search over commands, notes, clips, shots, reminders and the shelf. Typed commands come first:
// a sum ("12*7"), "timer 10m tea", "remind me to call mum tomorrow 5pm", "new note …"; anything
// else can go to Inbox.md. In capture mode (.island.capture) the island is just the bar.
import { state, on, $, h, icon, toast, peek, call, shell, ago, closeMenu } from './core.js';
import notes from './notes.js';
import { pickColor } from './picker.js';
import { parseWhen } from './reminders.js';
import { parseTimer, mmss } from './live.js';

const CAP = 4; // rows per group (and results under the capture bar)
const TABS = [['clipboard', 'Clipboard', 'clipboard'], ['notes', 'Notes', 'note'], ['shots', 'Screenshots', 'image'],
  ['reminders', 'Reminders', 'bell'], ['shelf', 'Shelf', 'folder'], ['live', 'Live', 'sparkle'], ['settings', 'Settings', 'settings']];

/** Plain arithmetic (digits . + - * / % ^ and brackets, optionally after "="): its value, else null.
 *  Needs an operator or the "=", so a bare number stays text. Recursive descent, never eval. */
export function calc(q) {
  const t = q.trim(), s = t.replace(/^=/, '');
  if (/[^\d.\s+\-*/%^()]/.test(s) || !(s !== t || /.[-+*/%^]/.test(s.replace(/\s+/g, '')))) return null;
  const tok = s.match(/\d+\.?\d*|\.\d+|\S/g) ?? [];
  let i = 0;
  const eat = c => tok[i] === c && ++i;
  const atom = () => {
    if (eat('(')) {
      const v = sum();
      if (!eat(')')) throw 0;
      return v;
    }
    if (!/^[\d.]/.test(tok[i] ?? '')) throw 0;
    return +tok[i++];
  };
  const pow = () => { const b = atom(); return eat('^') ? b ** unary() : b; }; // right-assoc, above unary minus
  const unary = () => (eat('-') ? -unary() : eat('+') ? unary() : pow());
  const prod = () => {
    let v = unary();
    for (let op; /^[*/%]$/.test((op = tok[i]));) {
      i++;
      const r = unary();
      v = op === '*' ? v * r : op === '/' ? v / r : v % r;
    }
    return v;
  };
  const sum = () => {
    let v = prod();
    for (let op; (op = tok[i]) === '+' || op === '-';) {
      i++;
      v = op === '+' ? v + prod() : v - prod();
    }
    return v;
  };
  try {
    const v = sum();
    return i === tok.length && Number.isFinite(v) ? +v.toPrecision(12) : null; // 0.1+0.2 → 0.3
  } catch {
    return null;
  }
}

/** "Today 17:00", "Tomorrow 9:00", "Fri 9:00", "12 Mar 9:00" */
function when(ms) {
  const d = new Date(ms), n = Math.round((new Date(ms).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 864e5);
  const day = n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : n > 1 && n < 7 ? d.toLocaleDateString([], { weekday: 'short' })
    : d.toLocaleDateString([], { day: 'numeric', month: 'short' });
  return `${day} ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

// A row: { icon, title, sub?, hay? (more text to match; not sub: "just now" isn't a hit for "no"), verb,
// hint? (capture line), nav? (opens the panel on something), run() → false on failure, else true or
// [title, detail] feedback }.
const ok = r => r !== undefined; // call() resolves undefined on error (and has toasted it)

async function newNote() {
  if (notes.busy) return void toast('Finish or cancel the sketch first', true); // (before making a file)
  const name = await call('create_note');
  if (!name) return false;
  notes.openByName(name, true);
  shell.showTab('notes');
  return true;
}

function commands() {
  const d = state.detached;
  return [
    ...TABS.map(([id, title, ic], i) => ({ icon: ic, title, sub: `Tab · Ctrl+${i + 1}`, hay: `${id} tab`, verb: 'Go', nav: true, run: () => shell.showTab(id) })),
    { icon: 'plus', title: 'New note', sub: 'Notes', verb: 'Create', nav: true, run: newNote },
    { icon: 'scissors', title: 'Snip a screenshot', hay: 'capture screen', verb: 'Run', run: async () => (await shell.close(), ok(await call('snip'))) },
    { icon: 'pipette', title: 'Pick a colour from the screen', hay: 'color eyedropper picker', verb: 'Run', run: () => (pickColor(), true) },
    { icon: d ? 'shrink' : 'expand', title: d ? 'Dock back' : 'Pop out', sub: 'F11', hay: 'window float detach', verb: 'Run', nav: true, run: () => shell.setDetached(!d) },
    { icon: 'power', title: 'Quit crashpad', hay: 'exit', verb: 'Quit', run: () => (shell.quit(), true) },
  ];
}

/** Everything searchable, in groups; rebuilt from fresh data on each open. */
function sources(d) {
  const paste = state.cfg.clipClick === 'paste', base = p => p.split(/[\\/]/).pop();
  return [
    ['Commands', commands()],
    ['Notes', (d.list_notes ?? []).map(n => ({
      icon: n.pinned ? 'pin' : 'note', title: n.title || n.name.replace(/\.md$/i, ''), sub: n.snippet || ago(n.modified), hay: n.text,
      verb: 'Open', nav: true, run: () => (notes.openByName(n.name), shell.showTab('notes')),
    }))],
    ['Clipboard', (d.get_clips ?? []).map(c => ({
      icon: c.kind === 'image' ? 'image' : c.kind === 'files' ? 'file' : 'clipboard',
      title: c.kind === 'image' ? `Image ${c.text}`.trim() : c.kind === 'files' ? c.files.map(base).join(', ') : c.text.replace(/\s+/g, ' ').trim().slice(0, 200),
      sub: ago(c.time), hay: `${c.text} ${c.files.join(' ')}`, verb: paste ? 'Paste' : 'Copy',
      run: async () => ok(await call('use_clip', { id: c.id, paste })) && (paste || ['Copied']),
    }))],
    ['Screenshots', (d.list_shots ?? []).map(s => ({
      icon: 'image', title: s.name, sub: ago(s.modified), verb: 'Copy', run: async () => ok(await call('copy_image', { name: s.name })) && ['Copied'],
    }))],
    ['Reminders', (d.get_reminders ?? []).map(r => ({
      icon: 'bell', title: r.text, sub: r.done ? 'Done' : r.due ? when(r.due) : 'No date', verb: 'Show', nav: true, run: () => shell.showTab('reminders'),
    }))],
    ['Shelf', (d.get_shelf ?? []).map(it => ({
      icon: it.kind === 'folder' ? 'folder' : it.kind === 'image' ? 'image' : 'file', title: it.name, sub: it.path, hay: it.path,
      verb: 'Open', run: async () => ok(await call('shelf_open', { id: it.id })),
    }))],
  ].map(([name, rows]) => [name, rows.map(r => Object.assign(r, { t: r.title.toLowerCase(), hay: `${r.title} ${r.hay ?? ''}`.toLowerCase() }))]);
}

/** The typed command the query spells, if any (shown first, so Enter does it). */
function typed(q) {
  let m, v;
  if ((v = calc(q)) != null) {
    const text = String(v);
    return { icon: 'calculator', title: `= ${text}`, sub: q, verb: 'Copy', run: async () => ok(await call('copy_text', { text })) && ['Copied', text] };
  }
  if ((m = q.match(/^timer\s+(.+)/i)) && (v = parseTimer(m[1]))) {
    const { ms, label } = v, what = `${mmss(ms)}${label ? ` ${label}` : ''}`;
    return { icon: 'clock', title: `Timer ${what}`, verb: 'Start', run: async () => ok(await call('add_timer', { label, ms })) && ['Timer started', what] };
  }
  if ((m = q.match(/^remind\s+(?:me\s+)?(?:to\s+)?(\S.*)/i))) {
    const { text, due } = parseWhen(m[1]), what = due ? `${text} — ${when(due)}` : text;
    return { icon: 'bell', title: `Remind: ${what}`, verb: 'Add', run: async () => ok(await call('add_reminder', { text, due })) && ['Reminder set', what] };
  }
  if ((m = q.match(/^new\s+note\s+(\S.*)/i))) return { icon: 'plus', title: 'New note', sub: `Then type “${m[1]}” as its first line`, verb: 'Create', nav: true, run: newNote };
  return null;
}

const inboxRow = q => ({ icon: 'inbox', title: 'Add to Inbox', sub: q, verb: 'Add', hint: 'Add to Inbox', run: async () => ok(await call('append_inbox', { text: q })) && (notes.onOpen(), ['Added to Inbox', q]) }); // (an open Inbox.md reloads)

/** Groups whose rows contain every word, title-prefix hits first, best group first. */
function search(q) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean), lq = q.toLowerCase(), out = [];
  for (const [name, items] of groups) {
    const hits = items.filter(r => words.every(w => r.hay.includes(w)));
    for (const r of hits) r.rank = r.t.startsWith(lq) ? 0 : words.every(w => r.t.includes(w)) ? 1 : 2;
    hits.sort((a, b) => a.rank - b.rank); // stable: each source keeps its own order (pinned, recent)
    if (hits.length) out.push({ name, rows: hits.slice(0, CAP), best: hits[0].rank });
  }
  return out.sort((a, b) => a.best - b.best);
}

// ---------- the overlay ----------
let island, root, input, hint, list;
let openNow = false, capture = false, back = null, backRange = null, busy = false, after = null, eatDbl = false;
let groups = [], rows = [], sel = 0;

function render(keep = false) {
  const q = input.value.trim(), top = q ? typed(q) : null, inbox = q && inboxRow(q), found = search(q), kids = [];
  const add = r => {
    const i = rows.push(r) - 1;
    r.el = h('div.pal-row', { id: `pal-${i}`, role: 'option', 'aria-selected': 'false', onmousemove: () => i !== sel && select(i), onclick: () => exec(r) },
      h('span.pal-ico', { html: icon(r.icon) }),
      h('span.pal-main', {}, h('span.pal-title', {}, r.title), r.sub ? h('span.pal-sub', {}, r.sub) : null),
      h('span.pal-go', {}, r.verb, h('kbd.kbd', {}, '↵')));
    kids.push(r.el);
  };
  rows = [];
  if (capture) { // the hint line shows row 0 (what Enter does); the list, the alternatives
    if (q) {
      rows.push(top ?? inbox);
      [top && inbox, ...found.flatMap(g => g.rows).sort((a, b) => a.rank - b.rank).slice(0, CAP)].filter(Boolean).forEach(add);
    }
  } else {
    if (top) add(top);
    for (const g of found) kids.push(h('div.pal-head', { role: 'presentation' }, g.name)), g.rows.forEach(add);
    if (inbox) add(inbox);
  }
  list.replaceChildren(...kids);
  list.hidden = !kids.length;
  select(keep ? Math.min(sel, rows.length - 1) : 0);
}

function select(i) {
  rows[sel]?.el?.setAttribute('aria-selected', 'false');
  sel = Math.max(0, i);
  const r = rows[sel];
  r?.el?.setAttribute('aria-selected', 'true');
  r?.el?.scrollIntoView({ block: 'nearest' });
  input.setAttribute('aria-activedescendant', r?.el?.id ?? '');
  hint.replaceChildren(...(r ? [h('kbd.kbd', {}, '↵'), h('span', {}, r.hint ?? (r.verb === 'Go' ? r.title : `${r.verb}: ${r.title}`))]
    : [h('span', {}, 'Enter adds it to your Inbox · also “remind me to … 5pm”, “timer 10m tea”, 12*7')]));
}

async function exec(r) {
  if (!r || busy) return;
  if (capture && !r.nav) { // do it, then collapse (feedback shows as a peek once collapsed)
    busy = true;
    const res = await r.run();
    busy = false;
    if (res === false) return; // failed and toasted: stay, so the text isn't lost
    after = Array.isArray(res) ? res : null;
    return void shell.close();
  }
  hide(!r.nav); // (a nav row in capture mode unfolds the whole panel)
  const res = await r.run();
  if (Array.isArray(res)) toast(res[1] ? `${res[0]} · ${res[1]}` : res[0]);
}

async function load() {
  const cmds = ['list_notes', 'get_clips', 'list_shots', 'get_reminders', 'get_shelf'];
  const got = await Promise.all(cmds.map(c => call(c)));
  if (!openNow) return;
  groups = sources(Object.fromEntries(cmds.map((c, i) => [c, got[i]])));
  render(true);
}

function open({ capture: cap = false } = {}) {
  if (openNow) return void input.focus({ preventScroll: true }); // (a second hotkey press keeps the mode)
  closeMenu(); // its capture-phase key handler would eat the palette's arrows and first Esc
  openNow = true;
  capture = cap;
  back = document.activeElement;
  const s = getSelection();
  backRange = s.rangeCount ? s.getRangeAt(0).cloneRange() : null; // a note's caret (refocusing puts it at the top)
  island.classList.toggle('capture', cap);
  root.hidden = false;
  input.value = '';
  input.placeholder = cap ? 'Jot something down…' : 'Search, or type a command…';
  $('.pal-glyph', root).innerHTML = icon(cap ? 'inbox' : 'search');
  groups = sources({});
  render();
  input.focus({ preventScroll: true });
  load();
}

function hide(restore) {
  if (!openNow) return;
  if (capture) call('set_interactive', { on: false }); // the whole window takes clicks again
  openNow = capture = false;
  eatDbl = true;
  island.classList.remove('capture');
  root.hidden = true;
  if (restore && back?.isConnected && back.checkVisibility()) {
    back.focus({ preventScroll: true });
    const r = backRange;
    if (r && back.contains(r.startContainer)) getSelection().setBaseAndExtent(r.startContainer, r.startOffset, r.endContainer, r.endOffset);
  } else if (restore) shell.showTab(state.tab); // what had focus is gone (an edit that closed): the tab's own focus
  back = backRange = null;
}

/** Esc / Ctrl+K / a click outside: capture mode collapses the island (hide() follows on 'close'). */
const close = () => (capture ? shell.close() : hide(true));

export default {
  mount(el) {
    island = el;
    input = h('input.pal-q', {
      type: 'text', spellcheck: 'false', autocomplete: 'off', role: 'combobox', 'aria-controls': 'pal-list', 'aria-expanded': 'true',
      'aria-label': 'Search or type a command', oninput: () => render(),
    });
    hint = h('div.pal-hint');
    list = h('div#pal-list.pal-list.scroll', { role: 'listbox' });
    root = h('div.pal', {
      hidden: true,
      onmousedown: e => { // the field keeps the keyboard; the dimmed panel around the box closes it
        if (e.target === input) return;
        e.preventDefault();
        if (e.target === root && !capture) hide(true);
      },
    }, h('div.pal-box', { role: 'dialog', 'aria-label': 'Command palette' }, h('div.pal-bar', {}, h('span.pal-glyph'), input), hint, list));
    island.append(root);
    // capture bar: only the bar takes clicks, the rest of the (panel-sized) window lets them through
    let barT;
    new ResizeObserver(() => capture && openNow && (clearTimeout(barT), barT = setTimeout(() => {
      if (!capture || !openNow) return;
      const r = root.getBoundingClientRect(), d = devicePixelRatio, m = 6;
      call('set_interactive', { on: true, rect: [(r.left - m) * d, (r.top - m) * d, (r.width + 2 * m) * d, (r.height + 2 * m) * d] });
    }, (state.cfg.animMs ?? 460) + 60))).observe(root);
    // the palette is modal: focus that wanders off (a tab's show() focusing its editor) comes back
    document.addEventListener('focusin', e => openNow && !root.contains(e.target) && input.focus({ preventScroll: true }));
    // it hid under the pointer: the rest of a double-click on a row mustn't hit the panel beneath (a clip would paste)
    addEventListener('mousedown', e => e.detail < 2 && (eatDbl = false), true);
    for (const t of ['mousedown', 'mouseup', 'click', 'dblclick'])
      addEventListener(t, e => eatDbl && e.detail > 1 && (e.preventDefault(), e.stopImmediatePropagation()), true);
    on('open', () => openNow && requestAnimationFrame(() => input.focus({ preventScroll: true })));
    on('close', () => {
      if (!openNow) return;
      hide(false);
      if (after) peek(after[0], after[1] ?? '');
      after = null;
    });
  },
  open,
  close,
  isOpen: () => openNow,
  keydown(e) {
    const k = e.key, mod = e.ctrlKey || e.metaKey;
    if (k === 'Escape' || (mod && !e.shiftKey && !e.altKey && k.toLowerCase() === 'k')) close();
    else if (k === 'ArrowDown' || k === 'ArrowUp' || k === 'Tab') {
      if (rows.length) select((sel + ((k === 'ArrowUp' || (k === 'Tab' && e.shiftKey)) ? -1 : 1) + rows.length) % rows.length);
    } else if (k === 'Enter' && !e.isComposing) exec(rows[sel]);
    else {
      // typing (and text editing chords) reach the field; other chords and F-keys do nothing here
      if ((mod && !/^(a|c|v|x|y|z|arrowleft|arrowright|backspace|delete|home|end)$/i.test(k)) || /^F\d+$/.test(k)) e.preventDefault();
      if (document.activeElement !== input) input.focus({ preventScroll: true });
      return false;
    }
    e.preventDefault();
    return true;
  },
};
