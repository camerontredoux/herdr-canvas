// Canvas: one global freehand drawing board, opened as a pane in any tab (cmd-shift-e in
// keys.json splits one off to the right: `pane.split` with `"mod": "canvas"`).
//
// Tools, at the left of the toolbar, each with a key (pressed with no modifiers):
// - Pointer (S): click to select (Shift-click adds), drag on empty space to select a range,
//   drag a selection to move it, drag a corner handle to resize it, arrow keys nudge it a
//   screen px (Shift: 10), Backspace deletes it. Picking a color or size changes the
//   selection. Double-click text to edit it, or empty space to type new text there.
// - Pen (A): draw with the left button. Hold still at the end of a roughly straight stroke and
//   it snaps to a straight line, even over text (only the pointer and text tools edit text).
// - Eraser (E): drag across strokes, arrows and text to remove them (they dim until you let
//   go). Images stay; delete them with the pointer.
// - Text (T): click to place text and type. Arrows, Option-arrows (words), Cmd-arrows and
//   Home/End move the caret, Shift selects; Enter for a new line; Esc or click away to finish.
// The pointer is the default tool: the canvas opens with it, and Esc (with nothing selected)
// goes back to it from any other tool, as finishing a text started with the text tool does.
// Everywhere: Cmd-A selects everything (switching to the pointer; in text, all of the text);
// Cmd-C / Cmd-X / Cmd-D copy, cut and duplicate the selection; Cmd-V pastes copied items
// under the pointer, else an image or text; scroll with two fingers (or drag with the middle
// button, or hold Space and drag) to pan; pinch or Cmd-scroll to zoom; Cmd-Z / Cmd-Shift-Z undo and redo; image files
// can be dropped in.
//
// Every copy shows the same drawing: the store below is module state, shared by copies, and
// saved to data/canvas/drawing.json (Herdr's data folder, which stays on this computer), with
// the view, color and size in data/canvas/view.json so panning doesn't rewrite the drawing;
// pasted images are kept in data/canvas/images/, and the ones it no longer uses are deleted
// when it loads. Items never change once made: a move, an edit or a recolor replaces them
// with new ones, keeping their place in the stacking order (`ord`), and each undo step is the
// items it added and removed. An arrow is a stroke of two points with `a` set: there is no
// arrow tool any more, but arrows drawn with it still load, draw and edit.
// Strokes are grouped into chunks (runs of one color and width, within one block of CHUNK
// places in the stacking order, so a change only regroups its own block) whose built paths
// are cached per zoom: panning only moves them, zooming rebuilds the ones on screen.
import { View, div, image, PathBuilder } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, appHome, checking, exec, nextCommand, run, shared, writeTextFile } from "herdr";
import * as fs from "fs/promises";
import { createHash } from "crypto";
import { REACH, stream, smooth, simplify, finish, straight, level, trace, circle, box, length, DOT, nearLine, nearSegment,
  lineInRect, overlap, pngSize, head, barbs, IMAGES, MARK, tenth, dump, dumpStroke, undump, viewOf, stale, miniFit, miniSize } from "./geometry.js";
import { prev, next, wordLeft, wordRight, lineStart, lineEnd, column, vertical, deleted } from "./text.js";

const COLORS = ["fg", "#6ea8fe", "#b392f0", "#7ee787", "#f2cc60", "#ff7b72"];
const WIDTHS = [2, 3.5, 6];
const TEXT = [16, 24, 36];  // text sizes for the three thickness buttons
const LEAD = 1.3;           // text line height, as a multiple of its size
const CHUNK = 16;           // places in the stacking order per cached path: a chunk is rebuilt
                            // whole, so a tile (several chunks) stays quick to build
const CHUNK_PTS = 800;      // stroke points per chunk, at most, for the same reason
const GRID = 24;            // world px between background dots at zoom 1
const HOLD = 200;           // ms still at a stroke's end before it snaps straight
const ZOOM = [0.1, 8];
const SAVE_MS = 600;
const SEL_PAD = 6;          // px between the selection and its outline
const DRAG = 3;             // px the pointer moves before a press becomes a drag
const ERASER = 8;           // px around the pointer the eraser reaches
const TOOLS = { s: "pointer", a: "pen", e: "eraser", t: "text" };
const NUDGE = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] };
const HISTORY = 1e6;        // stroke points undo may hold that the drawing no longer does
const ZOOM_STEP = 0.25;   // while zooming, tiles are built at zooms this far apart (in doublings)
const SETTLE_MS = 120;    // how long after the last zoom step tiles are built at exactly the zoom
const TILES = 64;         // tile views per canvas (see Tile)
const TILE_ORD = 64;      // places in the stacking order per tile, at least (doubles as the drawing grows)
const PAINT_BUILD_MS = 15; // the main view's budget per frame for building chunks it has no build for
const MORE_MS = 16;       // how soon the main view draws again when that budget left chunks out
const REFRESH_MS = 500;   // after the view stops moving, on-screen tiles are drawn once more (see `refreshLater`)
const TILE_BUILD_MS = 12; // a tile's budget per frame for building chunks at its zoom (Herdr stops a render at 50 ms)
const TILE_GAP_MS = 8;    // between one tile's rebuild and the next, so each gets a frame of its own
const RETIRE_MS = 1500;   // how long a reload waits for the old build to save and let go
const HOOK = 6;           // screen px from the touchdown within which a stroke keeps no points, so the
                          // flick as the pen lands doesn't show (perfect-freehand does the same)
const SAMPLE_MS = 16;     // a stroke keeps a point at most this often: fast strokes get sparse points,
                          // which `trace` rounds into smooth curves; slow ones stay exact
const LIVE = 64;            // points of the stroke being drawn traced again on each move, at most
const MINI = [200, 140];    // px: the minimap's largest size; it takes the shape of what it shows
const MINI_MIN = [110, 80]; // px: its smallest
const MINI_PAD = 10;        // px inside the minimap's edge that the drawing and view stay within
const MINI_GAP = 12;        // px between the minimap and the pane's top-right corner

// ---- The drawing, shared by every copy -------------------------------------------------

/** A line, or an arrow (`a` 1) from p[0..1] to its tip at p[2..3]; `box` holds its points and head.
 *  @typedef {{ k: "s", id: number, ord: number, c: string, w: number, p: number[], a: 0 | 1, box: number[] }} Stroke */
/** A text box: top-left (x, y) and size s in world units; w and h as last drawn (not saved).
 *  @typedef {{ k: "t", id: number, ord: number, x: number, y: number, s: number, c: string, v: string, w: number, h: number }} Text */
/** An image: `src` relative to the app folder, placed at (x, y) and w by h in world units.
 *  @typedef {{ k: "i", id: number, ord: number, x: number, y: number, w: number, h: number, src: string }} Img */
/** @typedef {Stroke | Text | Img} Item */
/** `n`: its strokes' points. @typedef {{ key: string, c: string, w: number, strokes: Stroke[], box: number[], n: number }} Chunk */
/** `held`: the stroke points in `del`, which only undo keeps. @typedef {{ add: Item[], del: Item[], held?: number }} Step */

const store = {
  /** @type {Promise<void> | null} */ loading: null,
  /** @type {Stroke[]} */ strokes: [],
  /** @type {Chunk[]} */ chunks: [],
  /** @type {Text[]} */ texts: [],
  /** @type {Img[]} */ images: [],
  view: { x: 0, y: 0, z: 1 },
  color: 0,
  width: 1,
  /** @type {Step[]} */ undo: [],
  /** @type {Step[]} */ redo: [],
  /** @type {string | null} */ saved: null,   // the file's text as last read or written
  /** @type {string | null} */ blocked: null, // why saving would risk the drawing on disk, if it would
  dirty: false,
  viewDirty: false,                           // the view, color or size changed since saved
  /** @type {any} */ saveTask: null,
  saving: Promise.resolve(),
  seq: 0,
  version: 0,                                 // counts changes, so a copy can skip one it drew
  retired: false,                             // a newer build of this mod has taken over
  zoomedAt: 0,                                // when the zoom last changed (see `built`)
  loaded: false,                              // `load` has read the file (or found none)
  /** @type {() => void} */ wakeAll: () => {},
  /** @type {Promise<void>} */ wake: Promise.resolve(),
};
store.wake = new Promise((r) => { store.wakeAll = r; });

const file = () => `${appHome()}/data/canvas/drawing.json`;
const viewFile = () => `${appHome()}/data/canvas/view.json`;

/** Built chunk paths by chunk key, shared by copies. @type {Map<string, any>} */
const paths = new Map();

/** Each stroke's chunk's last build, by stroke id (see `built`). @type {Map<number, any>} */
const owner = new Map();

const PIECE = 150;  // native builder calls per path, at most (see Pieces)

/** Paths built a piece at a time. The native builder copies the whole path on every call, so
 *  one path's cost grows with the square of its length: measured in the app, 200 calls take
 *  1.2 ms, 400 take 5.9 ms and 800 overrun the 50 ms Herdr gives a render, which then shows
 *  "interrupted". A chunk drawn as one path hit that limit when zooming rebuilt it. */
class Pieces {
  /** @param {number} w the stroke width @param {number} [W] @param {number} [H] the painted
   *  size: given, coordinates are kept as percentages of it (see Pct) */
  constructor(w, W, H) {
    this.w = w;
    this.W = W;
    this.H = H;
    /** @type {any[]} */ this.out = [];
    this.b = null;
    this.n = 0;
  }

  get() {
    return (this.b ??= this.W ? new Pct(PathBuilder.stroke(this.w), this.W, this.H) : PathBuilder.stroke(this.w));
  }

  /** Takes back the builder after `calls` more calls, starting a new path past PIECE. */
  put(b, calls) {
    this.b = b;
    this.n += calls;
    if (this.n >= PIECE) this.flush();
  }

  flush() {
    if (this.b) this.out.push(this.b.build());
    this.b = null;
    this.n = 0;
  }

  done() {
    this.flush();
    return this.out;
  }
}

/** A path builder taking pixels that keeps them as percentages of the painted size (W by H),
 *  so a built path stretches with the element it's painted in. A chunk built at one zoom then
 *  still lands right at another, its lines only as thick as when built, while `built` catches
 *  up: rebuilding every chunk on each step of a fast zoom overran Herdr's render limit. */
class Pct {
  /** @param {any} b @param {number} W @param {number} H */
  constructor(b, W, H) {
    this.b = b;
    this.sx = 100 / W;
    this.sy = 100 / H;
  }

  x(v) { return `${v * this.sx}%`; }
  y(v) { return `${v * this.sy}%`; }
  move_to(x, y) { this.b = this.b.move_to(this.x(x), this.y(y)); return this; }
  line_to(x, y) { this.b = this.b.line_to(this.x(x), this.y(y)); return this; }
  curve_to(x, y, cx, cy) { this.b = this.b.curve_to(this.x(x), this.y(y), this.x(cx), this.y(cy)); return this; }
  arc_to(rx, ry, rot, large, sweep, x, y) {
    this.b = this.b.arc_to(this.x(rx), this.y(ry), rot, large, sweep, this.x(x), this.y(y));
    return this;
  }
  close() { this.b = this.b.close(); return this; }
  build() { return this.b.build(); }
}

/** Traces p into `lines` as `trace` does, splitting a long stroke into pieces of PIECE points
 *  that join where one stops, as the live stroke's pieces do. @param {Pieces} lines */
function tracePieces(lines, p, ox, oy, z, dot = (_x, _y) => {}, hw = 0) {
  const n = p.length / 2;
  if (lines.n + n <= PIECE) return lines.put(trace(lines.get(), p, ox, oy, z, dot, null, hw), n);
  lines.flush();
  const part = { i: 1, ex: p[0], ey: p[1], stop: 0 };
  while (n - 1 - part.i > PIECE) {
    part.stop = part.i + PIECE;
    lines.put(trace(lines.get(), p, ox, oy, z, dot, part, hw), PIECE);
  }
  lines.put(trace(lines.get(), p, ox, oy, z, dot, { i: part.i, ex: part.ex, ey: part.ey }, hw), n - part.i);
}
/** Strokes' saved JSON, made once: strokes never change. @type {WeakMap<Stroke, string>} */
const json = new WeakMap();
/** Strokes thinned for a zoom below 1: { z, p } per stroke. @type {WeakMap<Stroke, any>} */
const thin = new WeakMap();
/** Image files written or reused since the drawing loaded, which `tidy` leaves alone. */
const kept = new Set();
let sized = 0;  // counts text boxes measured to a new size

/** Redraws every copy (each waits on `store.wake`). */
function changed() {
  store.version++;
  const wakeAll = store.wakeAll;
  store.wake = new Promise((r) => { store.wakeAll = r; });
  wakeAll();
}

/** A stroke's box: its points, and an arrow's head. */
const strokeBox = (p, w, a) => box(a ? [...p, ...head(p, w)] : p);

/** The polylines a stroke draws: its line, and an arrow's head. @param {Stroke} s */
const lines = (s) => (s.a ? [s.p, head(s.p, s.w)] : [s.p]);

/** @param {string} c @param {number} w @param {number[]} p @param {number} [a] @returns {Stroke} */
const stroke = (c, w, p, a = 0) => ({ k: "s", id: ++store.seq, ord: store.seq, c, w, p, a: a ? 1 : 0, box: strokeBox(p, w, a) });

const grow = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];

