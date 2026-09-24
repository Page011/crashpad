// Screenshot markup: pen, highlighter, arrow and box over a screenshot, then copy it or save a
// marked copy. The screenshot stays an <img>: asset URLs are cross-origin, so drawing one into a
// canvas would taint it and nothing could be exported. Strokes live in image pixels on a
// transparent canvas laid over the <img>; the export is only the strokes at the image's full size,
// and Rust composites them onto the original (save_markup / copy_markup).
import { $, h, iconBtn, toast, call, emit, state, shell, assetUrl } from './core.js';

const COLORS = [['#ff3b30', 'Red'], ['#ffd60a', 'Yellow'], ['#30d158', 'Green'], ['#0a84ff', 'Blue'], ['#ffffff', 'White'], ['#000000', 'Black']];
const TOOLS = { pen: ['pen', 'Pen (P)', 'p'], hl: ['highlighter', 'Highlighter (H)', 'h'], arrow: ['arrow', 'Arrow (A)', 'a'], rect: ['square', 'Rectangle (R)', 'r'] };
const SIZES = ['Small', 'Medium', 'Large'], WIDTH = [3, 5, 9]; // on-screen px; the highlighter is 4× as wide
const MAX = 8192; // longest side of the exported drawing; Rust stretches it back over bigger shots
const pen = { tool: 'pen', color: COLORS[0][0], size: 1 }; // kept between editors
const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
let open = null; // the editor on screen

/** Draw stroke s (image px). */
function paint(ctx, s) {
  const p = s.pts, a = p[0], b = p.at(-1);
  ctx.globalAlpha = s.tool === 'hl' ? 0.4 : 1;
  ctx.strokeStyle = ctx.fillStyle = s.color;
  ctx.lineWidth = s.w;
  ctx.lineCap = ctx.lineJoin = 'round';
  ctx.beginPath();
  if (s.tool === 'rect') ctx.strokeRect(a[0], a[1], b[0] - a[0], b[1] - a[1]);
  else if (s.tool === 'arrow') {
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]), ux = (b[0] - a[0]) / d, uy = (b[1] - a[1]) / d;
    const hd = Math.min(s.w * 3.5, d), hw = hd * 0.55; // head length, half width
    if (!d) return;
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0] - ux * hd * 0.7, b[1] - uy * hd * 0.7); // the round cap hides inside the head
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(b[0], b[1]);
    ctx.lineTo(b[0] - ux * hd - uy * hw, b[1] - uy * hd + ux * hw);
    ctx.lineTo(b[0] - ux * hd + uy * hw, b[1] - uy * hd - ux * hw);
    ctx.fill();
  } else if (p.length === 1) {
    ctx.arc(a[0], a[1], s.w / 2, 0, 7);
    ctx.fill();
  } else {
    // one path through the midpoints: smooth, and a see-through highlighter doesn't darken where it overlaps itself
    ctx.moveTo(a[0], a[1]);
    for (let i = 1; i < p.length - 1; i++) {
      const m = mid(p[i], p[i + 1]);
      ctx.quadraticCurveTo(p[i][0], p[i][1], m[0], m[1]);
    }
    ctx.lineTo(b[0], b[1]);
    ctx.stroke();
  }
}

