// Shared plumbing for every UI module. Feature modules import from here; app.js wires the shell.
// Contract (see SPEC): keep these exports stable; add, don't rename.
'use strict';
import { icon } from './icons.js';

export const T = window.__TAURI__;
export { icon };

/** Live app state. `cfg` mirrors Rust's Config (camelCase). */
export const state = { cfg: {}, isOpen: false, detached: false, tab: 'notes' };

/** Internal events: 'config' (cfg changed), 'open', 'close', 'detached' (detail: bool), 'tab' (detail: id). */
export const bus = new EventTarget();
export const emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));
export const on = (type, fn) => bus.addEventListener(type, e => fn(e.detail));

export const $ = (s, root = document) => root.querySelector(s);
export const $$ = (s, root = document) => [...root.querySelectorAll(s)];
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Tiny DOM builder: h('button.pill#go', { onclick, title }, 'text', child). Strings are text, never HTML. */
export function h(sel, attrs = {}, ...kids) {
  const [, tag = 'div', rest = ''] = sel.match(/^([a-z0-9-]*)(.*)$/i);
  const el = document.createElement(tag || 'div');
  for (const [, kind, name] of rest.matchAll(/([.#])([\w-]+)/g)) kind === '.' ? el.classList.add(name) : (el.id = name);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v; // only for trusted markup (icons)
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...kids.flat().filter(k => k != null && k !== false));
  return el;
}

/** Icon button: iconBtn('pin', 'Pin', onclick). */
export const iconBtn = (name, title, onclick, cls = '') =>
  h(`button.icon-btn${cls ? '.' + cls : ''}`, { type: 'button', title, 'aria-label': title, onclick, html: icon(name) });

let toastTimer, peekTimer;
/** Short message. Inside the open panel it's a toast; on the collapsed island it becomes a peek. */
export function toast(msg, err = false) {
  if (!state.isOpen) return peek(err ? 'Error' : 'Info', msg);
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (err ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'toast'), clamp(msg.length * 60, 1600, 5000));
}

/** Brief message on the collapsed island (Dynamic Island "activity"). */
export function peek(title, text) {
  const p = $('#peek'), island = $('#island');
  const shown = String(text).replace(/\s+/g, ' ').slice(0, 140);
  p.replaceChildren(h('b', {}, title), shown);
  island.classList.add('peeking');
  clearTimeout(peekTimer);
  peekTimer = setTimeout(() => island.classList.remove('peeking'), clamp(shown.length * 45, 1800, 6000));
}

/** invoke() that reports failures as a toast and resolves to undefined on error. */
export async function call(cmd, args, opts) {
  try {
    return await T.core.invoke(cmd, args, opts);
  } catch (e) {
    toast(String(e), true);
  }
}

/** Subscribe to a Rust event; resolves once listening. */
export const listen = (event, fn) => T.event.listen(event, e => fn(e.payload));

/** Asset URL for a local file (screenshots, image clips, note attachments). */
export const assetUrl = path => T.core.convertFileSrc(path);

/** "just now", "5m", "3h", "Tue", "12 Mar" */
export function ago(ms) {
  const s = (Date.now() - ms) / 1000;
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  const d = new Date(ms);
  return s < 6 * 86400 ? d.toLocaleDateString(undefined, { weekday: 'short' }) : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** Right-click menu. items: [{ label, icon?, kbd?, run, danger?, disabled? } | 'sep'].
 *  at: a MouseEvent, or {x, y} in viewport px, or an element to drop under. Keyboard: ↑↓ Enter Esc. */
let menuEl = null;
export function menu(items, at) {
  closeMenu();
  const el = h('div.ctx', { role: 'menu' });
  for (const it of items) {
    if (it === 'sep') { el.append(h('div.ctx-sep')); continue; }
    if (!it) continue;
    el.append(h(`button.ctx-item${it.danger ? '.danger' : ''}`, {
      type: 'button', role: 'menuitem', disabled: !!it.disabled,
      onclick: () => { closeMenu(); it.run?.(); },
    }, it.icon ? h('span.ctx-ico', { html: icon(it.icon) }) : null, h('span.ctx-label', {}, it.label), it.kbd ? h('span.kbd', {}, it.kbd) : null));
  }
  const box = $('#panel');
  box.append(el);
  menuEl = el;
  el._back = document.activeElement; // where the keyboard was, to return there on close
  // position inside the panel, flipped away from edges
  const r = box.getBoundingClientRect(), w = el.offsetWidth, hh = el.offsetHeight;
  let x, y;
  if (at instanceof Element) { const b = at.getBoundingClientRect(); x = b.left; y = b.bottom + 4; }
  else { x = at?.clientX ?? at?.x ?? r.left + 8; y = at?.clientY ?? at?.y ?? r.top + 8; }
  x = clamp(x, r.left + 4, r.right - w - 4) - r.left;
  y = clamp((y + hh > r.bottom - 4 ? y - hh - 4 : y) - r.top, 4, r.height - hh - 4); // never past the panel
  el.style.translate = `${Math.max(4, x)}px ${Math.max(4, y)}px`;
  el.querySelector('button:not([disabled])')?.focus();
  const onKey = e => {
    const btns = [...el.querySelectorAll('button:not([disabled])')], i = btns.indexOf(document.activeElement);
    if (e.key === 'Escape') closeMenu();
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') btns[(i + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length]?.focus();
    else if (e.key === 'Tab') closeMenu();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  const onDown = e => { if (!el.contains(e.target)) closeMenu(); };
  el.addEventListener('keydown', onKey);
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('mousedown', onDown, true);
  el._off = () => { document.removeEventListener('keydown', onKey, true); document.removeEventListener('mousedown', onDown, true); };
  return el;
}
export function closeMenu() {
  if (!menuEl) return;
  const back = menuEl._back;
  menuEl._off?.();
  menuEl.remove();
  menuEl = null;
  if (back?.isConnected && document.activeElement === document.body) back.focus({ preventScroll: true });
}
for (const t of ['close', 'tab', 'detached']) bus.addEventListener(t, closeMenu); // a menu never outlives its pane
export const menuOpen = () => !!menuEl;

// ---- implemented by app.js (the shell); feature modules just call them ----
export const shell = {
  close: () => {},              // close the docked panel
  showTab: id => {},            // switch tab
  setConfig: patch => {},       // merge into state.cfg, apply now, save (debounced); resolves once saved
  flushConfig: () => {},        // resolves once pending config changes have reached Rust
  alert: ({ title, text, actions }) => {}, // island alert card; actions: [{ label, run, primary }]
  dismissAlert: () => {},
  setDetached: on => {},        // pop out / dock back
  quit: () => {},               // flush pending saves (config, every module's onClose), then quit
};
