// Notes tab: an Apple-Notes-like editor over a folder of markdown files (cfg.notesDir).
// The document is a contenteditable: markdown comes in through Rust's sanitized render_md and is
// normalized for editing (setDoc); it goes back out through serialize(). Undo is our own
// (snapshots) because the editor restructures the DOM itself (lists, checklists), which native
// contenteditable undo can't follow.
import { state, $$, h, iconBtn, icon, call, toast, assetUrl, ago, clamp, shell, menu } from './core.js';
import { openSketch } from './sketch.js';

const BLOCK = /^(P|DIV|H[1-6]|UL|OL|LI|BLOCKQUOTE|PRE|HR|FIGURE|TABLE|THEAD|TBODY|TR|TD|TH)$/;
const TEXTBLOCK = /^(P|DIV|LI|H[1-6])$/;
const isBlock = n => n?.nodeType === 1 && BLOCK.test(n.nodeName);
const isList = n => n?.nodeName === 'UL' || n?.nodeName === 'OL';
const isRaw = n => n?.nodeType === 1 && n.classList.contains('raw'); // source we don't edit (render_md)
const FM = /^---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/; // front matter, as notes.rs finds it

let pane, root, side, listEl, search, ed, titleBtn, foot;
let notes = [], shown = [], listDir, booted = false;
let cur = null; // open note: { dir, name, text (as last read/written), edited, fresh }
let dirty = false, saveTimer, loadGen = 0, sketching = false, lastRange = null;
let queue = Promise.resolve(); // file operations run one at a time, in order
const run = fn => (queue = queue.then(() => fn()).catch(e => toast(String(e), true)));

// ---------- caret & block helpers ----------
const sel = () => getSelection();
const inEd = n => !!n && ed.contains(n);
const caretAt = (n, off = 0) => sel().collapse(n, off);
const hasImg = n => n.nodeName === 'IMG' || !!n.querySelector?.('img');
const own = b => [...b.childNodes].filter(n => !isList(n)); // a list item's content minus sub-lists
const ownEmpty = b => own(b).every(n => !n.textContent.trim() && !hasImg(n));

function blockOf(n) {
  const b = (n?.nodeType === 1 ? n : n?.parentNode)?.closest('li, p, div, h1, h2, h3, h4, h5, h6, pre, td, th, figure');
  return b && b !== ed && ed.contains(b) && !isRaw(b) ? b : null;
}
const caretBlock = () => (sel().rangeCount ? blockOf(sel().anchorNode) : null);
function topBlock(n) {
  let b = n?.nodeType === 1 ? n : n?.parentNode;
  while (b && b.parentNode !== ed) b = b.parentNode;
  return b;
}
/** Range from the start of block `b` to the caret. */
function beforeCaret(b) {
  const r = document.createRange(), s = sel().getRangeAt(0);
  r.selectNodeContents(b);
  r.setEnd(s.startContainer, s.startOffset);
  return r;
}
function atStart(b) {
  const f = beforeCaret(b).cloneContents();
  return !f.textContent && !f.querySelector('img');
}
/** Empty blocks need a <br> to be tall enough to hold the caret. */
function fill(b) {
  if (ownEmpty(b) && !own(b).some(n => n.nodeName === 'BR')) b.prepend(h('br'));
  return b;
}
function caretEnd() {
  let n = ed;
  while (n.lastChild?.nodeType === 1 && n.lastChild.nodeName !== 'BR' && n.lastChild.contentEditable !== 'false') n = n.lastChild;
  const last = n.lastChild;
  if (last?.nodeType === 3) caretAt(last, last.length);
  else caretAt(n, n.childNodes.length - (last?.nodeName === 'BR' ? 1 : 0));
}
/** Run a DOM restructuring and put the selection back where it was (or at the start of what fn returns). */
function keepSel(fn) {
  const s = sel(), r = s.rangeCount ? s.getRangeAt(0) : null;
  const [a, ao, b, bo] = r ? [r.startContainer, r.startOffset, r.endContainer, r.endOffset] : [];
  const el = fn();
  try {
    if (a?.isConnected && b.isConnected && inEd(a)) return s.setBaseAndExtent(a, ao, b, bo), el;
  } catch {}
  if (el?.isConnected) caretAt(el, 0);
  return el;
}
function retag(el, tag) {
  const n = document.createElement(tag);
  n.append(...el.childNodes);
  el.replaceWith(n);
  return n;
}
/** Move el's following siblings into a shallow clone of its parent (split a list/quote); null if none. */
function splitAfter(el) {
  if (!el.nextSibling) return null;
  const box = el.parentNode.cloneNode(false);
  while (el.nextSibling) box.append(el.nextSibling);
  return box;
}
/** Take el out of its container (quote), splitting the container around it. */
function liftOut(el) {
  const box = el.parentNode, tail = splitAfter(el);
  box.after(el);
  if (tail) el.after(tail);
  if (!box.childNodes.length) box.remove();
  return el;
}
/** Wrap stray inline content at the top level (contenteditable leaves it after big deletions) in <p>s. */
function fixRoot() {
  let p = null;
  for (const n of [...ed.childNodes]) {
    if (isBlock(n)) p = null;
    else (p ??= ed.insertBefore(h('p'), n)).append(n);
  }
}

