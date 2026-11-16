// Stroke geometry and the saved form for the canvas: no gpui or herdr imports, so node can
// test it (test.mjs). Points are flat arrays [x0, y0, x1, y1, ...] in world units, which are
// screen px at zoom 1.

export const SHARP = 100;     // degrees of turn past which a corner gets a round dot, not a curve
const SHARP_COS = Math.cos((SHARP * Math.PI) / 180);
export const GENTLE = 30;     // degrees: turns up to this bend over their whole sides, twice this only within CORNER
export const CORNER = 6;      // world px a corner's curve reaches along each side
export const STREAM = 0.45;   // input smoothing: how far each point lags toward the last one

/** Moves `next` part of the way from `last`, so trackpad jitter is damped while drawing. */
export const stream = (lx, ly, x, y) => [lx + (x - lx) * (1 - STREAM), ly + (y - ly) * (1 - STREAM)];

const UNSHRINK = -10 / 9;  // Taubin's second step (see `smooth`): how far it pushes back out

/** How many points each way one point's smoothing reaches (both passes of `smooth`). */
export const REACH = 4;

/** A [1,2,3,2,1] moving average with the ends kept, so wobble doesn't show. */
function average(p) {
  const n = p.length / 2, out = p.slice(), W = [1, 2, 3, 2, 1];
  for (let i = 1; i < n - 1; i++) {
    let sx = 0, sy = 0, sw = 0;
    for (let k = -2; k <= 2; k++) {
      const j = i + k;
      if (j < 0 || j >= n) continue;
      sx += p[2 * j] * W[k + 2]; sy += p[2 * j + 1] * W[k + 2]; sw += W[k + 2];
    }
    out[2 * i] = sx / sw; out[2 * i + 1] = sy / sw;
  }
  return out;
}

/** Smooths out wobble without shrinking curves (Taubin smoothing): a moving average, which alone
 *  pulls points toward the inside of a curve (a fast circle drawn with 12 points lost 17% of its
 *  radius), then a step back out by UNSHRINK times what a second average would move. Broad
 *  shapes keep their size; wobble from point to point still goes. The ends are kept. */
export function smooth(p) {
  if (p.length / 2 < 4) return p.slice();
  const a = average(p), b = average(a);
  for (let i = 2; i < a.length - 2; i++) a[i] += UNSHRINK * (b[i] - a[i]);
  return a;
}

/** Distance from (x, y) to the segment (ax, ay)-(bx, by). */
function segDist(x, y, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}

/** Ramer-Douglas-Peucker: drops points within `eps` of the line their neighbours make. */
export function simplify(p, eps) {
  const n = p.length / 2;
  if (n < 3) return p.slice();
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = /** @type {[number, number]} */ (stack.pop());
    let max = 0, at = -1;
    for (let i = a + 1; i < b; i++) {
      const d = segDist(p[2 * i], p[2 * i + 1], p[2 * a], p[2 * a + 1], p[2 * b], p[2 * b + 1]);
      if (d > max) { max = d; at = i; }
    }
    if (max > eps) { keep[at] = 1; stack.push([a, at], [at, b]); }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(p[2 * i], p[2 * i + 1]);
  return out;
}

/** Drops points closer than `min` to the previous kept one (the last point always stays). */
export function dedupe(p, min) {
  const out = [p[0], p[1]];
  for (let i = 2; i < p.length; i += 2) {
    const last = i === p.length - 2;
    const d = Math.hypot(p[i] - out[out.length - 2], p[i + 1] - out[out.length - 1]);
    if (d >= min) out.push(p[i], p[i + 1]);
    else if (last && d > 1e-6) { out[out.length - 2] = p[i]; out[out.length - 1] = p[i + 1]; }
  }
  return out;
}

/** The stroke as kept: smoothed, then thinned to what still changes its shape at zoom `z`. */
export const finish = (p, z) => simplify(smooth(dedupe(p, 0.5 / z)), 0.35 / z);

/** Polyline length. */
export function length(p) {
  let l = 0;
  for (let i = 2; i < p.length; i += 2) l += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
  return l;
}

/** Whether the stroke was meant as a straight line (held still at its end): it stays near its
 *  chord, doesn't double back, and is long enough on screen at zoom `z`. */
