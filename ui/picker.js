// Screen colour picker: the swatch on the collapsed island while picking, and the result.
// Rust (picker.rs) emits color-hover {hex}, then color-picked {hex, rgb} or color-cancel.
import { state, $, h, call, listen, toast } from './core.js';

let mode = null, timer = 0; // 'hover' | 'done' while the island shows the picker pill
const swatch = h('span.pick-swatch'), hexEl = h('span.pick-hex');

function show(hex, ...kids) {
  swatch.style.background = hexEl.textContent = hex;
  $('#peek').replaceChildren(swatch, ...kids);
  $('#island').classList.add('peeking', 'picking');
}

function hide() {
  clearTimeout(timer);
  if (mode) $('#island').classList.remove('picking', 'peeking');
  mode = null;
}

/** Once at boot. */
export function mountPicker() {
  const island = $('#island');
  // a peek from just before (core.js peek()) drops 'peeking' when its timer ends: keep it while the pill is ours
  new MutationObserver(() => mode && !island.classList.contains('peeking') && island.classList.add('peeking'))
    .observe(island, { attributeFilter: ['class'] });
  listen('color-hover', ({ hex }) => {
    if (state.detached) return; // a popped-out window stays open: only the result shows (a toast)
    clearTimeout(timer);
    mode = 'hover';
    show(hex, hexEl, h('span.pick-hint', {}, 'Click to pick · Esc'));
  });
  listen('color-picked', ({ hex }) => {
    if (state.isOpen) return hide(), toast(`Copied ${hex}`); // popped out, or reopened mid-pick: the pill is hidden
    mode = 'done';
    show(hex, h('b', {}, 'Copied'), hexEl);
    clearTimeout(timer);
    timer = setTimeout(hide, 2500);
  });
  listen('color-cancel', hide);
}

/** Collapse and pick the next pixel clicked anywhere (Esc cancels). */
export const pickColor = () => call('pick_color');