/** Adds a stroke to the end of a chunk list. A chunk's key is its strokes' ids: same strokes,
 *  same key, so built paths are reused. @param {Chunk[]} chunks @param {Stroke} s */
function chunkIn(chunks, s) {
  const last = chunks.at(-1);
  const n = s.p.length / 2;
  if (last && last.c === s.c && last.w === s.w && Math.floor(last.strokes[0].ord / CHUNK) === Math.floor(s.ord / CHUNK)
    && last.n + n <= CHUNK_PTS) {
    last.strokes.push(s);
    last.n += n;
    last.box = grow(last.box, s.box);
    last.key += `,${s.id}`;
  } else {
    chunks.push({ key: `${s.id}`, c: s.c, w: s.w, strokes: [s], box: s.box.slice(), n });
  }
}

/** @param {Stroke[]} strokes */
function chunked(strokes) {
  /** @type {Chunk[]} */ const out = [];
  for (const s of strokes) chunkIn(out, s);
  return out;
}

/** Items of one kind, with `add` put in and `del` taken out, in stacking order. */
function merged(arr, add, del) {
  if (!add.length && !del.length) return arr;
  const gone = new Set(del);
  const out = arr.filter((i) => !gone.has(i));
  out.push(...add);
  if (add.length) out.sort((a, b) => a.ord - b.ord);
  return out;
}

/** Changes the drawing: puts `add` in and takes `del` out. @param {Item[]} add @param {Item[]} del */
function apply(add, del) {
  const as = add.filter((i) => i.k === "s"), ds = del.filter((i) => i.k === "s");
  const last = store.strokes.at(-1);
  if (!ds.length && as.length === 1 && (!last || as[0].ord > last.ord)) {
    store.strokes.push(/** @type {Stroke} */ (as[0]));
    chunkIn(store.chunks, /** @type {Stroke} */ (as[0]));
  } else if (as.length || ds.length) {
    store.strokes = merged(store.strokes, as, ds);
    store.chunks = chunked(store.strokes);
  }
  store.texts = merged(store.texts, add.filter((i) => i.k === "t"), del.filter((i) => i.k === "t"));
  store.images = merged(store.images, add.filter((i) => i.k === "i"), del.filter((i) => i.k === "i"));
}

/** A text box's size in world units: as last drawn, or a guess before it has been. @param {Text} t */
const textSize = (t) => t.w ? [t.w, t.h]
  : [Math.max(...t.v.split("\n").map((l) => l.length), 1) * t.s * 0.55, t.v.split("\n").length * t.s * LEAD];

/** An item's bounds in world units. @param {Item} i @returns {number[]} */
function bounds(i) {
  if (i.k === "s") return [i.box[0] - i.w / 2, i.box[1] - i.w / 2, i.box[2] + i.w / 2, i.box[3] + i.w / 2];
  if (i.k === "t") { const [w, h] = textSize(i); return [i.x, i.y, i.x + w, i.y + h]; }
  return [i.x, i.y, i.x + i.w, i.y + i.h];
}

/** A copy of an item with a new id and the same place in the stacking order.
 *  @template {Item} T @param {T} i @param {Partial<T>} change @returns {T} */
const remade = (i, change) => ({ ...i, ...change, id: ++store.seq });

/** @param {Item} i @param {number} dx @param {number} dy */
function moved(i, dx, dy) {
  if (i.k !== "s") return remade(i, { x: i.x + dx, y: i.y + dy });
  const p = i.p.map((v, j) => v + (j % 2 ? dy : dx));
  return remade(i, { p, box: strokeBox(p, i.w, i.a) });
}

/** A moved copy placed on top of everything, for a duplicate. @param {Item} i @param {number} d */
const copied = (i, d) => { const c = moved(i, d, d); c.ord = c.id; return c; };

/** What scaling an item by k about (ax, ay) changes, its line widths and text sizes too.
 *  @param {Item} i @param {number} ax @param {number} ay @param {number} k @returns {any} */
function scaling(i, ax, ay, k) {
  const at = (v, a) => a + (v - a) * k;
  if (i.k === "s") {
    const p = i.p.map((v, j) => at(v, j % 2 ? ay : ax)), w = Math.max(0.5, Math.round(i.w * k * 10) / 10);
    return { p, w, box: strokeBox(p, w, i.a) };
  }
  if (i.k === "t") return { x: at(i.x, ax), y: at(i.y, ay), s: Math.max(2, i.s * k), w: i.w * k, h: i.h * k };
  return { x: at(i.x, ax), y: at(i.y, ay), w: i.w * k, h: i.h * k };
}

/** A copy of an item scaled by k about (ax, ay). @param {Item} i @param {number} ax @param {number} ay @param {number} k */
const scaled = (i, ax, ay, k) => remade(i, scaling(i, ax, ay, k));

const everything = () => [...store.images, ...store.strokes, ...store.texts];

/** New items, with fresh ids and on top of the stacking order, for what `undump` read.
 *  @param {ReturnType<typeof undump>} got */
function made(got) {
  return {
    /** @type {Stroke[]} */ strokes: got.strokes.map((s) => stroke(s.c, s.w, s.p, s.a)),
    /** @type {Text[]} */ texts: got.texts.map((t) => ({ k: "t", id: ++store.seq, ord: store.seq, ...t, w: 0, h: 0 })),
    /** @type {Img[]} */ images: got.images.map((m) => ({ k: "i", id: ++store.seq, ord: store.seq, ...m })),
  };
}

/** Deletes the images the drawing (`text`, as just read) doesn't use, and temp files a paste
 *  or drop left over a minute ago. Undo history starts over on a load; canvas items still on
 *  the clipboard may name a deleted image, and pasting them leaves it out. Images named in a
 *  drawing.json.bad-* copy are kept for whoever mends it, and ones pasted since the load too. */
async function tidy(text) {
  const used = new Set(text.match(/[0-9a-f]{24}\.png/g)), dir = `${appHome()}/data/canvas`;
  for (const n of await fs.readdir(dir).catch(() => [])) {
    if (!n.startsWith("drawing.json.bad")) continue;
    const bad = await fs.readFile(`${dir}/${n}`, "utf8").catch(() => null);
    if (bad === null) return;  // can't tell what it names
    for (const m of bad.match(/[0-9a-f]{24}\.png/g) ?? []) used.add(m);
  }
  const images = `${appHome()}/${IMAGES}`;
  for (const n of await fs.readdir(images).catch(() => [])) {
    if (stale(n, used, Date.now()) && !kept.has(n)) await fs.unlink(`${images}/${n}`).catch(() => {});
  }
}

/** Stops saving: writing now could lose the drawing on disk. */
function block(why) {
  store.blocked = why;
  console.log(`canvas: ${why}; not saving, so the file stays as it is`);
}

/** Hands over to a newer build of this mod (see `load`): saves what's pending, then empties
 *  this build's store and wakes its copies, whose loops end there. */
async function retire() {
  if (store.dirty || store.viewDirty) await save();
  else await store.saving;
  store.retired = true;
  store.blocked = "a newer build has taken over";
  Object.assign(store, { strokes: [], chunks: [], texts: [], images: [], undo: [], redo: [], saved: null });
  paths.clear();
  owner.clear();
  changed();
}

/** @param {any} cx an async context, to time out the handover */
function load(cx) {
  return store.loading ??= (async () => {
    // A reload leaves the old build's store behind, with its save timer stopped: it saves and
    // lets go before this one reads the file. Only briefly: a replaced build's pending calls
    // are cancelled, so its save can hang for good, and waiting on it left this build never
    // reading the file, so never saving either (it won't replace a file it hasn't read).
    // Not during `herdr-app check`: it must never empty the live canvas.
    if (!checking()) {
      const old = globalThis.canvasRetire?.();
      if (old) await Promise.race([old, cx.sleep(RETIRE_MS)]);
      globalThis.canvasRetire = retire;
    }
    const text = await fs.readFile(file(), "utf8").catch(async (e) => {
      if (await fs.exists(file()).catch(() => true)) block(`can't read ${file()} (${e})`);
      return null;
    });
    let d = null;
    if (text !== null) {
      try {
        d = JSON.parse(text);
        const { strokes, texts, images } = made(undump(d, TEXT[1]));
        apply([...strokes, ...texts, ...images], []);
        // Undo history isn't saved: each saved item becomes a step, so Cmd-Z after a reload
        // still walks back to an empty canvas.
        store.undo = [...images, ...strokes, ...texts].map((i) => ({ add: [i], del: [] }));
        store.saved = text;
        if (!checking()) tidy(text).catch(() => {});
      } catch (e) {
        d = null;
        // Unreadable: keep it aside rather than overwrite it with an empty drawing.
        const bad = `${file()}.bad-${Date.now()}`;
        try {
          await fs.writeFile(bad, text);
          store.saved = text;
          console.log(`canvas: ${file()} is not valid (${e}); kept as ${bad}`);
        } catch (e2) {
          block(`${file()} is not valid (${e}), and keeping a copy failed (${e2})`);
        }
      }
    }
    // The view, color and size: view.json, or the drawing's own from before view.json.
    let v = await fs.readFile(viewFile(), "utf8").catch(() => null);
    try { v = v && JSON.parse(v); } catch { v = null; }
    v ||= d;
    if (v) {
      store.view = viewOf(v.view, ZOOM);
      store.color = Math.max(0, COLORS.indexOf(v.color));
      store.width = Math.max(0, WIDTHS.indexOf(v.width));
    }
    store.loaded = true;
    if (store.dirty || store.viewDirty) save();  // what was drawn while it read
    changed();
  })();
}

/** A stroke's saved JSON. @param {Stroke} s */
function strokeJson(s) {
  let j = json.get(s);
  if (j === undefined) json.set(s, j = JSON.stringify(dumpStroke(s)));
  return j;
}

/** Writes `text` only if the file still holds `expected` (null: no file yet). writeTextFile does
 *  this but refuses files over 1 MiB (tried in the app), so above that: the same check by hand,
 *  then a write beside the file and a rename, so a crash mid-write can't leave half a drawing.
 *  @param {string} path @param {string} text @param {string | null} expected */
async function replaceFile(path, text, expected) {
  try {
    return await writeTextFile(path, text, expected);
  } catch (e) {
    if (!/exceeds 1 MiB/.test(String(e))) throw e;
  }
  const now = await fs.readFile(path, "utf8").catch(() => null);
  if (now !== expected) throw new Error(`${path} changed outside this window`);
  const tmp = `${path}.saving`;
  await fs.writeFile(tmp, text);
  const r = await exec("mv", ["-f", tmp, path]);
  if (r.code !== 0) throw new Error(`moving ${tmp} into place failed: ${r.stderr.trim()}`);
}

function save() {
  store.saving = store.saving.then(async () => {
    if (!store.loaded) return;  // `load` saves once it has read the file
    await fs.mkdir(`${appHome()}/data/canvas`, { recursive: true }).catch(() => {});
    if (store.viewDirty) {
      store.viewDirty = false;
      const v = store.view;
      const text = JSON.stringify({ view: { x: tenth(v.x), y: tenth(v.y), z: Math.round(v.z * 1e4) / 1e4 },
        color: COLORS[store.color], width: WIDTHS[store.width] });
      await fs.writeFile(viewFile(), text).catch((e) => { store.viewDirty = true; console.log(`canvas: saving the view failed: ${e}`); });
    }
    if (!store.dirty || store.blocked) return;
    store.dirty = false;
    const { texts, images } = dump([...store.texts, ...store.images]);
    const text = `{"version":2,"strokes":[${store.strokes.map(strokeJson).join(",")}],`
      + `"texts":${JSON.stringify(texts)},"images":${JSON.stringify(images)}}`;
    if (text === store.saved) return;
    try {
      try {
        await replaceFile(file(), text, store.saved);
      } catch (e) {
        // Written since we last read or wrote it, by another window: ours is newer. Unless we
        // never read it (there was none): then it isn't ours to replace.
        if (store.saved === null) { block(`${file()} was made by something else (${e})`); throw e; }
        await replaceFile(file(), text, await fs.readFile(file(), "utf8").catch(() => null));
      }
      store.saved = text;
    } catch (e) {
      store.dirty = true;
      console.log(`canvas: saving failed: ${e}`);
    }
  });
  return store.saving;
}

/** Saves a moment after the last change: to the drawing, or with `view`, to view.json only.
 *  @param {any} cx @param {boolean} [view] */
function later(cx, view = false) {
  if (view) store.viewDirty = true;
  else store.dirty = true;
  store.saveTask?.cancel();
  store.saveTask = cx.timer.after(SAVE_MS, () => { save(); });
}

/** The command alt-shift-left/right run when the canvas has nothing to do with them: Herdr's
 *  `tab.prev`/`tab.next`, unless another mod names its own in the shared value
 *  `canvas.tab-commands` (`{ prev, next }`). @param {"prev" | "next"} dir */
function tabCommand(dir) {
  const own = /** @type {any} */ (shared("canvas.tab-commands"))?.[dir];
  return typeof own === "string" ? own : `tab.${dir}`;
}