export function straight(p, z) {
  const n = p.length / 2;
  if (n < 2) return false;
  const ax = p[0], ay = p[1], bx = p[p.length - 2], by = p[p.length - 1];
  const chord = Math.hypot(bx - ax, by - ay);
  if (chord * z < 24 || length(p) > chord * 1.25) return false;
  let dev = 0;
  for (let i = 1; i < n - 1; i++) dev = Math.max(dev, segDist(p[2 * i], p[2 * i + 1], ax, ay, bx, by));
  return dev * z <= Math.max(8, chord * z * 0.1);
}

/** The end of a straight line from (ax, ay), set exactly level or upright within 4 degrees. */
export function level(ax, ay, bx, by) {
  const a = Math.abs(Math.atan2(by - ay, bx - ax)) * 180 / Math.PI;
  if (a < 4 || a > 176) return [bx, ay];
  if (Math.abs(a - 90) < 4) return [ax, by];
  return [bx, by];
}

/** The tightest radius a quadratic curve from (ax, ay) round (cx, cy) to (bx, by) turns on. Its
 *  direction is 2((1-t)u + tv) (u, v its two legs) and u × v is fixed, so it turns tightest
 *  where that direction is shortest: the point of the segment u-v nearest the origin. */
function bend(ax, ay, cx, cy, bx, by) {
  const ux = cx - ax, uy = cy - ay, vx = bx - cx, vy = by - cy;
  const cross = Math.abs(ux * vy - uy * vx);
  if (cross < 1e-12) return Infinity;
  const wx = vx - ux, wy = vy - uy, ww = wx * wx + wy * wy;
  const t = ww < 1e-12 ? 0 : Math.max(0, Math.min(1, -(ux * wx + uy * wy) / ww));
  const speed = 2 * Math.hypot(ux + t * wx, uy + t * wy);
  return speed ** 3 / (4 * cross);
}

/** Traces the stroke into a path builder, in px from (ox, oy) at zoom `z`. Straight runs stay
 *  straight; a gentle turn becomes a curve spread over both sides (meeting the next at the
 *  midpoint), a firmer one a curve reaching at most CORNER along each side, so a fast, sparsely
 *  sampled stroke reads as one smooth curve while a long straight run keeps a crisp turn. A turn sharper
 *  than SHARP (a V, a hairpin) ends the line at the corner and starts it again, and `corner`
 *  gets that point in px to put a round dot on: GPUI strokes join with mitres, which a sharp
 *  turn draws as a spike past the corner.
 *  A curve that would turn tighter than `hw` (half the line's width, world px) is drawn as such
 *  a corner too: GPUI draws a curve tighter than a thick line in that line with thin spikes.
 *  `part` traces a stroke in pieces: { i, ex, ey } (the point to go on from and where the line
 *  has got to; omitted, the start) and `stop` (the point to stop before, with no line to the
 *  end), updated to go on from where it stopped. */
export function trace(b, p, ox, oy, z, corner = (_x, _y) => {}, part = null, hw = 0) {
  const n = p.length / 2;
  const X = (i) => (p[2 * i] - ox) * z, Y = (i) => (p[2 * i + 1] - oy) * z;
  let ex = part?.ex ?? p[0], ey = part?.ey ?? p[1];
  const stop = part?.stop ?? n - 1;
  b = b.move_to((ex - ox) * z, (ey - oy) * z);
  for (let i = part?.i ?? 1; i < stop; i++) {
    const x = p[2 * i], y = p[2 * i + 1];
    const inx = x - p[2 * i - 2], iny = y - p[2 * i - 1], lin = Math.hypot(inx, iny);
    const outx = p[2 * i + 2] - x, outy = p[2 * i + 3] - y, lout = Math.hypot(outx, outy);
    if (lin < 1e-6 || lout < 1e-6) continue;
    // A gentle turn is a curve sampled sparsely (a fast stroke), so it bends over the whole of
    // both sides and the curves meet at the midpoints; a real corner bends only within CORNER.
    const turn = Math.acos(Math.max(-1, Math.min(1, (inx * outx + iny * outy) / (lin * lout)))) * 180 / Math.PI;
    const k = Math.max(0, Math.min(1, (turn - GENTLE) / GENTLE));
    const reach = (l) => (l / 2) * (1 - k) + Math.min(CORNER, l / 2) * k;
    const rin = reach(lin) / lin, rout = reach(lout) / lout;
    const ax = x - inx * rin, ay = y - iny * rin, bx = x + outx * rout, by = y + outy * rout;
    if (inx * outx + iny * outy < SHARP_COS * lin * lout || bend(ax, ay, x, y, bx, by) < hw) {
      if (Math.hypot(x - ex, y - ey) > 1e-3) b = b.line_to((x - ox) * z, (y - oy) * z);
      b = b.move_to((x - ox) * z, (y - oy) * z);
      corner((x - ox) * z, (y - oy) * z);
      ex = x; ey = y;
      continue;
    }
    if (Math.hypot(ax - ex, ay - ey) > 1e-3) b = b.line_to((ax - ox) * z, (ay - oy) * z);
    ex = bx; ey = by;
    b = b.curve_to((ex - ox) * z, (ey - oy) * z, (x - ox) * z, (y - oy) * z);
  }
  if (part?.stop !== undefined) { Object.assign(part, { i: stop, ex, ey }); return b; }
  if (n > 1 && Math.hypot(p[2 * n - 2] - ex, p[2 * n - 1] - ey) > 1e-3) b = b.line_to(X(n - 1), Y(n - 1));
  return b;
}

