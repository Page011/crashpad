// Sketch editor: a drawing canvas laid over the notes pane. Pen (pressure-sensitive), highlighter,
// eraser (also a pen's eraser end), colours, sizes, undo/redo, clear.
// openSketch(host, src?) resolves to a trimmed, transparent PNG Blob; 'empty' when everything was
// erased; null when cancelled or nothing changed.
import { h, iconBtn, toast, clamp } from './core.js';

const PAD = 16; // transparent margin kept around the drawing, CSS px
const WIDTH = { pen: [2, 4, 8], highlighter: [10, 18, 30], eraser: [12, 24, 48] };
const NAMES = { pen: 'Pen (P)', highlighter: 'Highlighter (H)', eraser: 'Eraser (E)' };
const KEYS = { p: 'pen', h: 'highlighter', e: 'eraser' };
const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

/** Draw stroke `s` (pen: only its segments from index `from` on, for live drawing). */
function paint(ctx, s, from = 1) {
  const p = s.pts;
  ctx.save();
  ctx.globalCompositeOperation = s.tool === 'eraser' ? 'destination-out' : 'source-over';
  ctx.globalAlpha = s.tool === 'highlighter' ? 0.35 : 1;
  ctx.strokeStyle = ctx.fillStyle = s.color;
  ctx.lineCap = ctx.lineJoin = 'round';
  if (p.length === 1) {
    ctx.beginPath();
    ctx.arc(p[0][0], p[0][1], (s.w * p[0][2]) / 2, 0, 7);
    ctx.fill();
  } else if (s.tool === 'pen') {
    // quadratic curves through the midpoints; each segment's width follows the pen pressure
    for (let i = Math.max(1, from); i < p.length; i++) {
      const a = i > 1 ? mid(p[i - 2], p[i - 1]) : p[0], b = mid(p[i - 1], p[i]);
      ctx.lineWidth = s.w * p[i - 1][2];
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.quadraticCurveTo(p[i - 1][0], p[i - 1][1], b[0], b[1]);
      ctx.stroke();
    }
    if (s.done) {
      const a = mid(p.at(-2), p.at(-1));
      ctx.lineWidth = s.w * p.at(-1)[2];
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(p.at(-1)[0], p.at(-1)[1]);
      ctx.stroke();
    }
  } else {
    // one path, so a translucent highlighter doesn't darken where its segments overlap
    ctx.lineWidth = s.w;
    ctx.beginPath();
    ctx.moveTo(p[0][0], p[0][1]);
    for (let i = 1; i < p.length - 1; i++) {
      const m = mid(p[i], p[i + 1]);
      ctx.quadraticCurveTo(p[i][0], p[i][1], m[0], m[1]);
    }
    ctx.lineTo(p.at(-1)[0], p.at(-1)[1]);
    ctx.stroke();
  }
  ctx.restore();
}