/** shot: { name, path } from list_shots. Opens over the Shots tab. */
export function openMarkup(shot) {
  if (state.tab !== 'shots') shell.showTab('shots');
  if (open) return open.focus(); // one at a time; never drop someone's drawing
  const host = $('section[data-pane="shots"]');
  let nw = 0, nh = 0, live = null, box = null, raf = 0, armed = 0, dirty = false, busy = false;
  const strokes = [], undone = [];
  const shown = () => strokes.slice(strokes.findLastIndex(s => s.tool === 'clear') + 1);

  const img = h('img', { alt: '', draggable: 'false', src: assetUrl(shot.path) });
  const cv = h('canvas'), ctx = cv.getContext('2d');
  const fit = h('div.mk-fit', {}, img, cv);
  const toolBtns = Object.entries(TOOLS).map(([t, [ico, title]]) => iconBtn(ico, title, () => pick({ tool: t })));
  const swatches = COLORS.map(([c, name], i) => h('button.mk-swatch', {
    type: 'button', title: `${name} (${i + 1})`, 'aria-label': name, style: `--c: ${c}`, onclick: () => pick({ color: c }),
  }));
  const sizes = SIZES.map((name, i) => h('button.mk-size', { type: 'button', title: name, 'aria-label': name, onclick: () => pick({ size: i }) },
    h('i', { style: `--s: ${4 + i * 3}px` })));
  const undoB = iconBtn('undo', 'Undo (Ctrl+Z)', () => undo());
  const redoB = iconBtn('redo', 'Redo (Ctrl+Y)', () => redo());
  const clearB = iconBtn('clear', 'Clear', () => shown().length && commit({ tool: 'clear' }));
  const copyB = iconBtn('copy', 'Copy with markup (Ctrl+C)', () => out('copy'));
  const saveB = h('button.btn', { type: 'button', title: 'Save as a new file (Ctrl+S)', onclick: () => out('save') }, 'Save');
  const root = h('div.mk', { tabindex: '-1', role: 'dialog', 'aria-label': `Mark up ${shot.name}`, onkeydown: keys },
    h('div.mk-bar', {},
      h('div.mk-group', {}, ...toolBtns),
      h('div.mk-group', {}, ...swatches),
      h('div.mk-group', {}, ...sizes),
      h('div.mk-group', {}, undoB, redoB, clearB),
      h('span.mk-spacer'),
      copyB, saveB, iconBtn('x', 'Close (Esc)', () => close())),
    h('div.mk-stage', {}, fit));

  function pick(o) {
    Object.assign(pen, o);
    sync();
  }
  function sync() {
    const on = (b, yes) => (b.classList.toggle('on', yes), b.setAttribute('aria-pressed', yes));
    toolBtns.forEach((b, i) => on(b, Object.keys(TOOLS)[i] === pen.tool));
    swatches.forEach((b, i) => on(b, COLORS[i][0] === pen.color));
    sizes.forEach((b, i) => on(b, i === pen.size));
    const ink = shown().length > 0;
    undoB.disabled = !strokes.length;
    redoB.disabled = !undone.length;
    clearB.disabled = !ink;
    copyB.disabled = saveB.disabled = !ink || busy;
    if (open && (document.activeElement?.disabled || !root.contains(document.activeElement))) root.focus({ preventScroll: true });
  }
  const frame = () => (raf ||= requestAnimationFrame(render));
  function render() {
    raf = 0;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    if (!nw) return;
    ctx.setTransform(cv.width / nw, 0, 0, cv.height / nh, 0, 0); // image px → canvas px
    for (const s of live ? [...shown(), live] : shown()) paint(ctx, s);
  }
  const edited = () => ((dirty = true), frame(), sync());
  const commit = s => (strokes.push(s), (undone.length = 0), edited());
  const undo = () => strokes.length && (undone.push(strokes.pop()), edited());
  const redo = () => undone.length && (strokes.push(undone.pop()), edited());

  // the canvas matches the image's on-screen box at device resolution; strokes stay in image px
  const ro = new ResizeObserver(([e]) => {
    const d = devicePixelRatio || 1;
    cv.width = Math.round(e.contentRect.width * d);
    cv.height = Math.round(e.contentRect.height * d);
    render();
  });
  img.onload = () => {
    [nw, nh] = [img.naturalWidth, img.naturalHeight];
    fit.style.setProperty('--ar', nw / nh);
    frame();
  };
  img.onerror = () => {
    toast("Couldn't open that screenshot", true);
    done();
  };

  const pt = e => [(e.clientX - box.left) * nw / box.width, (e.clientY - box.top) * nh / box.height];
  fit.addEventListener('pointerdown', e => {
    if (live || busy || !nw || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault(); // keeps keyboard focus where it was
    try { fit.setPointerCapture(e.pointerId); } catch {} // the pointer may already be gone
    box = fit.getBoundingClientRect();
    const w = WIDTH[pen.size] * (pen.tool === 'hl' ? 4 : 1) * nw / box.width; // looks the chosen size at today's zoom
    live = { tool: pen.tool, color: pen.color, w, pts: [pt(e)] };
    frame();
  });
  fit.addEventListener('pointermove', e => {
    if (!live) return;
    if (live.tool === 'arrow' || live.tool === 'rect') live.pts[1] = pt(e);
    else {
      const evs = e.getCoalescedEvents?.();
      for (const ev of evs?.length ? evs : [e]) live.pts.push(pt(ev));
    }
    frame();
  });
  const up = () => {
    const s = live;
    live = null;
    if (s && (s.pts.length > 1 || s.tool === 'pen' || s.tool === 'hl')) commit(s); // an arrow or box needs a drag
    else frame();
  };
  fit.addEventListener('pointerup', up);
  fit.addEventListener('pointercancel', up);

  function keys(e) {
    const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey, t = Object.keys(TOOLS).find(t => TOOLS[t][2] === k);
    if (k === 'escape') close();
    else if (mod && k === 'z') (e.shiftKey ? redo : undo)();
    else if (mod && k === 'y') redo();
    else if (mod && k === 's') out('save');
    else if (mod && k === 'c') out('copy');
    else if (mod || e.altKey) return;
    else if (t) pick({ tool: t });
    else if (/^[1-6]$/.test(k)) pick({ color: COLORS[k - 1][0] });
    else return;
    e.preventDefault();
    e.stopPropagation(); // Esc closes the editor, not the panel; R draws boxes, not reveals
  }

  /** The strokes alone as a transparent PNG at the image's natural size (capped), sent to Rust. */
  async function out(kind) {
    if (busy || !shown().length) return;
    busy = true;
    sync();
    try {
      const k = Math.min(1, MAX / Math.max(nw, nh));
      const c = new OffscreenCanvas(Math.round(nw * k), Math.round(nh * k)), x = c.getContext('2d');
      x.setTransform(k, 0, 0, k, 0, 0);
      shown().forEach(s => paint(x, s));
      const blob = await c.convertToBlob(); // PNG; unlike toBlob it doesn't wait for idle time
      const bytes = new Uint8Array(await blob.arrayBuffer()), opts = { headers: { name: encodeURIComponent(shot.name) } };
      if (kind === 'copy') {
        if ((await call('copy_markup', bytes, opts)) !== undefined) {
          dirty = false; // it's on the clipboard now: closing needn't ask
          toast('Copied with markup');
        }
      } else {
        const name = await call('save_markup', bytes, opts);
        if (name !== undefined) {
          toast(`Saved as ${name}`);
          return done(name);
        }
      }
    } catch (e) {
      toast(`Couldn't export the markup: ${e.message ?? e}`, true);
    } finally {
      busy = false;
      sync();
    }
  }

  /** Esc / ×: unsaved ink asks first (a second press within 4 s discards). */
  function close() {
    if (dirty && shown().length && !armed) {
      armed = setTimeout(() => (armed = 0), 4000);
      return toast('Markup not saved: press Esc again to discard');
    }
    done();
  }
  function done(saved = null) {
    if (open === root) {
      open = null;
      clearTimeout(armed);
      cancelAnimationFrame(raf);
      ro.disconnect();
      root.classList.add('mk-out');
      setTimeout(() => root.remove(), 180);
    }
    emit('markup-done', saved); // shots.js: refresh + select the new file, take the keyboard back
  }

  host.append(root);
  open = root;
  ro.observe(fit);
  sync();
  root.focus({ preventScroll: true });
}