/** A circle as a closed subpath. Stroked at DOT times its radius it paints a solid dot
 *  (1 + DOT / 2) times the radius: the canvas's round line ends. */
export const DOT = 2.2;
export function circle(b, x, y, r) {
  return b.move_to(x + r, y)
    .arc_to(r, r, 0, false, true, x - r, y)
    .arc_to(r, r, 0, false, true, x + r, y)
    .close();
}

/** [minX, minY, maxX, maxY]. */
export function box(p) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < p.length; i += 2) {
    x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]);
    y0 = Math.min(y0, p[i + 1]); y1 = Math.max(y1, p[i + 1]);
  }
  return [x0, y0, x1, y1];
}

/** Saved form: tenths of a px, each point as the change from the last. */
export function encode(p) {
  const out = [];
  let px = 0, py = 0;
  for (let i = 0; i < p.length; i += 2) {
    const x = Math.round(p[i] * 10), y = Math.round(p[i + 1] * 10);
    out.push(x - px, y - py);
    px = x; py = y;
  }
  return out;
}

export function decode(a) {
  const out = [];
  let x = 0, y = 0;
  for (let i = 0; i + 1 < a.length; i += 2) {
    x += a[i]; y += a[i + 1];
    out.push(x / 10, y / 10);
  }
  return out;
}

/** Whether (x, y) is within r of the polyline. */
export function nearLine(p, x, y, r) {
  const n = p.length / 2;
  if (n === 1) return Math.hypot(p[0] - x, p[1] - y) <= r;
  for (let i = 0; i < n - 1; i++) {
    const ax = p[2 * i], ay = p[2 * i + 1], bx = p[2 * i + 2], by = p[2 * i + 3];
    const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy;
    const t = l ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l)) : 0;
    if (Math.hypot(ax + t * dx - x, ay + t * dy - y) <= r) return true;
  }
  return false;
}

/** Distance between the segments (ax, ay)-(bx, by) and (cx, cy)-(dx, dy). */
function segSegDist(ax, ay, bx, by, cx, cy, dx, dy) {
  const side = (px, py, qx, qy, rx, ry) => (qx - px) * (ry - py) - (qy - py) * (rx - px);
  const d1 = side(ax, ay, bx, by, cx, cy), d2 = side(ax, ay, bx, by, dx, dy);
  const d3 = side(cx, cy, dx, dy, ax, ay), d4 = side(cx, cy, dx, dy, bx, by);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
  return Math.min(segDist(ax, ay, cx, cy, dx, dy), segDist(bx, by, cx, cy, dx, dy),
    segDist(cx, cy, ax, ay, bx, by), segDist(dx, dy, ax, ay, bx, by));
}

/** Whether the polyline comes within r of the segment (ax, ay)-(bx, by): what a pointer moving
 *  along that segment touches. */
export function nearSegment(p, ax, ay, bx, by, r) {
  const n = p.length / 2;
  if (n === 1) return segDist(p[0], p[1], ax, ay, bx, by) <= r;
  for (let i = 0; i < n - 1; i++) {
    if (segSegDist(p[2 * i], p[2 * i + 1], p[2 * i + 2], p[2 * i + 3], ax, ay, bx, by) <= r) return true;
  }
  return false;
}