// ---------- lists ----------
/** Turn block b into an item of a <tag> list (joining an adjacent list of the same kind). */
function listify(b, tag, start = 1) {
  const li = h('li');
  li.append(...b.childNodes);
  let list = b.previousElementSibling;
  if (list?.nodeName !== tag) {
    list = document.createElement(tag);
    if (start !== 1) list.start = start;
    b.before(list);
  }
  list.append(li);
  b.remove();
  const next = list.nextElementSibling;
  if (next?.nodeName === tag) list.append(...next.childNodes), next.remove();
  return li;
}
function task(b, checked) {
  const li = b.nodeName === 'LI' ? b : listify(b, 'UL');
  li.dataset.checked = checked;
  return li;
}
/** A top-level item back to a paragraph (its sub-lists follow it; the list splits around it). */
function toParagraph(li) {
  const list = li.parentNode, tail = splitAfter(li), p = h('p');
  p.append(...own(li));
  list.after(p, ...[...li.children].filter(isList), ...(tail ? [tail] : []));
  li.remove();
  if (!list.children.length) list.remove();
  return fill(p);
}
function outdent(li) {
  const list = li.parentNode, parent = list.parentNode;
  if (parent.nodeName !== 'LI') return toParagraph(li);
  const tail = splitAfter(li);
  if (tail) li.append(tail);
  parent.after(li);
  if (!list.children.length) list.remove();
  return li;
}
function indent(li) {
  const prev = li.previousElementSibling;
  if (!prev) return li;
  let sub = prev.lastElementChild;
  if (!isList(sub)) prev.append((sub = document.createElement(li.parentNode.nodeName)));
  sub.append(li);
  return li;
}
/** Split the item at the caret; the new item is unchecked. */
function splitLi(li) {
  const r = sel().getRangeAt(0);
  r.deleteContents();
  const tail = document.createRange();
  tail.setStart(r.startContainer, r.startOffset);
  tail.setEnd(li, li.childNodes.length);
  const n = li.cloneNode(false);
  n.removeAttribute('class');
  n.append(tail.extractContents());
  if (n.hasAttribute('data-checked')) n.dataset.checked = 'false';
  li.after(n);
  fill(li);
  return fill(n);
}
/** Toolbar/shortcut list commands: kind = task | ul | ol. Toggles off when everything already is one. */
function setList(kind) {
  const r = sel().getRangeAt(0), tag = kind === 'ol' ? 'OL' : 'UL', isTask = kind === 'task';
  const picked = r.collapsed ? [caretBlock()] : $$('li, p, div, h1, h2, h3, h4, h5, h6', ed).filter(b => r.intersectsNode(b));
  const todo = picked.filter(b => b && TEXTBLOCK.test(b.nodeName) && !isRaw(b) && (b.nodeName === 'LI' || !b.closest('li')));
  if (!todo.length) return;
  const already = b => b.nodeName === 'LI' && b.parentNode.nodeName === tag && isTask === b.hasAttribute('data-checked');
  keepSel(() => {
    let first;
    if (todo.every(already)) {
      for (const li of todo.reverse()) {
        while (li.parentNode.parentNode.nodeName === 'LI') outdent(li);
        first = toParagraph(li);
      }
      return first;
    }
    for (const b of todo) {
      let li = b;
      if (b.nodeName !== 'LI') li = listify(b, tag);
      else if (b.parentNode.nodeName !== tag) retag(b.parentNode, tag);
      if (isTask) li.dataset.checked ??= 'false';
      else delete li.dataset.checked;
      first ??= li;
    }
    return first;
  });
}
function toggleTask(li) {
  checkpoint(true);
  li.dataset.checked = li.dataset.checked !== 'true';
  if (li.dataset.checked === 'true') {
    li.classList.add('nt-tick');
    setTimeout(() => li.classList.remove('nt-tick'), 450);
  }
  changed();
}

// ---------- undo (snapshots of the document + caret) ----------
let undos = [], redos = [], lastSnap = 0;
function caretPath() {
  const s = sel();
  if (!s.rangeCount || !inEd(s.anchorNode)) return null;
  const path = [];
  for (let n = s.anchorNode; n !== ed; n = n.parentNode) path.unshift([...n.parentNode.childNodes].indexOf(n));
  return { path, off: s.anchorOffset };
}
const snap = () => ({ html: ed.innerHTML, caret: caretPath() });
/** Record the state before a change; typing within 800 ms of the last change joins its step. */
function checkpoint(force) {
  const now = Date.now();
  if (force || now - lastSnap > 800) {
    undos.push(snap());
    if (undos.length > 200) undos.shift();
    redos = [];
  }
  lastSnap = force ? 0 : now;
}
function travel(from, to) {
  if (!from.length) return;
  to.push(snap());
  const s = from.pop();
  ed.innerHTML = s.html;
  let n = ed;
  for (const i of s.caret?.path ?? []) n = n?.childNodes[i];
  if (s.caret && n) caretAt(n, Math.min(s.caret.off, n.nodeType === 3 ? n.length : n.childNodes.length));
  lastSnap = 0;
  changed();
}
const undo = () => travel(undos, redos), redo = () => travel(redos, undos);
function resetHistory() {
  undos = [];
  redos = [];
  lastSnap = 0;
  lastRange = null;
}

// ---------- editing ----------
function cmd(kind) {
  if (!focusEd()) return;
  checkpoint(true);
  const native = { bold: 'bold', italic: 'italic', underline: 'underline', strike: 'strikeThrough' }[kind];
  if (native) document.execCommand(native);
  else if (kind === 'heading') {
    const b = caretBlock();
    if (b && /^(P|DIV|H[1-6])$/.test(b.nodeName))
      keepSel(() => retag(b, { P: 'H1', DIV: 'H1', H1: 'H2', H2: 'H3' }[b.nodeName] ?? 'P'));
  } else setList(kind);
  changed();
}