/** Records a change already applied as one undo step. @param {Step} step @param {any} cx */
function commit(step, cx) {
  if (!step.add.length && !step.del.length) return;
  step.held = step.del.reduce((n, i) => n + (i.k === "s" ? i.p.length / 2 : 0), 0);
  store.undo.push(step);
  // The oldest steps go once undo holds too much the drawing doesn't.
  let held = store.undo.reduce((n, u) => n + (u.held ?? 0), 0);
  while (held > HISTORY && store.undo.length > 1) held -= /** @type {Step} */ (store.undo.shift()).held ?? 0;
  store.redo = [];
  later(cx);
  changed();
  // Redraw this copy now: the wake loop in `init` (for the other copies) can run late, which
  // left an erase or a Delete unshown until the next click.
  cx.notify();
}

/** Applies a change and records it. @param {Item[]} add @param {Item[]} del @param {any} cx */
function change(add, del, cx) {
  apply(add, del);
  commit({ add, del }, cx);
}

// ---- Images ----------------------------------------------------------------------------

/** Keeps PNG bytes in the images folder under their hash. Returns the item's size and src. */
async function keep(bytes) {
  const size = pngSize(bytes);
  if (!size) return null;
  const name = `${createHash("sha256").update(bytes).digest("hex").slice(0, 24)}.png`, src = `${IMAGES}/${name}`;
  kept.add(name);
  await fs.mkdir(`${appHome()}/${IMAGES}`, { recursive: true }).catch(() => {});
  if (!(await fs.exists(`${appHome()}/${src}`))) await fs.writeFile(`${appHome()}/${src}`, bytes);
  return { src, w: size.w * size.scale, h: size.h * size.scale };
}

/** The clipboard's image as PNG, through macOS's osascript; null when it holds none. */
async function clipboardImage() {
  const tmp = `${appHome()}/${IMAGES}/paste-${Date.now()}.tmp`;
  await fs.mkdir(`${appHome()}/${IMAGES}`, { recursive: true }).catch(() => {});
  const r = await exec("osascript", [
    "-e", `set f to (open for access (POSIX file ${JSON.stringify(tmp)}) with write permission)`,
    "-e", "set eof f to 0",
    "-e", "try",
    "-e", "write (the clipboard as «class PNGf») to f",
    "-e", "on error e",
    "-e", "close access f",
    "-e", "error e",
    "-e", "end try",
    "-e", "close access f",
  ], { timeout: 10000 }).catch(() => null);
  const bytes = r?.code === 0 ? await fs.readFile(tmp).catch(() => null) : null;
  await fs.unlink(tmp).catch(() => {});
  return bytes && bytes.length ? keep(bytes) : null;
}

/** A dropped file as PNG: PNGs as they are, other images converted with macOS's sips. */
async function droppedImage(path) {
  if (!/\.(png|jpe?g|gif|heic|tiff?|webp|bmp)$/i.test(path)) return null;
  // fs reads only under home; sips can read the rest.
  if (/\.png$/i.test(path)) { const bytes = await fs.readFile(path).catch(() => null); if (bytes) return keep(bytes); }
  const tmp = `${appHome()}/${IMAGES}/drop-${Date.now()}.png`;
  await fs.mkdir(`${appHome()}/${IMAGES}`, { recursive: true }).catch(() => {});
  const r = await exec("sips", ["-s", "format", "png", path, "--out", tmp], { timeout: 30000 }).catch(() => null);
  const bytes = r?.code === 0 ? await fs.readFile(tmp).catch(() => null) : null;
  await fs.unlink(tmp).catch(() => {});
  return bytes ? keep(bytes) : null;
}

// ---- One copy ------------------------------------------------------------------------