/** Whether a segment crosses or lies in the rectangle [x0, y0, x1, y1] (Liang-Barsky). */
function segmentInRect(ax, ay, bx, by, r) {
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dy = by - ay;
  const edges = [[-dx, ax - r[0]], [dx, r[2] - ax], [-dy, ay - r[1]], [dy, r[3] - ay]];
  for (const [p, q] of edges) {
    if (p === 0) { if (q < 0) return false; continue; }
    const t = q / p;
    if (p < 0) { if (t > t1) return false; t0 = Math.max(t0, t); }
    else { if (t < t0) return false; t1 = Math.min(t1, t); }
  }
  return true;
}

/** Whether the polyline touches the rectangle [x0, y0, x1, y1]. */
export function lineInRect(p, r) {
  const n = p.length / 2;
  if (n === 1) return p[0] >= r[0] && p[0] <= r[2] && p[1] >= r[1] && p[1] <= r[3];
  for (let i = 0; i < n - 1; i++) if (segmentInRect(p[2 * i], p[2 * i + 1], p[2 * i + 2], p[2 * i + 3], r)) return true;
  return false;
}

/** Whether two [x0, y0, x1, y1] boxes overlap. */
export const overlap = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

/** A PNG's pixel size and the scale that shows it at its intended size (0.5 for a Retina
 *  screenshot, from its pHYs density). Null when the bytes aren't a PNG. */
export function pngSize(b) {
  const sig = [0x89, 0x50, 0x4e, 0x47];
  if (b.length < 24 || sig.some((v, i) => b[i] !== v)) return null;
  const u32 = (o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const w = u32(16), h = u32(20);
  let scale = 1;
  for (let o = 8; o + 8 <= b.length;) {
    const len = u32(o), type = String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]);
    if (type === "pHYs" && o + 17 <= b.length && b[o + 16] === 1) {
      const dpi = u32(o + 8) * 0.0254;
      if (dpi > 80) scale = 72 / dpi;
      break;
    }
    if (type === "IDAT" || type === "IEND") break;
    o += 12 + len;
  }
  return { w, h, scale };
}

// ---- Arrows ------------------------------------------------------------------------------

export const HEAD = 28;  // degrees each barb of an arrow's head sits off its shaft

/** The head of an arrow p = [x0, y0, x1, y1] drawn w wide: [left barb end, tip, right barb
 *  end], each barb max(10, 4w) long. */
export function head(p, w) {
  const [x0, y0, x1, y1] = p, d = Math.hypot(x0 - x1, y0 - y1) || 1, l = Math.max(10, 4 * w);
  const ux = ((x0 - x1) / d) * l, uy = ((y0 - y1) / d) * l;
  const c = Math.cos((HEAD * Math.PI) / 180), s = Math.sin((HEAD * Math.PI) / 180);
  return [x1 + ux * c - uy * s, y1 + ux * s + uy * c, x1, y1, x1 + ux * c + uy * s, y1 - ux * s + uy * c];
}

/** Paints a head (from `head`) in px from (ox, oy) at zoom `z`: each barb its own straight
 *  line into the tip, as tracing them would round the tip off, and a dot of radius r at
 *  each barb's end. Returns the line and dot builders. */
export function barbs(line, cap, h, ox, oy, z, r) {
  const X = (v) => (v - ox) * z, Y = (v) => (v - oy) * z;
  line = line.move_to(X(h[0]), Y(h[1])).line_to(X(h[2]), Y(h[3]))
    .move_to(X(h[4]), Y(h[5])).line_to(X(h[2]), Y(h[3]));
  return [line, circle(circle(cap, X(h[0]), Y(h[1]), r), X(h[4]), Y(h[5]), r)];
}

// ---- The saved form ----------------------------------------------------------------------

export const IMAGES = "data/canvas/images";  // pasted images, relative to the app folder
export const MARK = "herdr-canvas/1";        // the first line of canvas items on the clipboard

export const tenth = (v) => Math.round(v * 10) / 10;

/** A stroke as drawing.json and the clipboard hold it, moved by (dx, dy). */
export const dumpStroke = (s, dx = 0, dy = 0) =>
  ({ c: s.c, w: s.w, p: encode(s.p.map((v, j) => v + (j % 2 ? dy : dx))), ...(s.a ? { a: 1 } : {}) });

/** Items as drawing.json and the clipboard hold them, moved by (dx, dy). */
export function dump(items, dx = 0, dy = 0) {
  return {
    strokes: items.filter((i) => i.k === "s").map((s) => dumpStroke(s, dx, dy)),
    texts: items.filter((i) => i.k === "t" && i.v.trim())
      .map((t) => ({ x: tenth(t.x + dx), y: tenth(t.y + dy), s: t.s, c: t.c, v: t.v })),
    images: items.filter((i) => i.k === "i")
      .map((m) => ({ x: tenth(m.x + dx), y: tenth(m.y + dy), w: tenth(m.w), h: tenth(m.h), src: m.src })),
  };
}