/** Markdown shortcuts typed at the start of a block, fired by the space that ends them. */
function autoFormat() {
  const b = caretBlock();
  if (!b || !TEXTBLOCK.test(b.nodeName)) return;
  const r = beforeCaret(b), t = r.toString().replace(/\u00a0/g, ' ');
  if (r.cloneContents().querySelector('img')) return; // the rule would delete the image
  let m, fn;
  if ((m = t.match(/^\[([ xX]?)\] $/))) fn = () => task(b, /x/i.test(m[1]));
  else if (b.nodeName === 'LI' || b.closest('li')) return;
  else if (/^[-*+] $/.test(t)) fn = () => listify(b, 'UL');
  else if ((m = t.match(/^(\d{1,9})[.)] $/))) fn = () => listify(b, 'OL', +m[1]);
  else if ((m = t.match(/^(#{1,3}) $/))) fn = () => retag(b, 'H' + m[1].length);
  else if (t === '> ' && !b.closest('blockquote')) fn = () => { const q = h('blockquote'); b.replaceWith(q); q.append(b); return b; };
  else return;
  checkpoint(true); // undo brings back the typed characters
  r.deleteContents();
  caretAt(fill(fn()), 0);
}

function enter(e) {
  const b = caretBlock();
  if (!b) return;
  const t = b.textContent.replace(/\u00a0/g, ' ');
  let m;
  const act = fn => {
    e.preventDefault();
    checkpoint(true);
    const el = fn();
    if (el) caretAt(el, 0);
    changed();
  };
  if (b.nodeName === 'PRE') return act(() => codeEnter(b));
  if (b.nodeName === 'LI')
    return act(() => (ownEmpty(b) ? (b.parentNode.parentNode.nodeName === 'LI' ? outdent(b) : toParagraph(b)) : splitLi(b)));
  if (!/^(P|DIV)$/.test(b.nodeName) || b.closest('li') || hasImg(b)) return; // (the rules below replace the block)
  if ((m = t.match(/^```\s*([\w+#.-]*)\s*$/)))
    return act(() => {
      const code = h('code', {}, h('br'));
      if (m[1]) code.className = 'language-' + m[1];
      b.replaceWith(h('pre', {}, code));
      return code;
    });
  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(t))
    return act(() => {
      const p = h('p', {}, h('br'));
      b.replaceWith(h('hr'), p);
      return p;
    });
  if (!t.trim() && b.parentNode.nodeName === 'BLOCKQUOTE') act(() => liftOut(b));
}
/** Enter in a code block adds a line; Enter on an empty last line leaves the block. */
function codeEnter(pre) {
  for (const br of pre.querySelectorAll('br')) br.remove();
  const r = sel().getRangeAt(0);
  r.deleteContents();
  const after = document.createRange();
  after.selectNodeContents(pre);
  after.setStart(r.startContainer, r.startOffset);
  const before = beforeCaret(pre).toString(), rest = after.toString();
  if (!rest.trim() && before.endsWith('\n')) {
    (pre.querySelector('code') ?? pre).textContent = before.slice(0, -1);
    const p = h('p', {}, h('br'));
    pre.after(p);
    return p;
  }
  const t = document.createTextNode(rest ? '\n' : '\n\n'); // a trailing newline needs a second one to show
  r.insertNode(t);
  caretAt(t, 1);
}
function backspace(e) {
  if (!sel().isCollapsed) return;
  const b = caretBlock();
  if (!b || !atStart(b)) return;
  let fn;
  if (b.nodeName === 'LI') fn = () => (b.parentNode.parentNode.nodeName === 'LI' ? outdent(b) : toParagraph(b));
  else if (/^H[1-6]$/.test(b.nodeName)) fn = () => retag(b, 'P');
  else if (b.nodeName === 'PRE' && !b.textContent.trim()) fn = () => { const p = h('p', {}, h('br')); b.replaceWith(p); return p; };
  else if (b.parentNode.nodeName === 'BLOCKQUOTE' && /^(P|DIV)$/.test(b.nodeName)) fn = () => liftOut(b);
  else return;
  e.preventDefault();
  checkpoint(true);
  keepSel(fn);
  changed();
}
function tab(e) {
  const r = sel().getRangeAt(0);
  let lis = r.collapsed ? [caretBlock()] : $$('li', ed).filter(li => r.intersectsNode(li));
  if (!lis.length || lis.some(li => li?.nodeName !== 'LI')) return; // outside lists Tab moves focus as usual
  lis = lis.filter(li => !lis.includes(li.parentNode.closest('li'))); // sub-items move with their parent
  e.preventDefault();
  checkpoint(true);
  keepSel(() => {
    for (const li of e.shiftKey ? lis.reverse() : lis) e.shiftKey ? outdent(li) : indent(li);
  });
  changed();
}
function ctrlEnter() {
  const n = sel().anchorNode, a = (n?.nodeType === 1 ? n : n?.parentElement)?.closest('a');
  if (a && inEd(a)) return openHref(a.getAttribute('href'));
  const b = caretBlock();
  b?.hasAttribute('data-checked') ? toggleTask(b) : cmd('task');
}
function edKeys(e) {
  if (e.isComposing) return;
  const k = e.key, key = k.toLowerCase(), mod = e.ctrlKey || e.metaKey;
  const act = fn => (e.preventDefault(), fn());
  const fig = e.target.closest?.('figure.sketch');
  if (fig) {
    if (k === 'Enter' || k === ' ') act(() => draw(fig));
    else if (k === 'Delete' || k === 'Backspace') act(() => { checkpoint(true); fig.remove(); changed(); focusEd(); });
    return;
  }
  if (mod && !e.altKey) {
    if (key === 'z') return act(e.shiftKey ? redo : undo);
    if (key === 'y') return act(redo);
    if (!e.shiftKey && /^[biu]$/.test(key)) return act(() => cmd({ b: 'bold', i: 'italic', u: 'underline' }[key]));
    if (e.shiftKey && key === 'x') return act(() => cmd('strike'));
    if (e.shiftKey && key === 'l') return act(() => cmd('task'));
    if (e.shiftKey && e.code === 'Digit8') return act(() => cmd('ul'));
    if (e.shiftKey && e.code === 'Digit7') return act(() => cmd('ol'));
    if (k === 'Enter') return act(ctrlEnter);
    return;
  }
  if (e.altKey) return;
  if (k === 'Enter' && !e.shiftKey) enter(e);
  else if (k === 'Backspace') backspace(e);
  else if (k === 'Tab') tab(e);
}
function onInput(e) {
  if ([...ed.childNodes].some(n => !isBlock(n))) keepSel(fixRoot);
  if (e.inputType === 'insertText' && e.data === ' ') autoFormat();
  changed();
}
function edDown(e) {
  const li = e.target;
  if (li.matches?.('li[data-checked]') && e.clientX < li.getBoundingClientRect().left) {
    e.preventDefault(); // the checkbox sits in the item's left gutter
    return toggleTask(li);
  }
  const fig = e.target.closest?.('figure.sketch');
  if (fig && e.button === 0) {
    e.preventDefault();
    draw(fig);
  }
}
function openHref(href) {
  let url = href ?? '';
  try { url = decodeURI(url); } catch {}
  if (!/^[a-z][\w+.-]*:/i.test(url)) url = notesDir() + '\\' + url.replace(/\//g, '\\'); // relative to the notes folder
  call('open_link', { url });
}

/** Insert nodes at the caret (or the end of the note). */
function insertAtCaret(nodes) {
  if (!focusEd()) return;
  checkpoint(true);
  const r = sel().getRangeAt(0), last = nodes.at(-1), frag = document.createDocumentFragment();
  r.deleteContents();
  frag.append(...nodes);
  r.insertNode(frag);
  caretAt(last.parentNode, [...last.parentNode.childNodes].indexOf(last) + 1);
  if ([...ed.childNodes].some(n => !isBlock(n))) keepSel(fixRoot);
  changed();
}

// ---------- attachments & sketches ----------
const notesDir = () => cur?.dir ?? state.cfg.notesDir ?? '';
/** URL-encode a relative path the way markdown links want it (parens too). */
const encPath = rel => rel.split('/').map(s => encodeURIComponent(s).replace(/[()]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())).join('/');
/** An image src as a path inside the notes folder; '' when it's absolute (scheme, drive, root, UNC),
 *  climbs out (a `..` segment) or names a stream. */
function localPath(src) {
  let p = src;
  try { p = decodeURIComponent(src); } catch {}
  return /^[\\/]|:/.test(p) || p.split(/[\\/]/).some(s => s !== '.' && /^[. ]+$/.test(s)) ? '' : p.replace(/\//g, '\\');
}
function prepImg(img, src) {
  const p = localPath(src);
  img.dataset.src = src;
  // anything else is never loaded: an absolute src could be a UNC path (Windows would send the
  // user's credentials to that host) or a file outside the notes folder
  if (p) img.src = assetUrl(notesDir() + '\\' + p);
  else img.removeAttribute('src');
  img.draggable = false;
  // sketches show at the size they were drawn (they're saved at device-pixel resolution)
  if (img.alt === 'sketch') img.addEventListener('load', () => (img.style.width = img.naturalWidth / devicePixelRatio + 'px'), { once: true });
  return img;
}
const image = rel => prepImg(h('img', { alt: '' }), encPath(rel));
const sketchFig = img => h('figure.sketch', { contenteditable: 'false', tabindex: '0', title: 'Edit sketch (click or Enter)' }, img);
const fileLink = p => h('a', { href: encodeURI(p.replace(/\\/g, '/')), title: 'Ctrl+click to open' }, p.split(/[\\/]/).pop());

/** Paste as plain text (never the clipboard's HTML), or an image as an attachment. */
function pasteData(dt) {
  const file = [...(dt?.files ?? [])].find(f => /^image\/(png|jpe?g|gif|webp|bmp)$/.test(f.type));
  if (file) return pasteImage(file);
  const text = dt?.getData('text/plain');
  if (!text) return;
  checkpoint(true);
  document.execCommand('insertText', false, text);
}
async function pasteImage(file) {
  const ext = file.type.split('/')[1].replace('jpeg', 'jpg');
  const rel = await call('save_attachment', new Uint8Array(await file.arrayBuffer()), { headers: { ext, prefix: 'image' } });
  if (rel) insertAtCaret([image(rel)]);
}

/** Draw a new sketch below the caret's block, or re-edit `fig`. */
async function draw(fig) {
  if (sketching) return;
  const at = fig ?? topBlock(docRange()?.startContainer), old = fig?.querySelector('img');
  togglePop(false);
  sketching = true;
  root.inert = true;
  const blob = await openSketch(pane, old?.src);
  root.inert = false;
  sketching = false;
  if (!blob || (blob === 'empty' && !fig)) return focusEd();
  // always a new file: undo (and any other note showing the old one) keeps the old drawing
  const rel = blob === 'empty' ? '' :
    await call('save_attachment', new Uint8Array(await blob.arrayBuffer()), { headers: { ext: 'png', prefix: 'sketch' } });
  if (rel === undefined) return focusEd();
  checkpoint(true);
  if (blob === 'empty') fig?.remove();
  else if (fig?.isConnected) prepImg(old, encPath(rel));
  else {
    fig = sketchFig(prepImg(h('img', { alt: 'sketch' }), encPath(rel)));
    const anchor = at?.isConnected && at.parentNode === ed ? at : null;
    if (anchor && /^(P|DIV)$/.test(anchor.nodeName) && ownEmpty(anchor) && !anchor.textContent) anchor.replaceWith(fig);
    else if (anchor) anchor.after(fig);
    else ed.append(fig);
  }
  const next = fig?.isConnected && fig.nextElementSibling;
  if (fig?.isConnected && (!next || next.nodeName === 'FIGURE')) fig.after(h('p', {}, h('br')));
  changed();
  ed.focus({ preventScroll: true });
  fig?.isConnected ? caretAt(fig.nextElementSibling, 0) : caretEnd();
}

// ---------- markdown out ----------
// Plain text is escaped so that it can never turn into markup when the file is read back: emphasis,
// code, HTML/autolinks/comments, entities, task boxes, and `](`/`]:` (which every link, image and
// reference definition needs; other brackets stay as typed, e.g. [[wiki links]]).
const ESC = /[\\`*~]|(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])|<(?=[/!?a-z])|&(?=#?\w+;)|\[(?=[ xX]?\])|\](?=[(:])/giu;
const ESC_LINK = new RegExp(ESC.source + '|[\\[\\]]', 'giu'); // inside a link's text: every bracket
const escText = (s, link) => s.replace(/\u00a0/g, ' ').replace(link ? ESC_LINK : ESC, '\\$&');
/** Escape what would read as block syntax at the start of a line (incl. a table's delimiter row). */
const escLine = l => l.trimStart() // (only what would parse: "#tag", "-5", "1.5 kg" stay as typed)
  .replace(/^(?:#(?=#*(?:\s|$))|>|[-+](?=\s|$)|-(?=[-\s]*$)|=(?=[=\s]*$)|[|:](?=[\s|:-]*$))/, '\\$&')
  .replace(/^(\d{1,9})([.)])(?=\s|$)/, '$1\\$2');
function wrap(s, a, b = a) {
  const [, lead, core, trail] = s.match(/^([\s\0]*)([\s\S]*?)([\s\0]*)$/); // (\0: a <br>)
  return core ? lead + a + core + b + trail : s;
}
const longest = (s, re) => Math.max(0, ...(s.match(re) ?? []).map(x => x.length));
function codeSpan(s) {
  if (!s) return '';
  // a space pad keeps edge backticks apart and survives the one space CommonMark strips per side
  const f = '`'.repeat(longest(s, /`+/g) + 1), pad = /^[` ]|[` ]$/.test(s) && /[^ ]/.test(s) ? ' ' : '';
  return f + pad + s + pad + f;
}
const dest = u => (/[\s()<>]/.test(u) ? `<${u.replace(/[<>]/g, encodeURIComponent)}>` : u);
const title = t => (t ? ` "${t.replace(/["\\]|&(?=#?\w+;)/g, '\\$&')}"` : '');
const imgMd = n => {
  const src = n.dataset.src ?? n.getAttribute('src');
  return src == null ? '' : `![${escText(n.alt, true)}](${dest(src)}${title(n.getAttribute('title'))})`;
};
/** Inline nodes as markdown; a <br> is \0 until lines() makes it a hard break. */
function inline(nodes, link) {
  let out = '';
  for (const n of nodes) {
    if (n.nodeType === 3) out += escText(n.data, link);
    if (n.nodeType !== 1) continue;
    const t = n.nodeName, kids = n.childNodes;
    if (isRaw(n)) out += n.textContent;
    else if (t === 'BR') out += '\0';
    else if (t === 'B' || t === 'STRONG') out += wrap(inline(kids, link), '**');
    else if (t === 'I' || t === 'EM') out += wrap(inline(kids, link), '*');
    else if (t === 'S' || t === 'DEL' || t === 'STRIKE') out += wrap(inline(kids, link), '~~');
    else if (t === 'U') out += wrap(inline(kids, link), '<u>', '</u>');
    else if (t === 'CODE') out += codeSpan(n.textContent);
    else if (t === 'A') {
      const href = n.getAttribute('href') ?? '', txt = n.textContent;
      out = out.replace(/!$/, '\\!') + // (or it'd be an image)
        (!n.children.length && !n.dataset.title && /^[a-z][\w+.-]{1,31}:[^\s<>]*$/i.test(href) && (href === txt || (href === 'mailto:' + txt && /^[\w.+-]+@[\w-]+(\.[\w-]+)*$/.test(txt)))
          ? `<${txt}>` // was an autolink
          : `[${inline(kids, true)}](${dest(href)}${title(n.dataset.title)})`);
    }
    else if (t === 'IMG') out += imgMd(n);
    else if (isBlock(n)) out += '\n' + inline(kids, link) + '\n';
    else out += inline(kids, link);
  }
  return out;
}
/** Inline markdown as lines: soft breaks stay, <br>s become hard breaks (bar trailing ones), blank lines survive
 *  as &nbsp;, trailing spaces go (two would make a hard break; markdown drops them anyway). */
const lines = s => s.replace(/^\n+|[\n\0]+$/g, '').replace(/[ \t]+(?=\n|$)/g, '').replace(/\0/g, '\\\n')
  .split('\n').map(l => escLine(l) || '&nbsp;').join('\n').replace(/^&nbsp;$/, '');
const para = nodes => lines(inline(nodes));
const OPENS = /^(UL|OL|PRE|BLOCKQUOTE)$/, CLOSES = /^(PRE|HR|H\d)$/; // may start right under a line of text / be followed by one
function list(n) {
  const ol = n.nodeName === 'OL', loose = n.hasAttribute('data-loose');
  let i = ol && n.hasAttribute('start') ? n.start : 1, alt = 0; // right after a list of its kind: the other marker, or they'd merge
  for (let s = n.previousElementSibling; s?.nodeName === n.nodeName; s = s.previousElementSibling) alt ^= 1;
  return [...n.children].filter(li => li.nodeName === 'LI').map((li, k) => {
    const mark = ol ? `${i++}${alt ? ')' : '.'} ` : alt ? '* ' : '- ';
    const box = li.hasAttribute('data-checked') ? (li.dataset.checked === 'true' ? '[x] ' : '[ ] ') : '';
    // the item's content in order: runs of text (a double <br> splits paragraphs) and blocks
    const parts = [], run = [];
    const text = () => inline(run.splice(0)).split(/\0\0+/).forEach(s => parts.push([lines(s)]));
    for (const c of li.childNodes) isBlock(c) ? (text(), parts.push([block(c), c])) : run.push(c);
    text();
    let md = parts[0][0] || (box && '&nbsp;'), prev = parts[0];
    for (const p of parts.slice(1)) {
      if (!p[0]) continue;
      const tight = p[1] ? OPENS.test(p[1].nodeName) && (p[1].start ?? 1) === 1 : CLOSES.test(prev[1]?.nodeName);
      md += !md ? (tight ? '' : '\n') : loose || !tight ? '\n\n' : '\n';
      md += p[0];
      prev = p;
    }
    if (!md && !k && n.parentNode?.nodeName === 'LI') md = '&nbsp;'; // an empty first sub-item would read as a heading underline
    return mark + box + md.replace(/\n(?=.)/g, '\n' + ' '.repeat(mark.length));
  }).join(loose ? '\n\n' : '\n');
}
function table(n) {
  const cell = c => inline(c.childNodes).replace(/\0/g, '<br>').replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|');
  const align = c => ({ left: ':--', center: ':-:', right: '--:' })[c.style.textAlign] ?? '---';
  const rows = [...n.rows].map(r => `| ${[...r.cells].map(cell).join(' | ')} |`);
  if (rows.length) rows.splice(1, 0, `| ${[...n.rows[0].cells].map(align).join(' | ')} |`);
  return rows.join('\n');
}
function block(n) {
  const t = n.nodeName;
  if (isRaw(n)) return n.textContent.replace(/\n$/, '');
  if (/^H[1-6]$/.test(t)) return '#'.repeat(t[1]) + ' ' + inline(n.childNodes).replace(/\s*[\n\0]\s*/g, ' ').trim().replace(/(^|\s)(#+)$/, '$1\\$2');
  if (isList(n)) return list(n);
  if (t === 'BLOCKQUOTE') return blocks(n).join('\n\n').split('\n').map(l => (l ? '> ' + l : '>')).join('\n');
  if (t === 'PRE') {
    const c = n.textContent, code = n.querySelector('code');
    const info = code?.dataset.info ?? code?.className.match(/language-(\S+)/)?.[1] ?? '';
    const f = (info.includes('`') ? '~' : '`').repeat(Math.max(3, longest(c, info.includes('`') ? /~+/g : /`+/g) + 1));
    return `${f}${info}\n${c && !c.endsWith('\n') ? c + '\n' : c}${f}`;
  }
  if (t === 'HR') return '---';
  if (t === 'FIGURE') return [...n.querySelectorAll('img')].map(imgMd).join('\n');
  if (t === 'TABLE') return table(n);
  return para(n.childNodes);
}
function blocks(el) {
  const out = [];
  let run = [];
  const flush = () => {
    if (run.some(n => n.nodeType === 1 || n.data.trim())) out.push(para(run));
    run = [];
  };
  for (const n of el.childNodes) isBlock(n) ? (flush(), out.push(block(n))) : run.push(n);
  flush();
  return out;
}
const KIND = { B: 'b', STRONG: 'b', I: 'i', EM: 'i', S: 's', DEL: 's', STRIKE: 's', CODE: 'c' };
/** The document as markdown. Empty paragraphs (spacing) are kept as &nbsp; lines. */
function serialize() {
  const doc = ed.cloneNode(true);
  for (const s of doc.querySelectorAll('span:not(.raw), font')) s.replaceWith(...s.childNodes); // styling the browser added
  // an empty <b></b> the browser left behind would split "[t]" from "(u)" into unescaped halves
  for (const e of doc.querySelectorAll('b, strong, i, em, s, del, strike, u, code, a')) if (!e.textContent && !e.querySelector('img') && !e.closest('pre')) e.remove();
  doc.normalize();
  // <i>foo</i><i>bar</i> would be *foo**bar*: one run instead
  for (const e of doc.querySelectorAll('b, strong, i, em, s, del, strike, code')) {
    const p = e.previousSibling;
    if (KIND[p?.nodeName] === KIND[e.nodeName]) p.append(...e.childNodes), e.remove();
  }
  doc.normalize();
  const parts = blocks(doc).map(s => s || '&nbsp;');
  while (parts[0] === '&nbsp;') parts.shift();
  while (parts.at(-1) === '&nbsp;') parts.pop();
  return parts.length ? parts.join('\n\n') + '\n' : '';
}

// ---------- markdown in ----------
/** Load Rust-rendered (sanitized) HTML and reshape it for editing. */
function setDoc(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html; // parsed inert: no image loads before prepImg vets it
  const doc = tpl.content, texts = [], w = document.createTreeWalker(doc, NodeFilter.SHOW_TEXT);
  while (w.nextNode()) texts.push(w.currentNode);
  const hard = n => !n || isBlock(n) || n.nodeName === 'BR' || n.nodeName === 'INPUT';
  for (const t of texts) {
    if (t.parentElement?.closest('pre, .raw')) continue;
    let s = t.data; // the editor is white-space: pre-wrap, so the renderer's layout newlines must go
    if (hard(t.previousSibling)) s = s.replace(/^\n+/, '');
    if (!t.nextSibling || isBlock(t.nextSibling)) s = s.replace(/\n+$/, '');
    if (!s.trim() && hard(t.previousSibling) && hard(t.nextSibling)) s = '';
    s ? (t.data = s) : t.remove();
  }
  for (const l of $$('ul, ol', doc)) if (l.querySelector(':scope > li > p')) l.dataset.loose = ''; // saved back loose
  for (const box of $$('input[type=checkbox]', doc)) {
    const li = box.closest('li');
    if (li) li.dataset.checked = box.checked;
    box.remove();
  }
  for (const p of $$('li > p', doc)) {
    if (p.previousSibling && !isBlock(p.previousSibling)) p.before(h('br'), h('br')); // the item's next paragraph
    p.replaceWith(...p.childNodes);
  }
  for (const c of $$('pre > code', doc)) if (!c.textContent) c.append(h('br'));
  for (const img of $$('img', doc)) {
    const src = img.getAttribute('src') ?? '';
    if (/^data:/i.test(src)) continue;
    prepImg(img, src);
    const p = img.parentNode;
    if (img.alt === 'sketch' && img.src && p.nodeName === 'P' && p.childNodes.length === 1) p.replaceWith(sketchFig(img));
  }
  for (const a of $$('a', doc)) {
    if (a.title) a.dataset.title = a.title; // the markdown's own title, saved back
    a.title = 'Ctrl+click to open';
  }
  for (const b of $$('p, li, h1, h2, h3, h4, h5, h6', doc)) fill(b);
  ed.replaceChildren(doc);
  if (!ed.lastChild || ed.lastChild.contentEditable === 'false') ed.append(h('p', {}, h('br'))); // room to type after inert blocks
  ed.classList.toggle('is-empty', isEmpty());
}
const isEmpty = () => !ed.textContent.trim() && !ed.querySelector('img, hr, li, table, pre, figure');

// ---------- note files ----------
const stub = name => ({ name, title: '', snippet: '', modified: Date.now(), created: Date.now(), words: 0, pinned: false, text: '' });
const sortNotes = () => notes.sort((a, b) => b.pinned - a.pinned || b.modified - a.modified);
const countWords = t => t.replace(FM, '').split(/\s+/).filter(w => /[\p{L}\p{N}]/u.test(w)).length;
/** A markdown line as plain text (mirrors notes.rs `plain`, for instant list updates). */
function plainLine(l) {
  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) return '';
  return l.replace(/^\s*(?:(?:>|[-*+](?=\s)|#+(?=\s)|\d+[.)](?=\s))\s*)*(?:\[[ xX]\]\s*)?/, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/<\/?u>|&nbsp;/g, ' ').replace(/\\(.)|[*~`]/g, '$1')
    .replace(/\s+/g, ' ').trim();
}
const meta = () => cur && notes.find(n => n.name === cur.name);
const remember = name => state.cfg.notesDir && state.cfg.lastNote !== name && shell.setConfig({ lastNote: name });

function changed() {
  dirty = true;
  if (cur) cur.edited = true;
  ed.classList.toggle('is-empty', isEmpty());
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => run(flush), 400);
}
/** Write the open note if it changed (creating it on first input into an empty folder). Queued. */
async function flush() {
  clearTimeout(saveTimer);
  if (!dirty) return;
  if (!cur && !(await createFresh())) return;
  const at = cur, crlf = at.text.includes('\r\n'), text = crlf ? serialize().replace(/\n/g, '\r\n') : serialize();
  dirty = false;
  if ((await call('write_note', { dir: at.dir, name: at.name, text, base: at.text })) === undefined) {
    dirty = true;
    // refused because the notes folder changed or another app edited the file: this buffer can
    // never be saved there, so it goes to the clipboard and the note reloads
    const f = await call('read_note', { name: at.name });
    if (!f || at !== cur || (f.dir === at.dir && f.text === at.text)) return; // something else: retry on the next save
    await rescue(f.dir !== at.dir ? 'Notes folder changed' : 'This note was changed in another app');
    void (f.dir !== at.dir ? reboot() : openNote(at.name));
    return;
  }
  at.text = text;
  if (at !== cur) return;
  const lines = text.replace(FM, '').split('\n').map(plainLine).filter(Boolean), m = meta() ?? (notes.unshift(stub(at.name)), notes[0]);
  Object.assign(m, { title: lines[0] ?? '', snippet: lines.slice(1).join(' ').slice(0, 90), modified: Date.now(), words: countWords(text), text });
  sortNotes();
  renderList();
  renderHead();
  renderFoot();
}
async function createFresh() {
  const name = await call('create_note');
  const f = name && (await call('read_note', { name }));
  if (!f) return false;
  cur = { dir: f.dir, name, text: '', edited: true, fresh: true };
  notes.unshift(stub(name));
  remember(name);
  return true;
}
/** Leaving the open note: save it, rename its file after its title, drop it if it's a new note left empty. Queued. */
async function leave(switching) {
  await flush();
  if (!cur || dirty) return;
  if (switching && cur.fresh && !cur.text.trim()) {
    if ((await call('delete_note', { name: cur.name })) !== undefined) forget(cur.name);
    cur = null;
    return;
  }
  if (!cur.edited) return;
  const name = await call('rename_note', { name: cur.name, title: cur.text });
  if (name === undefined || !cur) return;
  cur.edited = false;
  if (name === cur.name) return;
  const old = cur.name, m = meta();
  if (m) m.name = name;
  cur.name = name;
  state.cfg.pinnedNotes = (state.cfg.pinnedNotes ?? []).map(n => (n === old ? name : n)); // Rust already saved these
  if (state.cfg.lastNote === old) remember(name);
  renderList();
}
function forget(name) {
  notes = notes.filter(n => n.name !== name);
  state.cfg.pinnedNotes = (state.cfg.pinnedNotes ?? []).filter(n => n !== name);
  if (state.cfg.lastNote === name) state.cfg.lastNote = '';
}

async function openNote(name) {
  const gen = ++loadGen;
  await run(() => leave(name !== cur?.name));
  if (dirty) return false; // the open note couldn't be saved: stay on it
  const f = await call('read_note', { name });
  const html = f && (await call('render_md', { text: f.text }));
  if (gen !== loadGen || html == null) return false;
  if (dirty) await run(flush); // typed into the old note while this one loaded
  if (dirty || gen !== loadGen) return false;
  cur = { dir: f.dir, name: f.name, text: f.text };
  if (!notes.some(n => n.name === name)) notes.unshift(stub(name));
  setDoc(html);
  resetHistory();
  remember(name);
  renderList();
  renderHead();
  renderFoot();
  return true;
}
function blank() {
  cur = null;
  loadGen++;
  setDoc('');
  resetHistory();
  renderList();
  renderHead();
  renderFoot();
}
async function openFirst() {
  const n = notes.find(x => x.name === state.cfg.lastNote) ?? notes[0];
  n ? await openNote(n.name) : blank();
}
async function refresh() {
  await shell.flushConfig(); // a folder just picked in Settings must reach Rust before it lists
  const dir = state.cfg.notesDir, l = await call('list_notes');
  if (!l) return;
  notes = l;
  listDir = dir;
  renderList();
  renderHead();
  renderFoot();
}
async function boot() {
  booted = true;
  await refresh();
  await openFirst();
}
/** Pick up changes made outside crashpad (and a new notes folder). */
async function sync() {
  if (state.cfg.notesDir !== listDir) return reboot();
  await run(refresh); // queued, so pending saves land first
  if (!cur || dirty) return;
  if (!notes.some(n => n.name === cur.name)) return openFirst(); // deleted or renamed elsewhere
  const f = await run(() => call('read_note', { name: cur.name }));
  if (!f || dirty || !cur || f.name !== cur.name) return;
  if (f.dir !== cur.dir) return reboot(); // Rust has another folder than the one this note came from
  if (f.text !== cur.text) await openNote(cur.name);
}
/** Unsaved edits that can't be saved where they came from: put them on the clipboard. */
async function rescue(why) {
  dirty = false;
  clearTimeout(saveTimer);
  if (cur) cur.edited = false; // (don't rename the file after text that isn't in it)
  await call('copy_text', { text: serialize() });
  toast(why + ': your unsaved edits were copied to the clipboard', true);
}
let rebooting = null;
/** Start over in a new notes folder (once, however many callers ask meanwhile). */
function reboot() {
  return (rebooting ??= (async () => {
    await run(flush);
    if (dirty) await rescue('Notes folder changed'); // write_note refuses a buffer from the old folder
    cur = null;
    loadGen++;
    await boot();
  })().finally(() => (rebooting = null)));
}

async function newNote() {
  togglePop(false);
  const gen = ++loadGen;
  await run(() => leave(true));
  if (dirty || gen !== loadGen) return;
  const name = await call('create_note');
  if (name && (await openNote(name))) {
    cur.fresh = true;
    focusEd();
  }
}
async function pick(name) {
  togglePop(false);
  if (name === cur?.name || (await openNote(name))) focusEd();
}
async function pin(n) {
  const pinned = !n.pinned;
  if ((await call('pin_note', { name: n.name, pinned })) === undefined) return;
  n.pinned = pinned;
  state.cfg.pinnedNotes = [...(state.cfg.pinnedNotes ?? []).filter(x => x !== n.name), ...(pinned ? [n.name] : [])];
  sortNotes();
  renderList();
}
/** Right-click menu for a note in the list. */
function rowMenu(n, at) {
  menu([
    { label: 'Open', icon: 'note', kbd: 'Enter', run: () => pick(n.name) },
    { label: n.pinned ? 'Unpin' : 'Pin', icon: n.pinned ? 'pin-off' : 'pin', kbd: 'P', run: () => pin(n) },
    { label: 'Show in folder', icon: 'folder', run: () => call('open_notes_dir') },
    'sep',
    { label: 'Delete', icon: 'trash', kbd: 'Del', danger: true, run: () => remove(n.name) },
  ], at);
}
function confirmDelete(n, btn) {
  if (btn.classList.contains('armed')) return remove(n.name);
  btn.classList.add('armed');
  btn.title = 'Click again to delete';
  setTimeout(() => btn.isConnected && (btn.classList.remove('armed'), (btn.title = 'Delete (Del)')), 3000);
}
async function remove(name) {
  const i = shown.findIndex(n => n.name === name), next = (shown[i + 1] ?? shown[i - 1])?.name;
  const wasCur = name === cur?.name;
  if (wasCur) {
    clearTimeout(saveTimer);
    dirty = false;
    cur = null;
    loadGen++;
  }
  const ok = await run(async () => (await call('delete_note', { name })) !== undefined);
  if (ok) {
    forget(name);
    toast('Moved to .trash in the notes folder');
  }
  if (wasCur) {
    const to = ok ? next ?? notes[0]?.name : name;
    to ? await openNote(to) : blank();
  }
  renderList();
}
function step(d) {
  const i = shown.findIndex(n => n.name === cur?.name), n = shown[clamp(i + d, 0, shown.length - 1)];
  if (n && n.name !== cur?.name) openNote(n.name);
}

// ---------- chrome: list, header, footer ----------
function renderList() {
  const q = search.value.trim().toLowerCase(), active = cur?.name ?? '';
  shown = q ? notes.filter(n => `${n.title}\n${n.text}\n${n.name}`.toLowerCase().includes(q)) : notes;
  const focused = document.activeElement?.closest?.('.nt-row')?.dataset.name;
  const tabStop = shown.some(n => n.name === active) ? active : shown[0]?.name;
  const row = n => {
    const pinB = iconBtn(n.pinned ? 'pin-off' : 'pin', n.pinned ? 'Unpin (P)' : 'Pin (P)', () => pin(n));
    const delB = iconBtn('trash', 'Delete (Del)', e => confirmDelete(n, e.currentTarget), 'nt-del');
    pinB.tabIndex = delB.tabIndex = -1;
    return h('div.nt-row', {
      role: 'option', tabindex: n.name === tabStop ? '0' : '-1', 'aria-selected': String(n.name === active),
      dataset: { name: n.name }, onclick: e => e.target.closest('button') || pick(n.name),
      oncontextmenu: e => { e.preventDefault(); rowMenu(n, e); },
    },
      h('div.nt-row-title', {}, n.pinned ? h('span.nt-pinmark', { html: icon('pin') }) : null, h('span', {}, n.title || 'New note')),
      h('div.nt-row-sub', {}, h('time', {}, ago(n.modified)), n.snippet || 'No additional text'),
      h('div.nt-row-acts', {}, pinB, delB));
  };
  const pinned = shown.filter(n => n.pinned), rest = shown.filter(n => !n.pinned);
  listEl.replaceChildren(
    ...(pinned.length ? [h('div.nt-sec', {}, 'Pinned'), ...pinned.map(row)] : []),
    ...(pinned.length && rest.length ? [h('div.nt-sec', {}, 'Notes')] : []),
    ...rest.map(row),
    ...(shown.length ? [] : [h('div.empty', {}, q ? 'No matching notes' : 'No notes yet')]));
  if (focused) [...listEl.children].find(r => r.dataset.name === focused)?.focus();
}
function listKeys(e) {
  const row = e.target.closest('.nt-row');
  if (!row) return;
  const rows = $$('.nt-row', listEl), i = rows.indexOf(row), n = notes.find(x => x.name === row.dataset.name);
  const go = j => rows[clamp(j, 0, rows.length - 1)]?.focus();
  if (e.key === 'ArrowDown') go(i + 1);
  else if (e.key === 'ArrowUp') i ? go(i - 1) : search.focus();
  else if (e.key === 'Home') go(0);
  else if (e.key === 'End') go(rows.length - 1);
  else if (e.key === 'Enter' || e.key === ' ') pick(n.name);
  else if (e.key === 'Delete') {
    const b = row.querySelector('.nt-del');
    if (!b.classList.contains('armed')) toast('Press Delete again to delete');
    confirmDelete(n, b);
  } else if (e.key.toLowerCase() === 'p' && !e.ctrlKey && !e.altKey) pin(n);
  else return;
  e.preventDefault();
}
function searchKeys(e) {
  if (e.key === 'ArrowDown') $$('.nt-row', listEl)[0]?.focus();
  else if (e.key === 'Enter' && shown[0]) pick(shown[0].name);
  else return;
  e.preventDefault();
}
const sideVisible = () => side.offsetParent !== null;
function togglePop(on = !root.classList.contains('pop')) {
  if (!root) return;
  if (on && sideVisible()) return search.focus(); // wide: the list is already on screen
  root.classList.toggle('pop', on);
  titleBtn.setAttribute('aria-expanded', String(on));
  if (on) {
    renderList();
    search.focus();
  }
}
function findNotes() {
  if (!sideVisible()) togglePop(true);
  search.focus();
  search.select();
}
function renderHead() {
  titleBtn.firstChild.textContent = meta()?.title || 'New note';
}
function renderFoot() {
  const m = meta(), words = countWords(cur?.text ?? ''), chars = ed.textContent.length;
  const date = ms => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  foot.replaceChildren(
    h('span', {}, m ? `Edited ${ago(m.modified)}` : 'New note'),
    h('span', {}, `${words} ${words === 1 ? 'word' : 'words'}`),
    h('span', {}, `${chars} ${chars === 1 ? 'character' : 'characters'}`),
    m?.created ? h('span.nt-created', {}, 'Created ' + date(m.created)) : null);
}
/** The selection in the document right now, else where it last was. */
function docRange() {
  const s = sel();
  if (s.rangeCount && inEd(s.anchorNode)) return s.getRangeAt(0).cloneRange();
  return lastRange && inEd(lastRange.startContainer) ? lastRange : null;
}
function focusEd() {
  if (sketching || !ed) return false;
  const s = sel(), r = docRange();
  ed.focus({ preventScroll: true });
  if (r) {
    s.removeAllRanges();
    s.addRange(r);
  } else caretEnd();
  return true;
}

// ---------- tab module ----------
function mount(p) {
  pane = p;
  const tool = (name, title, fn, cls) => {
    const b = iconBtn(name, title, fn, cls);
    b.addEventListener('mousedown', e => e.preventDefault()); // keep the document's selection
    return b;
  };
  search = h('input.nt-search', { type: 'search', placeholder: 'Search notes', 'aria-label': 'Search notes', spellcheck: 'false', oninput: renderList, onkeydown: searchKeys });
  listEl = h('div.nt-list.scroll', { role: 'listbox', 'aria-label': 'Notes', onkeydown: listKeys });
  side = h('aside.nt-side', {},
    h('div.nt-side-head', {}, search, iconBtn('folder', 'Open the notes folder', () => call('open_notes_dir')), iconBtn('plus', 'New note (Ctrl+N)', newNote)),
    listEl);
  titleBtn = h('button.nt-titlebtn', { type: 'button', title: 'All notes', 'aria-haspopup': 'listbox', 'aria-expanded': 'false', onclick: () => togglePop() },
    h('span.nt-titletext'), h('span.nt-chev', { html: icon('chevron-down') }));
  ed = h('div.nt-doc', { contenteditable: 'true', role: 'textbox', 'aria-multiline': 'true', 'aria-label': 'Note' });
  foot = h('footer.nt-foot', { 'aria-live': 'off' });
  root = h('div.nt', {},
    side,
    h('div.nt-main', {},
      h('header.nt-head', {},
        iconBtn('sidebar', 'Show or hide the notes list', () => { root.classList.toggle('noside'); togglePop(false); }, 'nt-sidebtn'),
        titleBtn,
        h('div.nt-tools', { role: 'toolbar', 'aria-label': 'Formatting' },
          tool('list-check', 'Checklist (Ctrl+Shift+L)', () => cmd('task')),
          tool('list', 'Bulleted list (Ctrl+Shift+8)', () => cmd('ul')),
          tool('list-ordered', 'Numbered list (Ctrl+Shift+7)', () => cmd('ol')),
          tool('heading', 'Heading (cycles)', () => cmd('heading')),
          tool('bold', 'Bold (Ctrl+B)', () => cmd('bold'), 'nt-wide'),
          tool('italic', 'Italic (Ctrl+I)', () => cmd('italic'), 'nt-wide'),
          tool('strike', 'Strikethrough (Ctrl+Shift+X)', () => cmd('strike'), 'nt-wide'),
          tool('pen', 'Draw (Ctrl+Shift+D)', () => draw())),
        iconBtn('plus', 'New note (Ctrl+N)', newNote, 'nt-newbtn')),
      h('div.nt-scroll.scroll', {}, ed),
      foot));
  pane.append(root);

  document.execCommand('defaultParagraphSeparator', false, 'p');
  ed.addEventListener('beforeinput', e => {
    if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo') {
      e.preventDefault();
      return e.inputType === 'historyUndo' ? undo() : redo();
    }
    if (e.inputType === 'insertFromPaste') return e.preventDefault(), pasteData(e.dataTransfer); // if the shell didn't route it
    checkpoint(!/^(insertText|deleteContent)/.test(e.inputType));
  });
  ed.addEventListener('input', onInput);
  ed.addEventListener('keydown', edKeys);
  ed.addEventListener('mousedown', edDown);
  ed.addEventListener('click', e => {
    const a = e.target.closest('a');
    if (!a) return;
    e.preventDefault(); // a plain click just places the caret
    if (e.ctrlKey || e.metaKey) openHref(a.getAttribute('href'));
  });
  ed.addEventListener('mousemove', e => ed.classList.toggle('ctrl', e.ctrlKey));
  document.addEventListener('selectionchange', () => {
    const s = sel();
    if (s.rangeCount && inEd(s.anchorNode)) lastRange = s.getRangeAt(0).cloneRange();
  });
  root.addEventListener('mousedown', e => {
    if (root.classList.contains('pop') && !side.contains(e.target) && !titleBtn.contains(e.target)) togglePop(false);
  });
  // popped out, the panel never re-opens: coming back to the window is when other apps' edits show up
  window.addEventListener('focus', () => state.detached && booted && pane.classList.contains('active') && sync());
  renderFoot();
}

function keydown(e) {
  if (sketching) return true; // the sketch editor handles its own keys (Esc cancels it)
  const k = e.key, key = k.toLowerCase(), mod = e.ctrlKey || e.metaKey;
  if (k === 'Escape') {
    if (root.classList.contains('pop')) return togglePop(false), focusEd(), true;
    if (document.activeElement === search && search.value) return (search.value = ''), renderList(), true;
    return false;
  }
  if (!mod || e.altKey) return false;
  const act = fn => (e.preventDefault(), fn(), true);
  if (key === 'n' && !e.shiftKey) return act(newNote);
  if (key === 'f' && !e.shiftKey) return act(findNotes);
  if (key === 'd' && e.shiftKey) return act(() => draw());
  if (e.shiftKey && (k === 'ArrowUp' || k === 'ArrowDown')) return act(() => step(k === 'ArrowUp' ? -1 : 1));
  return false;
}

export default {
  id: 'notes', label: 'Notes', icon: 'note',
  mount,
  async show() {
    await (booted ? sync() : boot());
    const a = document.activeElement; // (arrowing along the tab bar stays there)
    if (pane.classList.contains('active') && !root.contains(a) && !a?.matches('.tab:focus-visible')) focusEd();
  },
  hide() {
    togglePop(false);
    return run(() => leave(false)); // resolves once saved
  },
  onOpen() {
    if (booted && pane.classList.contains('active')) sync();
  },
  onClose() {
    togglePop(false);
    return run(() => leave(false)); // awaitable, e.g. before quitting
  },
  keydown,
  async dropFiles(paths) {
    if (sketching || !paths?.length) return;
    const rels = (await call('import_to_notes', { paths })) ?? [];
    const nodes = paths.flatMap((p, i) => [...(i ? [document.createTextNode('\n')] : []), rels[i] ? image(rels[i]) : fileLink(p)]);
    insertAtCaret(nodes);
  },
  dropText(text, target) {
    if (sketching) return true;
    if (target === search) return (search.value += text), renderList(), true;
    insertAtCaret([document.createTextNode(text)]);
    return true;
  },
  paste(e) {
    if (sketching) return true;
    if (!inEd(e.target)) return false; // e.g. the search box pastes natively
    e.preventDefault();
    pasteData(e.clipboardData);
    return true;
  },
};