const hexA = (c, a) => (/^#[0-9a-f]{6}$/i.test(c) ? c + a : c);

/** `c` 30% of the way from `bg`, as an opaque color (or see-through, for other color forms). */
function faded(c, bg) {
  const hex = /^#[0-9a-f]{6}$/i;
  if (!hex.test(c) || !hex.test(bg)) return hexA(c, "4d");
  const at = (s, i) => parseInt(s.slice(i, i + 2), 16);
  return `#${[1, 3, 5].map((i) => Math.round(at(bg, i) + (at(c, i) - at(bg, i)) * 0.3).toString(16).padStart(2, "0")).join("")}`;
}

/** The minimap's paths per chunk and scale, shared by copies (each may show its own scale):
 *  like `paths`, a change rebuilds only its own chunk. @type {Map<string, any>} */
const miniPaths = new Map();

/** A chunk's strokes at minimap scale `s`, traced as the canvas traces them (never thinner
 *  than a px), arrowheads too. Paths start at (ox, oy) in world units. @param {Chunk} ch */
function miniChunk(ch, s) {
  const key = `${ch.key}|${s}`;
  let e = miniPaths.get(key);
  if (e) return e;
  const w = Math.max(1.2, ch.w * s), r = w / (2 + DOT), m = ch.w + 2 / s, ox = ch.box[0] - m, oy = ch.box[1] - m;
  const line = new Pieces(w), cap = new Pieces(r * DOT);
  for (const st of ch.strokes) {
    for (const l of lines(st)) {
      const p = simplify(l, 0.5 / s), n = p.length;
      if (length(p) * s >= 1) tracePieces(line, p, ox, oy, s);
      cap.put(circle(cap.get(), (p[0] - ox) * s, (p[1] - oy) * s, r), 4);
      if (n >= 4) cap.put(circle(cap.get(), (p[n - 2] - ox) * s, (p[n - 1] - oy) * s, r), 4);
    }
  }
  e = { ox, oy, w: (ch.box[2] - ch.box[0] + 2 * m) * s, h: (ch.box[3] - ch.box[1] + 2 * m) * s,
    lines: line.done(), caps: cap.done() };
  miniPaths.set(key, e);
  return e;
}

/** Texts and images at minimap scale `s` as blocks (images) and bars (texts, a little shorter
 *  than their box, so they read as lines of writing). Null when there are none.
 *  @param {Item[]} items texts and images */
function miniBlocks(items, s) {
  if (!items.length) return null;
  const all = items.map(bounds), b = all.reduce(grow);
  let blocks = null, notes = null;
  items.forEach((i, n) => {
    const q = all[n], inset = i.k === "t" ? Math.min(i.s * s * 0.25, 2) : 0;
    const l = (q[0] - b[0]) * s, t = (q[1] - b[1]) * s + inset;
    const w = Math.max(1, (q[2] - q[0]) * s), h = Math.max(1, (q[3] - q[1]) * s - 2 * inset);
    const rect = [[l, t], [l + w, t], [l + w, t + h], [l, t + h]];
    if (i.k === "t") notes = (notes ?? PathBuilder.fill()).add_polygon(rect, true);
    else blocks = (blocks ?? PathBuilder.fill()).add_polygon(rect, true);
  });
  return { ox: b[0], oy: b[1], w: (b[2] - b[0]) * s + 1, h: (b[3] - b[1]) * s + 1,
    blocks: blocks?.build() ?? null, notes: notes?.build() ?? null };
}

/** The drawing's texts and images as `miniBlocks`, per scale, shared by copies; a few kept. */
const miniRects = new Map();
function drawingBlocks(s) {
  const key = `${store.version}|${sized}|${s}`;
  if (!miniRects.has(key)) {
    if (miniRects.size >= 4) miniRects.clear();
    miniRects.set(key, miniBlocks([...store.images, ...store.texts], s));
  }
  return miniRects.get(key);
}

/** The drawing's bounds; null while it's empty. Strokes and images are measured again only when
 *  the drawing changes, texts also when they're measured anew (as each zoom step may). */
let miniBox = null;
function drawingBounds() {
  if (miniBox?.version !== store.version) {
    let b = null;
    for (const list of [store.strokes, store.images]) for (const i of list) b = b ? grow(b, bounds(i)) : bounds(i);
    miniBox = { version: store.version, fixed: b, sized: -1, b };
  }
  if (miniBox.sized !== sized) {
    let b = miniBox.fixed;
    for (const i of store.texts) b = b ? grow(b, bounds(i)) : bounds(i);
    Object.assign(miniBox, { sized, b });
  }
  return miniBox.b;
}

/** Toolbar icons, 16 px square, built on first use. */
let icons = null;
const iconPaths = () => icons ??= {
  pointer: PathBuilder.fill().add_polygon([[4, 2], [4, 14], [7, 11], [9.2, 15.2], [11, 14.4], [8.8, 10.2], [13, 10.2]], true).build(),
  pen: PathBuilder.stroke(2).move_to(3.5, 12.5).line_to(12, 4).build(),
  tip: PathBuilder.fill().add_polygon([[2.4, 13.6], [3, 11.4], [4.6, 13]], true).build(),
  eraser: PathBuilder.stroke(1.5).add_polygon([[2.5, 10], [9, 3.5], [13.5, 8], [7, 14.5]], true)
    .move_to(5.3, 7.2).line_to(9.8, 11.7).build(),
  rubber: PathBuilder.fill().add_polygon([[2.5, 10], [5.3, 7.2], [9.8, 11.7], [7, 14.5]], true).build(),
};


export default class Canvas extends View {
  init(_props, cx) {
    this.uid = `canvas-${Math.random().toString(36).slice(2, 8)}`;
    this.focus = cx.focus_handle();
    this.size = { width: 0, height: 0 };
    this.origin = { x: 0, y: 0 };      // the pane's top-left corner in window coordinates
    this.pointer = null;               // the pointer in pane px, while over the pane
    /** @type {"pointer" | "pen" | "eraser" | "text"} */ this.tool = "pointer";
    /** @type {null | "draw" | "erase" | "pan" | "press" | "move" | "scale" | "range" | "mini"} */ this.mode = null;
    this.spaceHeld = false;  // space is down: a drag pans (see `key`)
    /** The text being typed into: the caret and the selection's other end are indexes into
     *  its string, and `col` is the column ↑ and ↓ keep to.
     *  @type {null | { t: Text, orig: Text | null, back: "pointer" | "pen" | "eraser" | "text",
     *    caret: number, anchor: number, col: number | null }} */
    this.edit = null;
    /** @type {Set<Item>} */ this.sel = new Set();
    /** @type {any} */ this.press = null; // where a pointer-tool press started, and what it hit
    /** @type {any} */ this.drag = null;  // the items being moved and how far
    /** @type {boolean | "grab" | "nwse" | "nesw"} */
    this.over = false;                 // what the pointer tool can drag under the pointer
    this.last = { x: 0, y: 0 };        // the pointer at the last pan step (pane px)
    /** @type {any} */ this.cur = null;  // the stroke being drawn
    /** @type {null | { hit: Set<Item>, chunks: Chunk[], last: number[] }} */
    this.erase = null;                 // what an eraser drag has taken out so far
    /** @type {Step | null} */ this.nudged = null;  // the undo step arrow-key nudges add to
    /** @type {any} */ this.holdTask = null;
    /** @type {any} */ this.dots = null;
    /** @type {any} */ this.selBox = null; // the selection's bounds, while it and the drawing stay as they are
    this.drawn = -1;                      // the store.version this copy last drew
    /** @type {any} */ this.mini = null;   // where the minimap is in the pane, and its scale, as last drawn
    /** @type {any} */ this.miniHeld = null; // the minimap's scale, held still while it's dragged
    /** @type {any} */ this.miniKept = null; // the minimap's fit, kept while the view stays inside it
    this.ring = cx.new(Ring, { id: `${this.uid}-eraser`, x: 0, y: 0 });
    canvases.set(this.uid, this);
    this.ink = cx.new(Ink, { uid: this.uid });
    /** The strokes, drawn by tile views: see `drawTiles`. */
    this.tiles = Array.from({ length: TILES }, (_, t) => cx.new(Tile, { uid: this.uid, t }));
    /** @type {any[]} */ this.tileAs = new Array(TILES).fill(null);  // what each tile last drew
    /** @type {number[]} */ this.want = [];                          // tiles to rebuild, in order
    this.wantSet = new Set();
    /** @type {any} */ this.wakeTiles = null;
    /** @type {any} */ this.wakeSettle = null;
    /** @type {any} */ this.wakeMore = null;
    this.buildBy = Infinity;  // when this frame's chunk builds must stop (PAINT_BUILD_MS)
    this.more = false;        // chunks were left out of this frame for want of time
    if (checking()) return;
    // A frame that left chunks out for want of time (see `chunks` in render) draws again.
    cx.spawn(async (cx) => {
      for (;;) {
        await new Promise((r) => { this.wakeMore = r; });
        this.wakeMore = null;
        await cx.sleep(MORE_MS);
        cx.notify();
      }
    });
    // Tiles out of date (see `drawTiles`) are rebuilt here, one per frame, and then this view
    // draws again to show them in place of what it painted itself meanwhile.
    cx.spawn(async (cx) => {
      for (;;) {
        await new Promise((r) => { this.wakeTiles = r; });
        this.wakeTiles = null;
        while (this.want.length) {
          const t = this.want.shift();
          this.wantSet.delete(t);
          cx.notify(this.tiles[t]);
          await cx.sleep(TILE_GAP_MS);
        }
        cx.notify();
      }
    });
    // Once a zoom settles, draw again so tiles built at a zoom step get built at the zoom.
    cx.spawn(async (cx) => {
      for (;;) {
        await new Promise((r) => { this.wakeSettle = r; });
        this.wakeSettle = null;
        while (Date.now() - store.zoomedAt < SETTLE_MS) await cx.sleep(SETTLE_MS);
        cx.notify();
      }
    });
    cx.spawn(async (cx) => {
      await load(cx);
      cx.notify();
      for (;;) {
        await store.wake;
        if (store.retired) return;
        if (this.drawn !== store.version) cx.notify();
      }
    });
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "focus") this.focus.focus();
        else if (c.startsWith("key-")) this.globalKey(c.slice(4), cx);
      }
    });
  }

  async close(cx) {
    canvases.delete(this.uid);
    this.holdTask?.cancel();
    if (this.edit) this.finish(cx);
    if (this.drag) { apply(this.drag.items, []); store.dirty = true; }
    if (this.erase) { apply([...this.erase.hit], []); store.dirty = true; }
    if (store.dirty || store.viewDirty) await save();
  }

  // -- Pointer ------------------------------------------------------------------------

  /** The pointer in pane px, from any mouse event. */
  local(e) {
    if (e.local_position) {
      this.origin = { x: e.position.x - e.local_position.x, y: e.position.y - e.local_position.y };
      return e.local_position;
    }
    return { x: e.position.x - this.origin.x, y: e.position.y - this.origin.y };
  }

  world(pt) {
    const v = store.view;
    return [(pt.x - v.x) / v.z, (pt.y - v.y) / v.z];
  }

  /** The text box under a world point, topmost first. */
  textUnder(x, y) {
    const pad = 4 / store.view.z;
    for (let i = store.texts.length - 1; i >= 0; i--) {
      const t = store.texts[i], b = bounds(t);
      if (x >= b[0] - pad && x <= b[2] + pad && y >= b[1] - pad && y <= b[3] + pad) return t;
    }
    return null;
  }

  /** The selection's corner handles: where they are on screen, and the world corners a drag
   *  scales from (a, the opposite corner) and towards (c). */
  handles() {
    if (!this.sel.size) return [];
    const b = this.shown(this.selBounds()), v = store.view, z = v.z;
    const l = b[0] * z + v.x - SEL_PAD, r = b[2] * z + v.x + SEL_PAD, t = b[1] * z + v.y - SEL_PAD, d = b[3] * z + v.y + SEL_PAD;
    return [
      { n: "nw", sx: l, sy: t, a: [b[2], b[3]], c: [b[0], b[1]], cur: "nwse" },
      { n: "ne", sx: r, sy: t, a: [b[0], b[3]], c: [b[2], b[1]], cur: "nesw" },
      { n: "sw", sx: l, sy: d, a: [b[2], b[1]], c: [b[0], b[3]], cur: "nesw" },
      { n: "se", sx: r, sy: d, a: [b[0], b[1]], c: [b[2], b[3]], cur: "nwse" },
    ];
  }

  /** The corner handle under a screen point. */
  handleAt(pt) {
    return this.handles().find((h) => Math.hypot(pt.x - h.sx, pt.y - h.sy) <= 8) ?? null;
  }

  /** The selection's bounds in world units, worked out again only when it or the drawing changed. */
  selBounds() {
    const k = this.selBox, sel = this.sel;
    if (k?.sel === sel && k.size === sel.size && k.version === store.version && k.sized === sized) return k.b;
    const b = [...sel].map(bounds).reduce(grow);
    this.selBox = { sel, size: sel.size, version: store.version, sized, b };
    return b;
  }

  /** Where a world box shows while the selection is dragged: moved, or scaled from the handle's anchor. */
  shown(b) {
    const d = this.drag;
    if (!d) return b;
    if (this.mode !== "scale") return [b[0] + d.dx, b[1] + d.dy, b[2] + d.dx, b[3] + d.dy];
    const [ax, ay] = d.handle.a, k = d.shown;
    return [ax + (b[0] - ax) * k, ay + (b[1] - ay) * k, ax + (b[2] - ax) * k, ay + (b[3] - ay) * k];
  }

  /** Whether a world point is inside the selection's outline. */
  inSelection(x, y) {
    if (!this.sel.size) return false;
    const b = this.selBounds(), pad = SEL_PAD / store.view.z;
    return x >= b[0] - pad && x <= b[2] + pad && y >= b[1] - pad && y <= b[3] + pad;
  }

  /** The item under a world point, topmost first: text, then strokes, then images. */
  itemUnder(x, y) {
    const t = this.textUnder(x, y);
    if (t) return t;
    const pad = 5 / store.view.z;
    for (let i = store.strokes.length - 1; i >= 0; i--) {
      const s = store.strokes[i], b = s.box;
      if (x < b[0] - s.w - pad || x > b[2] + s.w + pad || y < b[1] - s.w - pad || y > b[3] + s.w + pad) continue;
      if (lines(s).some((l) => nearLine(l, x, y, s.w / 2 + pad))) return s;
    }
    for (let i = store.images.length - 1; i >= 0; i--) {
      const m = store.images[i];
      if (x >= m.x && x <= m.x + m.w && y >= m.y && y <= m.y + m.h) return m;
    }
    return null;
  }

  down(e, cx) {
    this.focus.focus();
    if (this.mode) this.up(cx);  // its mouse-up never came
    const pt = this.local(e);
    if (e.button === "middle" || (this.spaceHeld && e.button === "left")) {
      this.mode = "pan";
      this.last = pt;
      cx.notify();
      return;
    }
    const [x, y] = this.world(pt);
    if (this.edit) {
      const hit = this.textUnder(x, y);
      if (hit === this.edit.t) return;
      this.finish(cx);
      if (hit && this.tool === "text") this.startEdit(hit, x, y);
      cx.notify();
      return;
    }
    if (this.tool === "pointer") {
      const handle = !e.modifiers.shift && this.handleAt(pt);
      if (handle) {
        this.mode = "press";
        this.press = { pt, x, y, handle, x1: x, y1: y };
        cx.notify();
        return;
      }
      const hit = this.itemUnder(x, y);
      // Double-click: on text, edit it; on empty space, start a new text there.
      if (e.click_count >= 2 && (hit?.k === "t" || (!hit && !e.modifiers.shift))) {
        this.sel.clear();
        this.startEdit(hit ?? null, x, y);
        cx.notify();
        return;
      }
      if (hit && e.modifiers.shift) {
        this.sel.has(hit) ? this.sel.delete(hit) : this.sel.add(hit);
      } else if (hit && !this.sel.has(hit)) {
        this.sel = new Set([hit]);
      } else if (!hit && !e.modifiers.shift && !this.inSelection(x, y)) {
        this.sel.clear();
      }
      // A drag from a selected item, or from anywhere inside the selection's outline, moves it.
      const grab = hit ? this.sel.has(hit) : !e.modifiers.shift && this.inSelection(x, y);
      this.mode = "press";
      this.press = { pt, x, y, grab, shift: e.modifiers.shift, x1: x, y1: y };
    } else if (this.tool === "eraser") {
      this.mode = "erase";
      this.erase = { hit: new Set(), chunks: [], last: [x, y] };
      this.rub(x, y, x, y);
    } else if (this.tool === "text") {
      this.startEdit(this.textUnder(x, y), x, y);
      return;
    } else {
      this.mode = "draw";
      this.cur = { p: [x, y], tail: [x, y], z: store.view.z, still: pt, stillAt: Date.now(), at: Date.now(), snapped: false };
      this.holdTask = cx.timer.every(60, (cx) => this.hold(cx));
    }
    cx.notify();
  }

  move(e, cx) {
    const pt = this.local(e), entered = !this.pointer;
    this.pointer = pt;
    const [x, y] = this.world(pt);
    if (this.mode === "pan") {
      store.view.x += pt.x - this.last.x;
      store.view.y += pt.y - this.last.y;
      this.last = pt;
      cx.notify();
    } else if (this.mode === "mini") {
      this.miniGo(pt, cx);
    } else if (this.mode === "draw") {
      const c = this.cur;
      if (Math.hypot(pt.x - c.still.x, pt.y - c.still.y) > 2) { c.still = pt; c.stillAt = Date.now(); }
      if (c.snapped) {
        c.tail = level(c.p[0], c.p[1], x, y);
      } else {
        const [sx, sy] = stream(c.p[c.p.length - 2], c.p[c.p.length - 1], x, y);
        const now = Date.now();
        const landed = c.p.length > 2 || Math.hypot(x - c.p[0], y - c.p[1]) * c.z >= HOOK;
        if (landed && now - c.at >= SAMPLE_MS && Math.hypot(sx - c.p[c.p.length - 2], sy - c.p[c.p.length - 1]) * c.z >= 1) {
          c.p.push(sx, sy);
          c.at = now;
        }
        c.tail = [x, y];
      }
      cx.notify(this.ink);
    } else if (this.mode === "erase") {
      const [lx, ly] = this.erase.last;
      this.erase.last = [x, y];
      this.ringAt(pt);
      // Show what's rubbed out now, not when the wake loop gets round to it.
      if (this.rub(lx, ly, x, y)) cx.notify();
    } else if (this.mode === "press") {
      const p = this.press;
      if (Math.hypot(pt.x - p.pt.x, pt.y - p.pt.y) < DRAG) return;
      if (p.handle) {
        // Scaled copies are made on letting go; until then the originals draw scaled (`shown`).
        const items = [...this.sel];
        apply([], items);
        this.drag = { items, handle: p.handle, k: 1, shown: 1, chunks: chunked(/** @type {Stroke[]} */ (items.filter((i) => i.k === "s"))), dx: 0, dy: 0 };
        this.mode = "scale";
        changed();
      } else if (p.grab) {
        // Lift the selection out of the drawing while it moves; `up` puts moved copies back.
        const items = [...this.sel];
        apply([], items);
        this.drag = { items, chunks: chunked(/** @type {Stroke[]} */ (items.filter((i) => i.k === "s"))), dx: 0, dy: 0 };
        this.mode = "move";
        changed();
      } else {
        this.mode = "range";
      }
      this.move(e, cx);
    } else if (this.mode === "move") {
      this.drag.dx = x - this.press.x;
      this.drag.dy = y - this.press.y;
      cx.notify();
    } else if (this.mode === "scale") {
      // Scale by how far along the anchor-to-corner diagonal the pointer is.
      const d = this.drag, { a, c } = d.handle, ux = c[0] - a[0], uy = c[1] - a[1];
      d.k = Math.max(0.05, ((x - a[0]) * ux + (y - a[1]) * uy) / (ux * ux + uy * uy || 1));
      if (Math.abs(d.k / d.shown - 1) >= 0.01) { d.shown = d.k; cx.notify(); }
    } else if (this.mode === "range") {
      this.press.x1 = x;
      this.press.y1 = y;
      cx.notify();
    } else if (this.tool === "eraser") {
      this.ringAt(pt);  // the eraser's ring follows the pointer
      if (entered) cx.notify();
    } else if (!this.mode && !this.edit && this.tool === "pointer") {
      const over = this.handleAt(pt)?.cur ?? (this.itemUnder(x, y) || this.inSelection(x, y) ? "grab" : false);
      if (over !== this.over) { this.over = over; cx.notify(); }
    }
  }

  /** Moves the eraser's ring, redrawing only it. */
  ringAt(pt) {
    this.ring.set_props({ id: `${this.uid}-eraser`, x: pt.x, y: pt.y });
  }

  /** Takes out every stroke and text the eraser touches going from (x0, y0) to (x1, y1), to be
   *  shown dimmed until `up` removes them for good. Images are left alone. Returns whether it
   *  took any. */
  rub(x0, y0, x1, y1) {
    const r = ERASER / store.view.z;
    const reach = [Math.min(x0, x1) - r, Math.min(y0, y1) - r, Math.max(x0, x1) + r, Math.max(y0, y1) + r];
    const hit = [...store.strokes, ...store.texts].filter((i) => {
      const b = bounds(i);
      if (!overlap(b, reach)) return false;
      if (i.k === "t") return lineInRect([x0, y0, x1, y1], [b[0] - r, b[1] - r, b[2] + r, b[3] + r]);
      return lines(i).some((l) => nearSegment(l, x0, y0, x1, y1, i.w / 2 + r));
    });
    if (!hit.length) return false;
    apply([], hit);
    for (const i of hit) this.erase.hit.add(i);
    const strokes = /** @type {Stroke[]} */ ([...this.erase.hit].filter((i) => i.k === "s"));
    this.erase.chunks = chunked(strokes.sort((a, b) => a.ord - b.ord));
    changed();
    return true;
  }

  /** Snaps a held, roughly straight stroke to a straight line. */
  hold(cx) {
    const c = this.cur;
    if (this.mode !== "draw" || c.snapped || Date.now() - c.stillAt < HOLD) return;
    const p = [...c.p, ...c.tail];
    if (!straight(p, c.z)) return;
    c.snapped = true;
    c.p = [p[0], p[1]];
    c.tail = level(p[0], p[1], c.tail[0], c.tail[1]);
    cx.notify();
  }

  up(cx) {
    if (this.mode === "draw") {
      const c = this.cur;
      this.holdTask?.cancel();
      const p = c.snapped ? [...c.p, ...c.tail] : finish([...c.p, ...c.tail], c.z);
      this.cur = null;
      change([stroke(COLORS[store.color], WIDTHS[store.width], p)], [], cx);
    } else if (this.mode === "erase") {
      const del = [...this.erase.hit];
      this.erase = null;
      commit({ add: [], del }, cx);
    } else if (this.mode === "pan" || this.mode === "mini") {
      this.miniHeld = null;
      later(cx, true);
      this.refreshLater(cx);
    } else if (this.mode === "move") {
      const { items, dx, dy } = this.drag;
      this.drag = null;
      if (dx || dy) {
        const copies = items.map((i) => moved(i, dx, dy));
        apply(copies, []);
        commit({ add: copies, del: items }, cx);
        this.sel = new Set(copies);
      } else {
        apply(items, []);
        changed();
      }
    } else if (this.mode === "scale") {
      const { items, k, handle: { a } } = this.drag;
      this.drag = null;
      if (k !== 1) {
        const copies = items.map((i) => scaled(i, a[0], a[1], k));
        apply(copies, []);
        commit({ add: copies, del: items }, cx);
        this.sel = new Set(copies);
      } else {
        apply(items, []);
        this.sel = new Set(items);
        changed();
      }
    } else if (this.mode === "range") {
      const p = this.press;
      const r = [Math.min(p.x, p.x1), Math.min(p.y, p.y1), Math.max(p.x, p.x1), Math.max(p.y, p.y1)];
      if (!p.shift) this.sel = new Set();
      for (const i of everything()) {
        if (!overlap(bounds(i), r)) continue;
        if (i.k !== "s") { this.sel.add(i); continue; }
        const out = [r[0] - i.w / 2, r[1] - i.w / 2, r[2] + i.w / 2, r[3] + i.w / 2];
        if (lines(i).some((l) => lineInRect(l, out))) this.sel.add(i);
      }
    }
    this.mode = null;
    this.press = null;
    cx.notify();
  }

  // -- Text ---------------------------------------------------------------------------

  /** Starts typing: into a copy of `t` that stands in for it, or into a new text at (x, y). */
  startEdit(t, x, y) {
    let draft;
    if (t) {
      draft = remade(t, {});
      apply([draft], [t]);
    } else {
      const s = TEXT[store.width];
      draft = { k: "t", id: ++store.seq, ord: store.seq, x, y: y - (s * LEAD) / 2, s, c: COLORS[store.color], v: "", w: 0, h: 0 };
      apply([draft], []);
    }
    const end = draft.v.length;
    this.edit = { t: draft, orig: t, back: this.tool === "text" ? "pointer" : this.tool, caret: end, anchor: end, col: null };
    this.tool = "text";
    this.over = false;
    changed();
  }

  /** Ends typing: an emptied text is removed, and any change becomes one undo step. */
  finish(cx) {
    const { t, orig, back } = this.edit;
    this.edit = null;
    this.tool = back;
    t.v = t.v.replace(/\s+$/, "");
    if (!t.v) {
      apply([], [t]);
      orig ? commit({ add: [], del: [orig] }, cx) : changed();
    } else if (orig && orig.v === t.v && orig.c === t.c && orig.s === t.s) {
      apply([orig], [t]);
      changed();
    } else {
      commit({ add: [t], del: orig ? [orig] : [] }, cx);
    }
  }

  /** A key while typing. Returns false for keys typing doesn't use. */
  type(e, cx) {
    const ed = this.edit, t = ed.t, s = t.v, m = e.modifiers, k = e.key, c = ed.caret;
    const a = Math.min(ed.anchor, c), b = Math.max(ed.anchor, c);
    /** Replaces s[from, to) (the selection unless given) with `text`, the caret after it. */
    const put = (text, from = a, to = b) => {
      if (from === to && !text) return true;
      t.v = s.slice(0, from) + text + s.slice(to);
      ed.caret = ed.anchor = from + text.length;
      ed.col = null;
      t.w = 0;
      later(cx);
      changed();
      return true;
    };
    if (m.control) return false;
    if (m.platform && k === "v") {
      const text = cx.read_from_clipboard();
      if (text?.startsWith(`${MARK}\n`)) return false;  // canvas items: `key` pastes them
      return text ? put(text.replace(/\r\n?/g, "\n")) : true;
    }
    if (m.platform && (k === "c" || k === "x")) {
      if (a < b) cx.write_to_clipboard(s.slice(a, b));
      return k === "x" ? put("") : true;
    }
    if (m.platform && k === "a") {
      ed.anchor = 0;
      ed.caret = s.length;
      cx.notify();
      return true;
    }
    let to = null;
    if (k === "left") to = m.platform ? lineStart(s, c) : m.alt ? wordLeft(s, c) : a < b && !m.shift ? a : prev(s, c);
    else if (k === "right") to = m.platform ? lineEnd(s, c) : m.alt ? wordRight(s, c) : a < b && !m.shift ? b : next(s, c);
    else if (k === "home") to = lineStart(s, c);
    else if (k === "end") to = lineEnd(s, c);
    else if ((k === "up" || k === "down") && m.platform) to = k === "up" ? 0 : s.length;
    else if (k === "up" || k === "down") to = vertical(s, c, k === "up" ? -1 : 1, ed.col ??= column(s, c));
    if (to !== null) {
      if ((k !== "up" && k !== "down") || m.platform) ed.col = null;
      ed.caret = to;
      if (!m.shift) ed.anchor = to;
      cx.notify();
      return true;
    }
    if (k === "backspace" || k === "delete") {
      return a < b ? put("") : put("", ...deleted(s, c, k === "backspace", m.alt, m.platform));
    }
    if (m.platform) return false;
    if (k === "escape") {
      this.finish(cx);
      return true;
    }
    if (k === "enter") return put("\n");
    if (e.key_char && k !== "tab") return put(e.key_char);
    return false;
  }

  // -- Paste and drop -----------------------------------------------------------------

  /** Where pasted things go: under the pointer, or the middle of the pane. */
  target() {
    const pt = this.pointer ?? { x: this.size.width / 2, y: this.size.height / 2 };
    return this.world(pt);
  }

  /** Places images centered on (x, y), shrunk to fit well inside the pane. */
  place(found, x, y, cx) {
    const z = store.view.z, max = Math.max(80, (this.size.width * 0.6) / z), maxH = Math.max(80, (this.size.height * 0.6) / z);
    const add = found.filter(Boolean).map((m, n) => {
      const k = Math.min(1, max / m.w, maxH / m.h), w = m.w * k, h = m.h * k;
      return /** @type {Img} */ ({ k: "i", id: ++store.seq, ord: store.seq, x: x - w / 2 + n * 24, y: y - h / 2 + n * 24, w, h, src: m.src });
    });
    if (!add.length) return false;
    change(add, [], cx);
    this.tool = "pointer";
    this.sel = new Set(add);
    return true;
  }

  /** Writes the selection to the clipboard as MARK, then its saved form placed from its
   *  top-left corner, and its size. Returns whether there was anything to copy. */
  copy(cx) {
    if (!this.sel.size) return false;
    const items = [...this.sel].sort((a, b) => a.ord - b.ord), b = items.map(bounds).reduce(grow);
    const d = { w: tenth(b[2] - b[0]), h: tenth(b[3] - b[1]), ...dump(items, -b[0], -b[1]) };
    cx.write_to_clipboard(`${MARK}\n${JSON.stringify(d)}`);
    return true;
  }

  /** Copies of the selection 16 px down and right, on top and selected. */
  duplicate(cx) {
    const add = [...this.sel].sort((a, b) => a.ord - b.ord).map((i) => copied(i, 16 / store.view.z));
    change(add, [], cx);
    this.sel = new Set(add);
  }

  /** Moves the selection by (dx, dy): presses in a row on the same selection are one undo step. */
  nudge(dx, dy, cx) {
    const items = [...this.sel], copies = items.map((i) => moved(i, dx, dy)), last = store.undo.at(-1);
    apply(copies, items);
    const prior = last && last === this.nudged ? new Set(last.add) : null;
    if (prior && prior.size === items.length && items.every((i) => prior.has(i))) {
      last.add = copies;
      store.redo = [];
      later(cx);
      changed();
    } else {
      commit(this.nudged = { add: copies, del: items }, cx);
    }
    this.sel = new Set(copies);
  }

  /** Pastes canvas items copied as `copy` writes them, centered on (x, y), on top and selected.
   *  Images whose file has since been deleted are left out; unreadable text pastes nothing. */
  async pasteItems(text, x, y, cx) {
    let d, got;
    try {
      d = JSON.parse(text.slice(MARK.length + 1));
      got = undump(d, TEXT[1]);
    } catch {
      return;
    }
    const kept = [];
    for (const m of got.images) if (await fs.exists(`${appHome()}/${m.src}`)) kept.push(m);
    got.images = kept;
    const { strokes, texts, images } = made(got);
    const w = Number.isFinite(+d.w) ? +d.w : 0, h = Number.isFinite(+d.h) ? +d.h : 0;
    const add = [...images, ...strokes, ...texts].map((i) => moved(i, x - w / 2, y - h / 2));
    if (!add.length) return;
    change(add, [], cx);
    this.tool = "pointer";
    this.over = false;
    this.sel = new Set(add);
  }

  paste(cx) {
    const [x, y] = this.target();
    const clip = cx.read_from_clipboard();
    if (clip?.startsWith(`${MARK}\n`)) {
      cx.spawn(async (cx) => this.pasteItems(clip, x, y, cx));
      return;
    }
    cx.spawn(async (cx) => {
      const img = await clipboardImage();
      if (this.place([img], x, y, cx)) return;
      const text = cx.read_from_clipboard()?.replace(/\r\n?/g, "\n").replace(/\s+$/, "");
      if (!text) return;
      const s = TEXT[store.width];
      change([{ k: "t", id: ++store.seq, ord: store.seq, x, y: y - (s * LEAD) / 2, s, c: COLORS[store.color], v: text, w: 0, h: 0 }], [], cx);
    });
  }

  drop(paths, cx) {
    const [x, y] = this.target();
    cx.spawn(async (cx) => {
      const found = [];
      for (const p of paths) found.push(await droppedImage(p).catch(() => null));
      this.place(found, x, y, cx);
    });
  }

  // -- View ---------------------------------------------------------------------------

  zoomAt(pt, factor, cx) {
    const v = store.view;
    const z = Math.min(ZOOM[1], Math.max(ZOOM[0], v.z * factor));
    const k = z / v.z;
    v.x = pt.x - (pt.x - v.x) * k;
    v.y = pt.y - (pt.y - v.y) * k;
    v.z = z;
    store.zoomedAt = Date.now();
    this.wakeSettle?.();
    later(cx, true);
    this.refreshLater(cx);
    cx.notify();
  }

  wheel(e, cx) {
    const d = e.delta_lines ? { x: e.delta_lines.x * 24, y: e.delta_lines.y * 24 } : e.delta;
    if (e.modifiers.platform || e.modifiers.control) {
      this.zoomAt(this.local(e), Math.exp(d.y * 0.01), cx);
    } else {
      store.view.x += d.x;
      store.view.y += d.y;
      later(cx, true);
      this.refreshLater(cx);
      cx.notify();
    }
  }

  /** Brings the whole drawing back into view: centered, at 100% or zoomed out to fit it
   *  above the toolbar. With nothing drawn, back to where the canvas starts. */
  home(cx) {
    const W = this.size.width, H = this.size.height - 56, pad = 32;
    const all = everything();
    if (!all.length || !W || H <= 0) {
      store.view = { x: 0, y: 0, z: 1 };
    } else {
      const b = all.map(bounds).reduce(grow);
      const fit = Math.min((W - 2 * pad) / Math.max(1, b[2] - b[0]), (H - 2 * pad) / Math.max(1, b[3] - b[1]));
      const z = Math.min(1, Math.max(ZOOM[0], fit));
      store.view = { x: W / 2 - ((b[0] + b[2]) / 2) * z, y: H / 2 - ((b[1] + b[3]) / 2) * z, z };
    }
    later(cx, true);
    cx.notify();
  }

  // -- Minimap ------------------------------------------------------------------------

  /** A press on the minimap: centers the view there, and dragging keeps it under the pointer. */
  miniDown(e, cx) {
    cx.stop_propagation();
    this.focus.focus();
    if (this.mode) this.up(cx);
    if (this.edit) this.finish(cx);
    if (!this.mini) return;
    this.mode = "mini";
    // The view is part of what the minimap fits: hold its scale, or the map moves under the pointer.
    this.miniHeld = this.mini;
    // This press's local_position is within the minimap, not the pane: `local` would misread it.
    const m = this.mini, pt = e.local_position ? { x: e.local_position.x + m.left, y: e.local_position.y + m.top }
      : { x: e.position.x - this.origin.x, y: e.position.y - this.origin.y };
    if (e.local_position) this.origin = { x: e.position.x - pt.x, y: e.position.y - pt.y };
    this.miniGo(pt, cx);
  }

  /** Centers the view on the world point under pane point `pt` on the minimap. */
  miniGo(pt, cx) {
    const m = this.miniHeld ?? this.mini, v = store.view;
    if (!m) return;
    const wx = (pt.x - m.left - m.x) / m.s, wy = (pt.y - m.top - m.y) / m.s;
    v.x = this.size.width / 2 - wx * v.z;
    v.y = this.size.height / 2 - wy * v.z;
    cx.notify();
  }

  /** The minimap in the top-right corner: the drawing in miniature on gray, with the part the
   *  pane shows bright and the rest dimmed. Hidden while the drawing is empty or the pane is small. */
  minimap(t, paint) {
    const W = this.size.width, H = this.size.height, v = store.view, d = this.drag;
    this.mini = null;
    // What's being dragged is out of the drawing until it's let go: it shows where it started,
    // moved along with the drag (scaling shows at the old size until let go).
    const lifted = d ? (d.miniBox ??= d.items.map(bounds).reduce(grow)) : null, drawing = drawingBounds();
    const content = drawing && lifted ? grow(drawing, lifted) : drawing ?? lifted;
    if (W < 360 || H < 240 || !content) return null;
    const view = [-v.x / v.z, -v.y / v.z, (W - v.x) / v.z, (H - v.y) / v.z];
    // Refitting while panning would rebuild the picture every few frames: the fit is kept while
    // the drawing's extent (to 16 world px) and the pane stay the same, the view stays inside
    // the map, and the map isn't far too small for them.
    let fit = this.miniHeld;
    if (!fit) {
      const b = grow(content, view), key = `${content.map((n) => Math.round(n / 16)).join()}|${W}|${H}`, k = this.miniKept;
      const inside = k && k.key === key && k.x + view[0] * k.s >= 0 && k.y + view[1] * k.s >= 0
        && k.x + view[2] * k.s <= k.w && k.y + view[3] * k.s <= k.h;
      const ideal = Math.min((MINI[0] - 2 * MINI_PAD) / Math.max(1, b[2] - b[0]), (MINI[1] - 2 * MINI_PAD) / Math.max(1, b[3] - b[1]));
      if (inside && ideal < k.s * 2) fit = k;
      else {
        const [w, h] = miniSize(b, MINI, MINI_MIN, MINI_PAD);
        fit = this.miniKept = { ...miniFit(b, w, h, MINI_PAD), w, h, key };
      }
    }
    const { w, h, s } = fit;
    this.mini = { ...fit, left: W - MINI_GAP - w, top: MINI_GAP };
    const id = `${this.uid}-mini`, mark = t.foreground;
    /** @type {any[]} */ const layers = [];
    const dx = d && this.mode === "move" ? d.dx : 0, dy = d && this.mode === "move" ? d.dy : 0;
    const at = (el, e, ox = 0, oy = 0) => el.absolute().left(fit.x + (e.ox + ox) * s).top(fit.y + (e.oy + oy) * s).w(e.w).h(e.h);
    const here = drawingBlocks(s);
    const moving = d ? (d.miniBlocks?.s === s ? d.miniBlocks : d.miniBlocks = { s, e: miniBlocks(d.items.filter((i) => i.k !== "s"), s) }).e : null;
    const blocks = (e, ox, oy, key, color) => { if (e?.[key]) layers.push(at(window.paint_path(e[key], color), e, ox, oy)); };
    // Images under strokes under text, as on the canvas.
    blocks(here, 0, 0, "blocks", hexA(mark, "33"));
    blocks(moving, dx, dy, "blocks", hexA(mark, "33"));
    const chunks = (list, ox, oy) => {
      for (const ch of list) {
        // Like the canvas: chunks with no minimap build wait for the next frame once over budget.
        if (!miniPaths.has(`${ch.key}|${s}`) && Date.now() > this.buildBy) { this.more = true; continue; }
        const e = miniChunk(ch, s), col = paint(ch.c);
        for (const l of e.lines) layers.push(at(window.paint_path(l, col), e, ox, oy));
        for (const c of e.caps) layers.push(at(window.paint_path(c, col), e, ox, oy));
      }
    };
    chunks(store.chunks, 0, 0);
    if (d) chunks(d.chunks, dx, dy);
    blocks(here, 0, 0, "notes", hexA(mark, "80"));
    blocks(moving, dx, dy, "notes", hexA(mark, "80"));
    // Built paths for chunks the drawing no longer has go, as `paths` do.
    const live = store.chunks.length + (d?.chunks.length ?? 0);
    if (miniPaths.size > live * 4 + 16) {
      const keep = new Set([...store.chunks, ...d?.chunks ?? []].map((c) => c.key));
      for (const k of miniPaths.keys()) if (!keep.has(k.slice(0, k.lastIndexOf("|")))) miniPaths.delete(k);
      if (miniPaths.size > live * 4 + 16) miniPaths.clear();
    }
    // The part the pane shows stays bright; around it the map dims toward the canvas, in four
    // bands (top, bottom, left, right), with a faint edge on the bright part.
    const vl = Math.max(0, fit.x + view[0] * s), vt = Math.max(0, fit.y + view[1] * s);
    const vr = Math.min(w, fit.x + view[2] * s), vb = Math.min(h, fit.y + view[3] * s);
    const dim = hexA(t.background, "a6"), band = (n, l, top, bw, bh) => {
      if (bw > 0 && bh > 0) layers.push(div().id(`${id}-dim-${n}`).absolute().left(l).top(top).w(bw).h(bh).bg(dim));
    };
    if (vr <= vl || vb <= vt) band("all", 0, 0, w, h);
    else {
      band("top", 0, 0, w, vt);
      band("bottom", 0, vb, w, h - vb);
      band("left", 0, vt, vl, vb - vt);
      band("right", vr, vt, w - vr, vb - vt);
      layers.push(div().id(`${id}-view`).absolute().left(vl).top(vt).w(vr - vl).h(vb - vt)
        .border(1).border_color(hexA(mark, "40")));
    }
    return div().id(id).absolute().top(MINI_GAP).right(MINI_GAP).w(w).h(h).overflow_hidden()
      .bg(t.popover ?? t.chrome)
      .when(this.mode === "mini", (el) => el.cursor_grabbing()).when(this.mode !== "mini", (el) => el.cursor_pointer())
      .on_mouse_down("left", (e, cx) => this.miniDown(e, cx))
      .children(layers);
  }

  // -- Keys, history and toolbar ------------------------------------------------------

  /** A key that keys.json's mod:canvas section takes back from a global binding (cmd-d,
   *  cmd-shift-arrows, alt-shift-left/right), as "cmd-shift-left". The canvas uses it while
   *  typing in a text box (or, for cmd-d, with a selection); otherwise it does what these keys do in
   *  Herdr: split a pane, move between panes, switch tabs (see `tabCommand`). */
  globalKey(keystroke, cx) {
    if (!this.focus.is_focused()) return;  // every shown copy gets the command
    const parts = keystroke.split("-"), key = /** @type {string} */ (parts.pop());
    const m = { shift: parts.includes("shift"), control: false, alt: parts.includes("alt"), platform: parts.includes("cmd"), function: false };
    const used = this.mode ? false : key === "d" ? !this.edit && this.sel.size > 0 : !!this.edit;
    if (used) { this.key({ key, keystroke, modifiers: m, key_char: undefined }, cx); return; }
    if (this.mode) return;
    if (key === "d") run("pane.split", { direction: "right" });
    else if (m.platform) run("pane.go", { direction: key });
    else if (key === "left" || key === "right") run(tabCommand(key === "left" ? "prev" : "next"));
  }

  key(e, cx) {
    if (this.edit && this.type(e, cx)) return;
    const m = e.modifiers, cmd = m.platform, plain = !cmd && !m.control && !m.alt;
    // Holding space makes a drag pan, whatever the tool (keyUp lets go).
    if (plain && (e.key === "space" || e.key === " ")) {
      cx.stop_propagation();  // held, it repeats ~30 times a second: keep those to the canvas
      if (!this.spaceHeld) { this.spaceHeld = true; cx.notify(); }
      return;
    }
    if (cmd && e.key === "z") {
      if (this.mode) return;
      if (this.edit) this.finish(cx);
      m.shift ? this.redo(cx) : this.undo(cx);
    } else if (cmd && e.key === "v") {
      if (this.mode) return;
      if (this.edit) this.finish(cx);
      this.paste(cx);
    } else if (cmd && (e.key === "c" || e.key === "x") && !this.mode) {
      if (this.copy(cx) && e.key === "x") {
        const del = [...this.sel];
        this.sel.clear();
        change([], del, cx);
      }
    } else if (cmd && e.key === "d" && this.sel.size && !this.mode) {
      this.duplicate(cx);
    } else if (cmd && e.key === "a" && !this.mode) {
      this.tool = "pointer";
      this.over = false;
      this.sel = new Set(everything());
      cx.notify();
    } else if ((e.key === "backspace" || e.key === "delete") && this.sel.size && !this.mode) {
      const del = [...this.sel];
      this.sel.clear();
      change([], del, cx);
    } else if (plain && NUDGE[e.key] && this.tool === "pointer" && this.sel.size && !this.mode && !this.edit) {
      const d = (m.shift ? 10 : 1) / store.view.z;
      this.nudge(NUDGE[e.key][0] * d, NUDGE[e.key][1] * d, cx);
    } else if (plain && !m.shift && TOOLS[e.key] && !this.mode && !this.edit) {
      this.setTool(TOOLS[e.key], cx);
    } else if (e.key === "escape") {
      if (this.sel.size) this.sel.clear();
      else if (this.tool !== "pointer") this.setTool("pointer", cx);
      cx.notify();
    }
  }

  undo(cx) {
    const u = store.undo.pop();
    if (!u) return;
    apply(u.del, u.add);
    store.redo.push(u);
    this.sel.clear();
    later(cx);
    changed();
  }

  redo(cx) {
    const r = store.redo.pop();
    if (!r) return;
    apply(r.add, r.del);
    store.undo.push(r);
    this.sel.clear();
    later(cx);
    changed();
  }

  clear(cx) {
    if (this.mode) return;
    if (this.edit) this.finish(cx);
    this.sel.clear();
    change([], everything(), cx);
  }

  setTool(tool, cx) {
    if (this.edit) this.finish(cx);
    if (tool !== "pointer") this.sel.clear();
    this.tool = tool;
    this.over = false;
    if (tool === "eraser" && this.pointer) this.ringAt(this.pointer);
    cx.notify();
  }

  /** A color or size picked in the toolbar: also given to the text being typed, or to the
   *  selection as one undo step. */
  restyle(cx, color, width) {
    if (color !== undefined) store.color = color;
    if (width !== undefined) store.width = width;
    if (this.edit) {
      if (color !== undefined) this.edit.t.c = COLORS[color];
      if (width !== undefined) { this.edit.t.s = TEXT[width]; this.edit.t.w = 0; }
      store.dirty = true;
    } else if (this.sel.size) {
      const del = [...this.sel].filter((i) => i.k !== "i");
      const add = del.map((i) => color !== undefined ? remade(i, { c: COLORS[color] })
        : i.k === "s" ? remade(i, { w: WIDTHS[width], box: strokeBox(i.p, WIDTHS[width], i.a) })
        : remade(i, { s: TEXT[width], w: 0, h: 0 }));
      const images = [...this.sel].filter((i) => i.k === "i");
      if (add.length) change(add, del, cx);
      this.sel = new Set([...images, ...add]);
    }
    later(cx, true);
    changed();
  }

  // -- Painting -----------------------------------------------------------------------

  /** A chunk's paths, as parts (each placed by its own box). With `exact`, built at zoom `z`;
   *  without, any build of its strokes will do (it's stretched to the zoom; only the lines'
   *  thickness is off), so only a chunk never built is built. A stroke added to a chunk is built
   *  alone, as one more part onto the chunk's last build; a tile's rebuild (`tileBody`) folds
   *  them back into one. */
  built(ch, z, exact = false) {
    const e = paths.get(ch.key);
    if (e && (!exact || e.z === z)) return e;
    const pre = e ? null : owner.get(ch.strokes[0].id);
    if (pre && pre.n < ch.strokes.length && ch.key.startsWith(`${pre.key},`) && (!exact || pre.z === z)) {
      const job = this.job(ch, ch.strokes.slice(pre.n), pre.z);
      while (job.i < job.strokes.length) job.add(job.strokes[job.i++]);
      return this.keep(ch, { z: pre.z, parts: [...pre.parts, job.part()] });
    }
    const job = this.job(ch, ch.strokes, z);
    while (job.i < job.strokes.length) job.add(job.strokes[job.i++]);
    return this.keep(ch, { z, parts: [job.part()] });
  }

  /** Once the view has been still for REFRESH_MS, queues every tile on screen to draw once more.
   *  Herdr can stop a view after its render() returns (layout and paint count toward its time
   *  limit) and keep showing the frame before, and nothing tells the view: a tile would then
   *  show strokes built for another zoom (rings for round ends, lines too thick or thin) while
   *  `tileAs` says it is current. Drawing again is cheap, as its chunks are built by then. */
  refreshLater(cx) {
    this.refreshTask?.cancel();
    this.refreshTask = cx.timer.after(REFRESH_MS, () => {
      const v = store.view, z = v.z, W = this.size.width, H = this.size.height;
      for (let t = 0; t < TILES; t++) {
        const b = this.tileAs[t]?.box;
        if (!b || this.wantSet.has(t)) continue;
        if (b[2] * z + v.x < 0 || b[0] * z + v.x > W || b[3] * z + v.y < 0 || b[1] * z + v.y > H) continue;
        this.wantSet.add(t);
        this.want.push(t);
      }
      this.want = this.centerFirst(this.want);
      if (this.want.length) this.wakeTiles?.();
    });
  }

  /** The zoom tiles are built at now: while the zoom moves, the nearest step (ZOOM_STEP), so one
   *  build serves a range of zooms; once it settles, the zoom itself. */
  tileZoom() {
    const z = store.view.z;
    return Date.now() - store.zoomedAt < SETTLE_MS ? 2 ** (Math.round(Math.log2(z) / ZOOM_STEP) * ZOOM_STEP) : z;
  }

  /** The tile `t` as its view (Tile) draws it: its chunks at the tile zoom, in percentages of
   *  the box round them, so the box can be moved and stretched without drawing them again. */
  tileBody(t) {
    const list = this.tileLists?.[t] ?? [], z = this.tileZoom(), fg = theme().foreground;
    const sig = tileSig(list, fg);
    if (!list.length) {
      this.tileAs[t] = { sig, z, box: null };
      return div().id(`${this.uid}-tile-${t}`);
    }
    let b = [Infinity, Infinity, -Infinity, -Infinity];
    for (const ch of list) b = grow(b, [ch.box[0] - ch.w, ch.box[1] - ch.w, ch.box[2] + ch.w, ch.box[3] + ch.w]);
    const bw = b[2] - b[0], bh = b[3] - b[1], pc = (v) => `${v * 100}%`;
    // Chunks are built at the zoom until TILE_BUILD_MS runs out; the rest keep any build they
    // have, stretched, and the tile is left marked out of date, so `drawTiles` queues it again
    // and the next frame carries on where this one stopped.
    const out = [], by = Date.now() + TILE_BUILD_MS;
    let done = true, missing = false;  // missing: chunks left out, so the main view paints them meanwhile
    for (const ch of list) {
      const time = Date.now() < by;
      if (!time && !paths.has(ch.key)) { done = false; missing = true; continue; }
      let e = this.built(ch, z, time);
      if (time && e.parts.length > 1) { paths.delete(ch.key); e = this.built(ch, z, true); }
      if (e.z !== z || e.parts.length > 1) done = false;
      const col = ch.c === "fg" ? fg : ch.c;
      for (const part of e.parts) {
        const at = (el) => el.absolute().left(pc((part.ox - b[0]) / bw)).top(pc((part.oy - b[1]) / bh))
          .w(pc(part.bw / bw)).h(pc(part.bh / bh));
        for (const l of part.lines) out.push(at(window.paint_path(l, col)));
        for (const c of part.caps) out.push(at(window.paint_path(c, col)));
      }
    }
    this.tileAs[t] = { sig: missing ? null : sig, z: done ? z : null, box: b };
    return div().id(`${this.uid}-tile-${t}`).size_full().relative().children(out);
  }

  /** The strokes as layers: each tile's view, moved and stretched to the view, where it drew
   *  what the store holds; where it doesn't (strokes added or erased since), the chunks painted
   *  here until it has drawn them. Tiles out of date, or on screen and built for another zoom,
   *  are queued for the loop in `init` to rebuild, those with strokes first. */
  drawTiles(layers, paintChunks, offscreen) {
    let R = TILE_ORD;
    while (store.seq >= TILES * R) R *= 2;
    /** @type {Chunk[][]} */ const lists = Array.from({ length: TILES }, () => []);
    for (const ch of store.chunks) lists[Math.min(TILES - 1, Math.floor(ch.strokes[0].ord / R))].push(ch);
    this.tileLists = lists;
    const v = store.view, z = v.z, zt = this.tileZoom(), fg = theme().foreground, near = [], far = [];
    // Herdr draws only views that are in the layout, so a tile to be drawn again stays in it:
    // out of date, in an empty, hidden box (its chunks are painted here meanwhile); built for
    // another zoom, where it is, stretched. A tile off screen waits until it comes on.
    for (let t = 0; t < TILES; t++) {
      const list = lists[t], as = this.tileAs[t], sig = tileSig(list, fg);
      if (!as || as.sig !== sig) {
        if (!this.wantSet.has(t)) (list.length ? near : far).push(t);
        layers.push(div().absolute().left(0).top(0).w(0).h(0).opacity(0).child(this.tiles[t]));
        if (list.length) paintChunks(list);
        continue;
      }
      const b = as.box;
      if (!b || offscreen(b)) continue;
      if (as.z !== zt && !this.wantSet.has(t)) near.push(t);
      layers.push(div().absolute().left(b[0] * z + v.x).top(b[1] * z + v.y).w((b[2] - b[0]) * z).h((b[3] - b[1]) * z)
        .child(this.tiles[t]));
    }
    if (near.length || far.length) {
      for (const t of [...near, ...far]) this.wantSet.add(t);
      this.want = this.centerFirst([...near, ...this.want]).concat(far);
      this.wakeTiles?.();
    }
  }

  /** Tiles in order of how near the middle of the screen they are, so where you look catches
   *  up first after a zoom. A tile's box is where it last drew, else round its chunks. */
  centerFirst(list) {
    const v = store.view, z = v.z, cx = (this.size.width / 2 - v.x) / z, cy = (this.size.height / 2 - v.y) / z;
    const dist = (t) => {
      let b = this.tileAs[t]?.box;
      if (!b) for (const ch of this.tileLists?.[t] ?? []) b = b ? grow(b, ch.box) : ch.box;
      if (!b) return Infinity;
      const dx = Math.max(b[0] - cx, 0, cx - b[2]), dy = Math.max(b[1] - cy, 0, cy - b[3]);
      return dx * dx + dy * dy;
    };
    const d = new Map(list.map((t) => [t, dist(t)]));
    return list.sort((a, b) => d.get(a) - d.get(b));
  }

  /** Caches a chunk's build, and notes it as the last build of each of its strokes. */
  keep(ch, e) {
    Object.assign(e, { key: ch.key, n: ch.strokes.length });
    paths.set(ch.key, e);
    for (const st of ch.strokes) owner.set(st.id, e);
    return e;
  }

  /** A build of `strokes` (of chunk `ch`) at zoom `z`, a stroke at a time with `add`; `part()`
   *  is the result, placed by the strokes' own box. */
  job(ch, strokes, z) {
    const m = ch.w;
    let b = strokes[0].box;
    for (const st of strokes) b = grow(b, st.box);
    const ox = b[0] - m, oy = b[1] - m, bw = b[2] - b[0] + 2 * m, bh = b[3] - b[1] + 2 * m;
    const r = (ch.w * z) / (2 + DOT);
    // Below 100%, strokes are thinned to what shows, per halving of the zoom so a pinch reuses it.
    const step = z < 1 ? 2 ** Math.ceil(Math.log2(z)) : 0;
    const pts = (s) => {
      if (!step) return s.p;
      let t = thin.get(s);
      if (t?.z !== step) thin.set(s, t = { z: step, p: simplify(s.p, 0.35 / step) });
      return t.p;
    };
    const line = new Pieces(ch.w * z, bw * z, bh * z), cap = new Pieces(r * DOT, bw * z, bh * z);
    const dot = (x, y) => cap.put(circle(cap.get(), x, y, r), 4);
    const add = (s) => {
      const p = pts(s), n = p.length;
      if (length(p) > 0) tracePieces(line, p, ox, oy, z, dot, ch.w / 2);
      dot((p[0] - ox) * z, (p[1] - oy) * z);
      if (n >= 4) dot((p[n - 2] - ox) * z, (p[n - 1] - oy) * z);
      if (s.a) {
        const [l, c] = barbs(line.get(), cap.get(), head(s.p, s.w), ox, oy, z, r);
        line.put(l, 4);
        cap.put(c, 8);
      }
    };
    /** @param {boolean} [sofar] what's built so far, leaving the job to go on */
    const part = (sofar = false) => ({ ox, oy, bw, bh,
      lines: sofar ? line.out.slice() : line.done(), caps: sofar ? cap.out.slice() : cap.done() });
    return { z, i: 0, strokes, add, part };
  }

  /** The stroke being drawn, as layers. Every LIVE points, the part the smoothing can no
   *  longer change is traced once into `cur.kept`, so each move traces only the rest. */
  live(col) {
    const c = this.cur, v = store.view, z = v.z, w = WIDTHS[store.width];
    const ox = -v.x / z, oy = -v.y / z, r = (w * z) / (2 + DOT);
    const at = (el) => el.absolute().left(0).top(0).size_full();
    const out = [];
    const draw = (line, cap) => {
      if (line) out.push(at(window.paint_path(line, col)));
      out.push(at(window.paint_path(cap, col)));
    };
    const ends = (p, start) => {
      let cap = PathBuilder.stroke(r * DOT);
      if (start) cap = circle(cap, (p[0] - ox) * z, (p[1] - oy) * z, r);
      return cap;
    };
    if (c.snapped) {
      const p = [...c.p, ...c.tail], n = p.length;
      draw(trace(PathBuilder.stroke(w * z), p, ox, oy, z).build(),
        circle(ends(p, true), (p[n - 2] - ox) * z, (p[n - 1] - oy) * z, r).build());
      return out;
    }
    let k = c.kept;
    if (k && (k.ox !== ox || k.oy !== oy || k.z !== z)) k = c.kept = null;  // the view moved: start over
    const n = c.p.length / 2 + 1;  // with the tail
    if (n - REACH - 2 - (k?.i ?? 1) >= LIVE) {
      // A point is final once smoothed when the points its smoothing reaches (REACH each way)
      // are kept, so up to n - REACH - 2; a run smoothed from `a` is right from a + REACH on.
      k ??= c.kept = { ox, oy, z, i: 1, ex: c.p[0], ey: c.p[1], paths: [] };
      const a = Math.max(0, k.i - REACH - 1), stop = n - REACH - 2;
      const sm = smooth(c.p.slice(2 * a, 2 * (stop + REACH + 1))), part = { i: k.i - a, ex: k.ex, ey: k.ey, stop: stop - a };
      let cap = ends(sm, k.i === 1);
      const line = trace(PathBuilder.stroke(w * z), sm, ox, oy, z, (x, y) => { cap = circle(cap, x, y, r); }, part, w / 2);
      k.paths.push({ line: line.build(), cap: cap.build() });
      Object.assign(k, { i: a + part.i, ex: part.ex, ey: part.ey });
    }
    for (const kp of k?.paths ?? []) draw(kp.line, kp.cap);
    const a = k ? Math.max(0, k.i - REACH - 1) : 0;
    const p = smooth([...c.p.slice(2 * a), ...c.tail]), m = p.length;
    let cap = ends(p, !k);
    const dot = (x, y) => { cap = circle(cap, x, y, r); };
    const line = k ? trace(PathBuilder.stroke(w * z), p, ox, oy, z, dot, { i: k.i - a, ex: k.ex, ey: k.ey }, w / 2)
      : length(p) > 0 ? trace(PathBuilder.stroke(w * z), p, ox, oy, z, dot, null, w / 2) : null;
    if (m >= 4) cap = circle(cap, (p[m - 2] - ox) * z, (p[m - 1] - oy) * z, r);
    draw(line?.build() ?? null, cap.build());
    return out;
  }

  /** The background dots: one row path, repeated down the pane. */
  grid(t) {
    const v = store.view, W = this.size.width, H = this.size.height;
    if (!W || !H) return [];
    let s = GRID * v.z;
    while (s < 14) s *= 2;
    while (s >= 56) s /= 2;
    const cols = Math.ceil(W / s) + 2;
    if (!this.dots || this.dots.s !== s || this.dots.cols !== cols) {
      // One dashed line per row, each dash a 1.6 px square: a polygon per dot was a native
      // call per dot, rebuilt on every zoom step.
      const d = 0.8;
      const path = PathBuilder.stroke(2 * d).dash_array([2 * d, s - 2 * d]).move_to(0, d).line_to(cols * s, d).build();
      this.dots = { s, cols, path };
    }
    const ox = ((v.x % s) + s) % s - s - 0.8, oy = ((v.y % s) + s) % s - s - 0.8;
    const color = hexA(t.foreground, "2e");
    const rows = [];
    for (let j = 0; j < Math.ceil(H / s) + 2; j++) {
      rows.push(window.paint_path(this.dots.path, color).absolute().left(ox).top(oy + j * s).w(cols * s).h(2));
    }
    return rows;
  }

  render() {
    this.buildBy = Date.now() + PAINT_BUILD_MS;
    this.more = false;
    this.drawn = store.version;
    const t = theme(), v = store.view, z = v.z, W = this.size.width, H = this.size.height;
    const paint = (c) => (c === "fg" ? t.foreground : c);
    // Selection marks are neutral, so they read the same over every ink color.
    const mark = t.foreground;
    const d = this.drag, resizing = this.mode === "scale", dx = resizing ? 0 : d?.dx ?? 0, dy = resizing ? 0 : d?.dy ?? 0;
    const offscreen = (b, ox = 0, oy = 0) => W && ((b[0] + ox) * z + v.x > W || (b[1] + oy) * z + v.y > H
      || (b[2] + ox) * z + v.x < 0 || (b[3] + oy) * z + v.y < 0);
    const layers = [];

    const images = (list, ox, oy) => {
      for (const m of list) {
        if (offscreen(bounds(m), ox, oy)) continue;
        layers.push(image(m.src).id(`${this.uid}-img-${m.id}`).absolute()
          .left((m.x + ox) * z + v.x).top((m.y + oy) * z + v.y).w(m.w * z).h(m.h * z));
      }
    };
    // What the eraser has taken shows faintly until it lets go: mixed into the background
    // rather than see-through, where a stroke's line and round ends would overlap darker.
    const ink = (c, dim) => (dim ? faded(paint(c), t.background) : paint(c));
    /** Chunks as they are, dimmed, or `lifted` and drawn where the drag shows them (`shown`). */
    const chunks = (list, dim = false, lifted = false) => {
      const k = lifted && resizing ? d.shown : 1, place = (b) => (lifted ? this.shown(b) : b);
      for (const ch of list) {
        if (offscreen(place([ch.box[0] - ch.w, ch.box[1] - ch.w, ch.box[2] + ch.w, ch.box[3] + ch.w]))) continue;
        // An erase, undo or move can leave many chunks with no build at all; past this frame's
        // budget they wait for the next frame (wakeMore), rather than overrun Herdr's limit.
        if (!paths.has(ch.key) && Date.now() > this.buildBy) { this.more = true; continue; }
        const col = ink(ch.c, dim);
        for (const e of this.built(ch, z * k).parts) {
          const [l, top] = place([e.ox, e.oy, e.ox, e.oy]);
          const at = (el) => el.absolute().left(l * z + v.x).top(top * z + v.y).w(e.bw * z * k).h(e.bh * z * k);
          for (const l of e.lines) layers.push(at(window.paint_path(l, col)));
          for (const c of e.caps) layers.push(at(window.paint_path(c, col)));
        }
      }
    };
    const ed = this.edit, focused = this.focus.is_focused();
    /** A line of the text being typed, starting at index `at` of its string: its runs, the
     *  selected one shaded, with the caret between them. */
    const typed = (line, at, fs, col) => {
      const a = Math.min(ed.anchor, ed.caret), b = Math.max(ed.anchor, ed.caret), c = ed.caret, end = at + line.length;
      const sa = Math.min(Math.max(a, at), end), sb = Math.min(Math.max(b, at), end), here = focused && c >= at && c <= end;
      // No width of its own, so the text doesn't shift as it moves.
      const caret = () => div().w(0).h(fs * 1.1).relative()
        .child(div().absolute().left(0).top(0).w(Math.max(1, fs * 0.06)).h(fs * 1.1).bg(col));
      const out = [];
      if (sa > at) out.push(line.slice(0, sa - at));
      if (here && c === sa) out.push(caret());
      if (sb > sa) out.push(div().bg(hexA(t.selection, "cc")).child(line.slice(sa - at, sb - at)));
      if (here && c !== sa && c === sb) out.push(caret());
      if (end > sb) out.push(line.slice(sb - at));
      return out;
    };
    const texts = (list, ox, oy, dim = false) => {
      for (const tx of list) {
        if (offscreen(bounds(tx), ox, oy)) continue;
        const fs = tx.s * z, lh = fs * LEAD, col = ink(tx.c, dim), editing = ed?.t === tx;
        let at = 0;
        const rows = tx.v.split("\n").map((line) => {
          const row = h_flex().h(lh).items_center().children(editing ? typed(line, at, fs, col) : [line]);
          at += line.length + 1;
          return row;
        });
        layers.push(v_flex().id(`${this.uid}-note-${tx.id}`).absolute().left((tx.x + ox) * z + v.x).top((tx.y + oy) * z + v.y)
          .font_family("Chalkboard SE").text_size(fs).line_height(LEAD).text_color(col).whitespace_nowrap()
          .on_size_change((size) => {
            if (tx.w === size.width / z && tx.h === size.height / z) return;
            tx.w = size.width / z;
            tx.h = size.height / z;
            sized++;
          })
          .children(rows));
      }
    };

    // Images under strokes under text; what's being moved on top.
    images(store.images, 0, 0);
    this.drawTiles(layers, (list) => chunks(list), (b) => offscreen(b));
    texts(store.texts, 0, 0);
    if (d) {
      // While scaling, the texts and images show as scaled stand-ins with the same ids.
      const [ax, ay] = d.handle?.a ?? [0, 0], look = (i) => (resizing ? { ...i, ...scaling(i, ax, ay, d.shown) } : i);
      images(d.items.filter((i) => i.k === "i").map(look), dx, dy);
      chunks(d.chunks, false, true);
      texts(d.items.filter((i) => i.k === "t").map(look), dx, dy);
    }
    if (this.erase) {
      chunks(this.erase.chunks, true);
      texts([...this.erase.hit].filter((i) => i.k === "t"), 0, 0, true);
    }
    const live = new Set(store.chunks.map((c) => c.key));
    for (const c of [...d?.chunks ?? [], ...this.erase?.chunks ?? []]) live.add(c.key);
    if (paths.size > live.size * 2 + 8) for (const k of paths.keys()) if (!live.has(k)) paths.delete(k);
    if (owner.size > store.strokes.length * 2 + 64) {
      const ids = new Set(store.strokes.map((st) => st.id));
      for (const id of owner.keys()) if (!ids.has(id)) owner.delete(id);
    }
    // The stroke being drawn is its own view (Ink): each pen move redraws only it.
    if (this.cur) layers.push(this.ink);

    // The selection: a thin box around each item (when there are few) and one around them all.
    if (this.sel.size) {
      const present = new Set(d ? d.items : everything());
      for (const i of this.sel) if (!present.has(i)) this.sel.delete(i);
    }
    const outline = (b, key, color, pad) => div().id(`${this.uid}-${key}`).absolute()
      .left(b[0] * z + v.x - pad).top(b[1] * z + v.y - pad)
      .w((b[2] - b[0]) * z + 2 * pad).h((b[3] - b[1]) * z + 2 * pad).border(1).border_color(color);
    if (this.sel.size) {
      if (this.sel.size > 1 && this.sel.size <= 100) {
        for (const [n, i] of [...this.sel].entries()) layers.push(outline(this.shown(bounds(i)), `sel-${n}`, hexA(mark, "26"), 3).rounded(3));
      }
      layers.push(outline(this.shown(this.selBounds()), "selection", hexA(mark, "66"), SEL_PAD).rounded(4));
      if (this.tool === "pointer" && this.mode !== "move" && this.mode !== "range") {
        for (const h of this.handles()) {
          layers.push(div().id(`${this.uid}-handle-${h.n}`).absolute().left(h.sx - 4).top(h.sy - 4).size(8)
            .rounded_full().bg(mark).border(1).border_color(t.background));
        }
      }
    }
    if (this.mode === "range") {
      const p = this.press;
      const r = [Math.min(p.x, p.x1), Math.min(p.y, p.y1), Math.max(p.x, p.x1), Math.max(p.y, p.y1)];
      layers.push(outline(r, "range", hexA(mark, "40"), 0).rounded(2).bg(hexA(mark, "0d")));
    }
    // The eraser's ring is its own view (Ring): following the pointer redraws only it.
    if (this.tool === "eraser" && this.pointer) layers.push(this.ring);

    let root = div().id(this.uid).size_full().relative().overflow_hidden().bg(t.background)
      .track_focus(this.focus)
      .on_size_change((size, cx) => { this.size = size; cx.notify(); })
      .on_mouse_down("left", (e, cx) => this.down(e, cx))
      .on_mouse_down("middle", (e, cx) => this.down(e, cx))
      .on_mouse_move((e, cx) => this.move(e, cx))
      .on_mouse_up("left", (_e, cx) => this.up(cx))
      .on_mouse_up("middle", (_e, cx) => this.up(cx))
      .on_hover((hovered, cx) => { if (!hovered) { this.pointer = null; this.spaceHeld = false; if (this.mode) this.up(cx); cx.notify(); } })
      .on_scroll_wheel((e, cx) => this.wheel(e, cx))
      .on_pinch((e, cx) => this.zoomAt(this.local(e), 1 + e.delta, cx))
      .on_drop((e, cx) => this.drop(e.paths, cx))
      .on_key_down((e, cx) => this.key(e, cx))
      .on_key_up((e, cx) => {
        if ((e.key === "space" || e.key === " ") && this.spaceHeld) { this.spaceHeld = false; cx.stop_propagation(); cx.notify(); }
      });
    root = this.mode === "pan" || this.mode === "mini" ? root.cursor_grabbing()
      : this.spaceHeld ? root.cursor_grab()
      : this.mode === "move" ? root.cursor_grabbing()
      : this.mode === "scale" ? (this.drag.handle.cur === "nwse" ? root.cursor_nwse_resize() : root.cursor_nesw_resize())
      : this.tool === "pointer" ? (this.over === "nwse" ? root.cursor_nwse_resize() : this.over === "nesw" ? root.cursor_nesw_resize()
        : this.over ? root.cursor_grab() : root.cursor_default())
      // Herdr can't hide the pointer, so the eraser keeps the plain arrow, its tip at the ring's center.
      : this.tool === "eraser" ? root.cursor_default()
      : this.tool === "text" ? root.cursor_text() : root.cursor_crosshair();
    const mini = this.minimap(t, paint);
    const g = this.grid(t);
    const tb = this.toolbar(t, paint);
    const out = root.children([...g, ...layers, ...(mini ? [mini] : []), tb]);
    if (this.more) this.wakeMore?.();
    return out;
  }

  toolbar(t, paint) {
    const id = this.uid, cur = paint(COLORS[store.color]), ic = iconPaths();
    const sep = () => div().w(1).h(16).mx(2).bg(t.border);
    const button = (key) => h_flex().id(`${id}-${key}`).h(24).items_center().justify_center().rounded(6)
      .cursor_pointer().hover((s) => s.bg(t.hover));
    const tool = (name, tip, glyph) => {
      const on = this.tool === name;
      return button(`tool-${name}`).w(24).tooltip(tip).when(on, (s) => s.bg(t.selected))
        .child(glyph(on ? t.foreground : t.muted)).on_click((_e, cx) => this.setTool(name, cx));
    };
    const icon = (path, color) => window.paint_path(path, color).size(16);
    const tools = [
      tool("pointer", "Select (S)", (c) => icon(ic.pointer, c)),
      tool("pen", "Draw (A)", (c) => div().size(16).relative().child(icon(ic.pen, c).absolute().top(0).left(0))
        .child(icon(ic.tip, c).absolute().top(0).left(0))),
      tool("eraser", "Erase (E)", (c) => div().size(16).relative().child(icon(ic.eraser, c).absolute().top(0).left(0))
        .child(icon(ic.rubber, c).absolute().top(0).left(0))),
      tool("text", "Text (T)", (c) => div().text_size(14).font_weight(600).text_color(c).child("T")),
    ];
    const swatches = COLORS.map((c, i) => button(`color-${i}`).w(24)
      .child(div().size(14).rounded_full().bg(paint(c)))
      .when(i === store.color, (s) => s.bg(t.selected))
      .on_click((_e, cx) => this.restyle(cx, i, undefined)));
    const sizes = WIDTHS.map((w, i) => button(`size-${i}`).w(24)
      .child(div().size(w + 2).rounded_full().bg(i === store.width ? cur : t.muted))
      .when(i === store.width, (s) => s.bg(t.selected))
      .on_click((_e, cx) => this.restyle(cx, undefined, i)));
    const zoom = Math.round(store.view.z * 100);
    const label = (key, text, act) => button(key).px(8).text_size(12).text_color(t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).child(text).on_click((_e, cx) => act(cx));
    const bar = h_flex().id(`${id}-bar`).gap(2).p(4).items_center().rounded(10).cursor_default()
      .bg(t.popover ?? t.chrome).border(1).border_color(t.border).shadow_md()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .children([...tools, sep(), ...swatches, sep(), ...sizes, sep(),
        label("zoom", `${zoom}%`, (cx) => this.home(cx)).tooltip("Back to the drawing"),
        label("clear", "Clear", (cx) => this.clear(cx))]);
    return h_flex().absolute().left(0).right(0).bottom(12).justify_center().child(bar);
  }
}