/** What a saved form holds, checked: entries that can't be read are left out, numbers are
 *  coerced, colors must be "fg" or #hex, sizes are kept within reason, and images must be in
 *  IMAGES. Texts without a size get `size`. Throws when `d` isn't an object whose lists are
 *  arrays, or was saved by a newer version. */
export function undump(d, size) {
  if (typeof d !== "object" || d === null || Array.isArray(d)) throw new Error("not a drawing");
  if (+d.version > 2) throw new Error(`version ${d.version} is newer than this canvas reads`);
  const num = (v, or) => (Number.isFinite(+v) ? +v : or);
  const pos = (v, or, lo, hi) => (num(v, 0) > 0 ? Math.min(hi, Math.max(lo, +v)) : or);
  const color = (v) => (v === "fg" || (typeof v === "string" && /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v)) ? v : "fg");
  const strokes = (d.strokes ?? []).filter((s) => Array.isArray(s?.p) && s.p.length >= 2 && s.p.every(Number.isFinite))
    .map((s) => {
      const p = decode(s.p);
      return { c: color(s.c), w: pos(s.w, 2, 0.5, 200), p, a: s.a === 1 && p.length === 4 ? 1 : 0 };
    });
  const texts = (d.texts ?? []).filter((t) => typeof t?.v === "string" && t.v.trim())
    .map((t) => ({ x: num(t.x, 0), y: num(t.y, 0), s: pos(t.s, size, 2, 1000), c: color(t.c), v: t.v }));
  const images = (d.images ?? []).filter((m) => typeof m?.src === "string" && m.src.startsWith(`${IMAGES}/`) && !m.src.includes(".."))
    .map((m) => ({ x: num(m.x, 0), y: num(m.y, 0), w: pos(m.w, 100, 0, Infinity), h: pos(m.h, 100, 0, Infinity), src: m.src }));
  return { strokes, texts, images };
}

/** A saved view, checked: finite x and y, and z within `zoom` ([min, max]); else the start. */
export function viewOf(v, zoom) {
  const x = +v?.x, y = +v?.y, z = +v?.z;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !(z > 0)) return { x: 0, y: 0, z: 1 };
  return { x, y, z: Math.min(zoom[1], Math.max(zoom[0], z)) };
}

/** Whether a file in IMAGES can go: an image no name in `used` refers to, or a temp file a
 *  paste or drop left over a minute before `now`. Anything else stays. */
export function stale(name, used, now) {
  const temp = /^(?:paste-(\d+)\.tmp|drop-(\d+)\.png)$/.exec(name);
  if (temp) return now - +(temp[1] ?? temp[2]) > 60000;
  return /^[0-9a-f]{24}\.png$/.test(name) && !used.has(name);
}

/** How the minimap shows the world: scale `s` and offset (x, y), so a world point (wx, wy) sits at
 *  (x + wx * s, y + wy * s) in a `w` by `h` minimap. It fits `b` (world box) inside `pad` px,
 *  centered; `s` steps by eighths of a halving, so a pan that grows `b` rarely changes it. */
export function miniFit(b, w, h, pad) {
  const fit = Math.min((w - 2 * pad) / Math.max(1, b[2] - b[0]), (h - 2 * pad) / Math.max(1, b[3] - b[1]));
  const s = 2 ** (Math.floor(Math.log2(fit) * 8) / 8);
  return { s, x: w / 2 - ((b[0] + b[2]) / 2) * s, y: h / 2 - ((b[1] + b[3]) / 2) * s };
}

/** The minimap's [w, h]: the shape of world box `b` with `pad` px around it, as large as fits in
 *  `max` [w, h] and no smaller than `min`, so the drawing fills it rather than floating in it. */
export function miniSize(b, max, min, pad) {
  const bw = Math.max(1, b[2] - b[0]), bh = Math.max(1, b[3] - b[1]);
  const k = Math.min((max[0] - 2 * pad) / bw, (max[1] - 2 * pad) / bh);
  return [Math.round(Math.max(min[0], bw * k + 2 * pad)), Math.round(Math.max(min[1], bh * k + 2 * pad))];
}