export function openSketch(host, src) {
  return new Promise(resolve => {
    const dpr = devicePixelRatio || 1;
    const probe = h('i', { style: 'color: var(--fg)' });
    host.append(probe);
    const fg = getComputedStyle(probe).color;
    probe.style.color = 'var(--accent)';
    const accent = getComputedStyle(probe).color;
    probe.remove();
    const colors = [fg, accent, '#ff453a', '#ff9f0a', '#30d158', '#bf5af2'];
    let tool = 'pen', color = fg, size = 1, W = 0, H = 0, bg = null, live = null, rect = null, raf = 0, done = false;
    const strokes = [], undone = [];

    const base = h('canvas'), over = h('canvas'), ctx = base.getContext('2d'), octx = over.getContext('2d');
    const stage = h('div.sk-stage', {}, base, over);
    const toolBtns = Object.fromEntries(Object.keys(NAMES).map(t => [t, iconBtn(t, NAMES[t], () => ((tool = t), sync()))]));
    const swatches = colors.map(c => h('button.sk-swatch', { type: 'button', title: 'Colour', 'aria-label': 'Colour', style: `--c: ${c}`, onclick: () => {
      color = c;
      if (tool === 'eraser') tool = 'pen';
      sync();
    } }));
    const sizes = ['Thin (1)', 'Medium (2)', 'Thick (3)'].map((title, i) =>
      h('button.sk-size', { type: 'button', title, 'aria-label': title, onclick: () => ((size = i), sync()) }, h('i', { style: `--s: ${4 + i * 4}px` })));
    const undoB = iconBtn('undo', 'Undo (Ctrl+Z)', () => undo());
    const redoB = iconBtn('redo', 'Redo (Ctrl+Y)', () => redo());
    const clearB = iconBtn('clear', 'Clear', () => {
      strokes.push({ tool: 'clear' });
      undone.length = 0;
      redraw();
      sync();
    });
    const root = h('div.sk', { tabindex: '-1', role: 'dialog', 'aria-label': 'Sketch', onkeydown: keys },
      h('div.sk-bar', {},
        h('div.sk-group', {}, ...Object.values(toolBtns)),
        h('div.sk-group', {}, ...swatches),
        h('div.sk-group', {}, ...sizes),
        h('div.sk-group', {}, undoB, redoB, clearB),
        h('span.sk-spacer'),
        h('button.chip', { type: 'button', title: 'Cancel (Esc)', onclick: () => finish(false) }, 'Cancel'),
        h('button.btn', { type: 'button', title: 'Done (Ctrl+Enter)', onclick: () => finish(true) }, 'Done')),
      stage);

    function sync() {
      for (const [t, b] of Object.entries(toolBtns)) b.classList.toggle('on', t === tool), b.setAttribute('aria-pressed', t === tool);
      swatches.forEach((b, i) => b.classList.toggle('on', colors[i] === color && tool !== 'eraser'));
      sizes.forEach((b, i) => b.classList.toggle('on', i === size));
      undoB.disabled = !strokes.length;
      redoB.disabled = !undone.length;
      clearB.disabled = strokes.at(-1)?.tool === 'clear' || (!strokes.length && !bg);
      root.dataset.tool = tool;
    }
    function redraw() {
      ctx.clearRect(0, 0, W, H);
      octx.clearRect(0, 0, W, H);
      const from = strokes.findLastIndex(s => s.tool === 'clear');
      if (from < 0 && bg) ctx.drawImage(bg.img, 0, 0, bg.w, bg.h);
      for (const s of strokes.slice(from + 1)) paint(ctx, s);
    }
    const undo = () => { if (strokes.length) undone.push(strokes.pop()), redraw(); sync(); };
    const redo = () => { if (undone.length) strokes.push(undone.pop()), redraw(); sync(); };

    const ro = new ResizeObserver(() => {
      const r = stage.getBoundingClientRect();
      if (!r.width || !r.height) return;
      [W, H] = [r.width, r.height];
      for (const [c, x] of [[base, ctx], [over, octx]]) {
        c.width = Math.round(W * dpr);
        c.height = Math.round(H * dpr);
        x.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      redraw();
    });

    const pt = e => [e.clientX - rect.left, e.clientY - rect.top, e.pointerType === 'pen' ? clamp(0.3 + e.pressure * 1.2, 0.3, 1.5) : 1];
    stage.addEventListener('pointerdown', e => {
      if (live || (e.pointerType === 'mouse' && e.button !== 0)) return;
      e.preventDefault();
      try { stage.setPointerCapture(e.pointerId); } catch {} // the pointer may already be gone
      rect = stage.getBoundingClientRect();
      const t = e.buttons & 32 ? 'eraser' : tool; // a pen's eraser end
      live = { tool: t, color, w: WIDTH[t][size], pts: [pt(e)] };
      undone.length = 0;
      if (t !== 'highlighter') paint(ctx, live);
    });
    stage.addEventListener('pointermove', e => {
      if (!live) return;
      const n0 = live.pts.length;
      const evs = e.getCoalescedEvents?.();
      for (const ev of evs?.length ? evs : [e]) live.pts.push(pt(ev));
      if (live.tool === 'pen') paint(ctx, live, n0);
      else if (live.tool === 'eraser') paint(ctx, { ...live, pts: live.pts.slice(n0 - 1) });
      else raf ||= requestAnimationFrame(() => {
        raf = 0;
        octx.clearRect(0, 0, W, H);
        if (live) paint(octx, live);
      });
    });
    const up = () => {
      if (!live) return;
      live.done = true;
      strokes.push(live);
      live = null;
      redraw();
      sync();
    };
    stage.addEventListener('pointerup', up);
    stage.addEventListener('pointercancel', up);

    function keys(e) {
      const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
      if (k === 'escape') finish(false);
      else if (mod && k === 'enter') finish(true);
      else if (mod && k === 'z') (e.shiftKey ? redo : undo)();
      else if (mod && k === 'y') redo();
      else if (mod || e.altKey) return;
      else if (KEYS[k]) (tool = KEYS[k]), sync();
      else if (/^[123]$/.test(k)) (size = k - 1), sync();
      else return;
      e.preventDefault();
      e.stopPropagation(); // e.g. Esc cancels the sketch, not the panel
    }

    /** The drawing's pixel bounds plus padding, or null if nothing is drawn. */
    function bounds() {
      const { width: w, height: hh } = base, a = ctx.getImageData(0, 0, w, hh).data;
      let x0 = w, y0 = hh, x1 = -1, y1 = -1;
      for (let y = 0, i = 3; y < hh; y++)
        for (let x = 0; x < w; x++, i += 4)
          if (a[i]) {
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            y1 = y;
          }
      if (x1 < 0) return null;
      const p = Math.round(PAD * dpr);
      return [Math.max(0, x0 - p), Math.max(0, y0 - p), Math.min(w, x1 + 1 + p), Math.min(hh, y1 + 1 + p)];
    }
    async function finish(ok) {
      if (done || (ok && src && !bg)) return; // saving before the old sketch loaded would drop it
      done = true;
      let out = null;
      try {
        if (ok && strokes.length) {
          const b = bounds();
          if (!b) out = 'empty';
          else {
            const c = h('canvas', { width: b[2] - b[0], height: b[3] - b[1] });
            c.getContext('2d').drawImage(base, b[0], b[1], c.width, c.height, 0, 0, c.width, c.height);
            out = await new Promise(r => c.toBlob(r, 'image/png'));
          }
        }
      } catch (e) {
        toast(`Couldn't save the sketch: ${e}`, true);
        out = null;
      }
      ro.disconnect();
      root.classList.add('sk-out');
      setTimeout(() => root.remove(), 180);
      resolve(out);
    }

    host.append(root);
    ro.observe(stage);
    sync();
    root.focus();
    if (src) {
      // re-editing: the old PNG is the background (CORS-clean, so the canvas can still be exported)
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const w = img.naturalWidth / dpr, hh = img.naturalHeight / dpr, s = Math.min(1, W / w || 1, H / hh || 1);
        bg = { img, w: w * s, h: hh * s }; // ponytail: shrinks to fit a smaller pane; a scrollable canvas would keep full size
        redraw();
        sync();
      };
      img.onerror = () => {
        finish(false);
        toast("Couldn't load that sketch to edit it", true);
      };
      img.src = src;
    }
  });
}