/** Canvas copies by uid, so their Ink views can reach them. @type {Map<string, any>} */
const canvases = new Map();

/** The stroke being drawn, over the canvas. Its own view so a pen move redraws only it: the
 *  whole canvas took 30+ ms a frame with a couple of hundred strokes, so the ink trailed the pen. */
/** What a tile shows: its chunks (by key) and the foreground color "fg" ink takes. */
const tileSig = (list, fg) => `${fg}|${list.map((ch) => ch.key).join(";")}`;

/** A run of the drawing's strokes (a range of the stacking order), drawn as its own view: Herdr
 *  keeps a view's drawing while its parent moves and resizes it, and draws it again only when
 *  asked. So panning and zooming don't repaint every stroke on every frame; only a tile whose
 *  strokes changed, or whose zoom is too far off, is drawn again (Canvas.drawTiles). */
class Tile extends View {
  init(props) {
    this.uid = props.uid;
    this.t = props.t;
  }

  update(props) {
    this.uid = props.uid;
    this.t = props.t;
  }

  render() {
    const c = canvases.get(this.uid);
    return c ? c.tileBody(this.t) : div();
  }
}

class Ink extends View {
  init(props) {
    this.uid = props.uid;
  }

  update(props) {
    this.uid = props.uid;
  }

  render() {
    const c = canvases.get(this.uid), col = store.color, f = COLORS[col];
    const out = c?.cur ? c.live(f === "fg" ? theme().foreground : f) : [];
    return div().id(`${this.uid}-ink`).absolute().left(0).top(0).size_full().children(out);
  }
}

/** The eraser's ring around the pointer at (x, y), shown while the canvas includes it. */
class Ring extends View {
  init(props) {
    this.at = props;
  }

  update(props) {
    this.at = props;
  }

  render() {
    const { id, x, y } = this.at;
    return div().id(id).absolute().left(x - ERASER).top(y - ERASER)
      .size(2 * ERASER).rounded_full().border(1).border_color(hexA(theme().foreground, "80"));
  }
}
