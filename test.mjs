// Geometry checks, run with node: `node mods/canvas/test.mjs`. Herdr never loads this file.
import assert from "node:assert/strict";
import { nearLine, nearSegment, lineInRect, overlap, pngSize, smooth, simplify, dedupe, finish, straight, level, trace, circle, box, encode, decode,
  length, head, barbs, HEAD, dump, undump, viewOf, stale, IMAGES } from "./geometry.js";
import { prev, next, wordLeft, wordRight, lineStart, lineEnd, column, vertical, deleted } from "./text.js";

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

// A recording path builder: each method returns a new builder, as the native one may.
function recorder(ops = []) {
  const step = (name) => (...args) => recorder([...ops, [name, ...args]]);
  return { ops, move_to: step("move"), line_to: step("line"), curve_to: step("curve"), arc_to: step("arc"), close: step("close") };
}

// Encoding round-trips to a tenth of a px.
{
  const p = [10.04, -3.26, 12.5, 7.71, -400.333, 9001.05];
  const back = decode(encode(p));
  p.forEach((v, i) => near(back[i], Math.round(v * 10) / 10));
}

// Smoothing keeps the ends and damps a zigzag.
{
  const zig = [];
  for (let i = 0; i < 20; i++) zig.push(i * 4, i % 2 ? 2 : -2);
  const s = smooth(zig);
  assert.deepEqual([s[0], s[1], s.at(-2), s.at(-1)], [zig[0], zig[1], zig.at(-2), zig.at(-1)]);
  for (let i = 2; i < 18; i++) assert.ok(Math.abs(s[2 * i + 1]) < 0.5, `point ${i} still wobbles: ${s[2 * i + 1]}`);
}

// Smoothing keeps a fast circle (few points) its drawn size: a plain moving average pulls
// points toward the inside of a curve, and took a 12-point circle down to 83% of its radius.
{
  const N = 12, R = 100, ring = [];
  for (let i = 0; i <= 3 * N; i++) ring.push(R * Math.cos((2 * Math.PI * i) / N), R * Math.sin((2 * Math.PI * i) / N));
  const s = smooth(ring);
  for (let i = N; i < 2 * N; i++) {
    const r = Math.hypot(s[2 * i], s[2 * i + 1]);
    assert.ok(Math.abs(r - R) < 0.03 * R, `point ${i} of the circle moved to radius ${r.toFixed(1)}, drawn at ${R}`);
  }
}

// Smoothing never pushes a sharp turn past where it was drawn: a hairpin (the top of an "m")
// and a V stay inside the box of the drawn points, so no spike sticks out of the stroke.
{
  const hairpin = [0, 40, 1, 30, 2, 20, 3, 10, 4, 0, 5, 10, 6, 20, 7, 30, 8, 40];
  const vee = [0, 0, 8, 12, 16, 24, 24, 36, 32, 24, 40, 12, 48, 0];
  for (const [name, p] of [["hairpin", hairpin], ["V", vee]]) {
    const b = box(p), s = smooth(p);
    for (let i = 0; i < s.length; i += 2)
      assert.ok(s[i] >= b[0] - 0.5 && s[i] <= b[2] + 0.5 && s[i + 1] >= b[1] - 0.5 && s[i + 1] <= b[3] + 0.5,
        `${name}: point ${i / 2} pushed out to (${s[i].toFixed(1)}, ${s[i + 1].toFixed(1)}), past the drawn box ${b}`);
  }
}

// A corner whose curve would turn tighter than the line is wide is drawn as a sharp corner
// (a dot, no curve): GPUI draws such a tight curve in a thick line with thin spikes. The "a"
// in "Cam" (2026-11-16) went up, 0.9 px left and back down, a curve of radius 0.2 at 6 px wide.
{
  const p = [0, 0, 10, 0, 11, 1.5, 11, 12];
  const thin = trace(recorder(), p, 0, 0, 1).ops;
  assert.ok(thin.some((o) => o[0] === "curve"), "a thin line still curves round the corner");
  const dots = [], wide = trace(recorder(), p, 0, 0, 1, (x, y) => dots.push([x, y]), null, 3).ops;
  assert.ok(!wide.some((o) => o[0] === "curve"), `a 6 px line curved round a tight corner: ${JSON.stringify(wide)}`);
  assert.ok(dots.length >= 1, "the tight corner got no dot");
}

// Simplify drops collinear points and keeps corners.
{
  const l = [0, 0, 10, 0, 20, 0, 30, 0, 30, 10, 30, 20];
  assert.deepEqual(simplify(l, 0.1), [0, 0, 30, 0, 30, 20]);
}

// Dedupe drops near points and keeps the real end.
{
  assert.deepEqual(dedupe([0, 0, 0.1, 0, 5, 0, 5.1, 0], 0.5), [0, 0, 5.1, 0]);
  assert.deepEqual(dedupe([3, 3, 3, 3], 0.5), [3, 3]);
  assert.deepEqual(finish([3, 3, 3, 3], 1), [3, 3]);
}

// Straightness: a wobbly line is straight, a curve or a scribble isn't, a short one isn't.
{
  const wobble = [];
  for (let i = 0; i <= 40; i++) wobble.push(i * 5, Math.sin(i) * 3);
  assert.ok(straight(wobble, 1));
  const arc = [];
  for (let i = 0; i <= 40; i++) arc.push(100 * Math.cos(i / 40 * Math.PI), 100 * Math.sin(i / 40 * Math.PI));
  assert.ok(!straight(arc, 1));
  assert.ok(!straight([0, 0, 200, 0, 0, 0, 200, 0], 1), "back and forth");
  assert.ok(!straight([0, 0, 10, 0], 1), "too short at zoom 1");
  assert.ok(straight([0, 0, 10, 0], 4), "long enough at zoom 4");
}

// Level: near-horizontal and near-vertical lines snap exactly; diagonals stay.
{
  assert.deepEqual(level(0, 0, 100, 5), [100, 0]);
  assert.deepEqual(level(0, 0, -100, 3), [-100, 0]);
  assert.deepEqual(level(0, 0, 4, 100), [0, 100]);
  assert.deepEqual(level(0, 0, 50, 50), [50, 50]);
}

// Trace: starts and ends on the stroke's ends, offset and scaled; corners curve within CORNER.
{
  const p = [10, 10, 110, 10, 110, 110];
  const ops = trace(recorder(), p, 10, 10, 2).ops;
  assert.deepEqual(ops[0], ["move", 0, 0]);
  assert.deepEqual(ops.at(-1), ["line", 200, 200]);
  const curve = ops.find((o) => o[0] === "curve");
  assert.deepEqual(curve, ["curve", 200, 12, 200, 0]); // from 6 px before the corner to 6 px after, at zoom 2
  assert.deepEqual(ops[1], ["line", 188, 0]);
  // Dense points: every corner meets the next, so no zero-length lines between curves.
  const dense = [];
  for (let i = 0; i < 30; i++) dense.push(i * 2, Math.sin(i / 3) * 10);
  const dops = trace(recorder(), dense, 0, 0, 1).ops;
  assert.equal(dops.filter((o) => o[0] === "line").length, 2, "only the half-segments at the two ends are lines");
  assert.ok(dops.every((o) => o.slice(1).every((v) => typeof v !== "number" || Number.isFinite(v))));
  // Two points: a plain line.
  assert.deepEqual(trace(recorder(), [0, 0, 5, 0], 0, 0, 1).ops, [["move", 0, 0], ["line", 5, 0]]);
  // A sharp turn (a V, a hairpin) ends the line at the corner, starts it again there and gets a dot;
  // a right angle and a gentle curve don't.
  const dots = [];
  const vops = trace(recorder(), [0, 0, 10, 40, 20, 0], 0, 0, 1, (x, y) => dots.push([x, y])).ops;
  assert.deepEqual(dots, [[10, 40]]);
  assert.deepEqual(vops, [["move", 0, 0], ["line", 10, 40], ["move", 10, 40], ["line", 20, 0]]);
  const back = [];
  trace(recorder(), [0, 0, 30, 0, 1, 1], 0, 0, 2, (x, y) => back.push([x, y]));
  assert.deepEqual(back, [[60, 0]], "a hairpin's dot sits on the turn, at zoom 2");
  // A gentle turn between long sides (a fast, sparse stroke) curves from midpoint to midpoint.
  const soft = trace(recorder(), [0, 0, 100, 0, 200, 20], 0, 0, 1).ops;
  assert.deepEqual(soft.slice(0, 3), [["move", 0, 0], ["line", 50, 0], ["curve", 150, 10, 100, 0]]);
  const none = [];
  trace(recorder(), p, 10, 10, 2, () => none.push(1));
  trace(recorder(), dense, 0, 0, 1, () => none.push(1));
  assert.equal(none.length, 0);
  // Traced in pieces (as the stroke being drawn is), the same lines and dots as in one go.
  const whole = [], pieces = [];
  const all = trace(recorder(), dense, 0, 0, 1, (x, y) => whole.push([x, y])).ops;
  const part = { stop: 12 };
  const first = trace(recorder(), dense, 0, 0, 1, (x, y) => pieces.push([x, y]), part).ops;
  assert.equal(part.i, 12);
  const rest = trace(recorder(), dense, 0, 0, 1, (x, y) => pieces.push([x, y]), { i: part.i, ex: part.ex, ey: part.ey }).ops;
  assert.deepEqual([...first, ...rest.slice(1)], all, "the second piece starts where the first stopped");
  assert.deepEqual(rest[0], ["move", first.at(-1).at(-4), first.at(-1).at(-3)]);
  assert.deepEqual(pieces, whole);
  // Duplicate points don't divide by zero.
  const dup = trace(recorder(), [0, 0, 5, 0, 5, 0, 10, 0], 0, 0, 1).ops;
  assert.ok(dup.every((o) => o.slice(1).every((v) => typeof v !== "number" || Number.isFinite(v))));
}

// Circle: a closed subpath from builder returns.
{
  const ops = circle(recorder(), 5, 5, 2).ops;
  assert.deepEqual(ops.map((o) => o[0]), ["move", "arc", "arc", "close"]);
}

// Hit tests.
{
  const p = [0, 0, 100, 0, 100, 100];
  assert.ok(nearLine(p, 50, 3, 4));
  assert.ok(!nearLine(p, 50, 10, 4));
  assert.ok(nearLine(p, 103, 50, 4));
  assert.ok(nearLine([5, 5], 7, 5, 3));
  assert.ok(lineInRect([0, 0, 100, 0], [40, -5, 60, 5]), "a long segment through a small box");
  assert.ok(!lineInRect([0, 0, 100, 0], [40, 5, 60, 10]));
  assert.ok(lineInRect([10, 10], [0, 0, 20, 20]));
  assert.ok(!lineInRect([30, 30], [0, 0, 20, 20]));
  // The eraser's sweep from one pointer position to the next: crossing a line between two
  // samples counts, passing beside it doesn't.
  assert.ok(nearSegment([50, -100, 50, 100], 0, 0, 100, 0, 1), "crosses between its ends");
  assert.ok(nearSegment([0, 0, 100, 0], 40, 5, 60, 5, 6), "runs alongside within reach");
  assert.ok(!nearSegment([0, 0, 100, 0], 40, 8, 60, 8, 6));
  assert.ok(nearSegment([110, 3], 0, 0, 100, 0, 11), "a dot near the sweep's end");
  assert.ok(!nearSegment([50, 20, 50, 100], 0, 0, 100, 0, 5), "stops short of the sweep");
  assert.ok(nearSegment([0, 0, 0, 0], 3, 4, 3, 4, 5), "a still pointer on a dot");
  assert.ok(overlap([0, 0, 10, 10], [5, 5, 20, 20]));
  assert.ok(!overlap([0, 0, 10, 10], [11, 0, 20, 10]));
}

// PNG size and density: a 1x1 PNG with a 144 dpi pHYs chunk.
{
  const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const chunk = (type, data) => [...u32(data.length), ...[...type].map((c) => c.charCodeAt(0)), ...data, 0, 0, 0, 0];
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const ihdr = chunk("IHDR", [...u32(640), ...u32(480), 8, 6, 0, 0, 0]);
  const phys = chunk("pHYs", [...u32(5669), ...u32(5669), 1]);
  const got = pngSize(new Uint8Array([...sig, ...ihdr, ...phys, ...chunk("IEND", [])]));
  assert.equal(got.w, 640); assert.equal(got.h, 480); near(got.scale, 0.5, 1e-3);
  assert.equal(pngSize(new Uint8Array([...sig, ...ihdr])).scale, 1);
  assert.equal(pngSize(new Uint8Array([1, 2, 3])), null);
}

// Box and length.
{
  assert.deepEqual(box([1, 2, -3, 8, 4, 0]), [-3, 0, 4, 8]);
  near(length([0, 0, 3, 4, 3, 10]), 11);
}

// Arrow heads: two barbs HEAD degrees off the shaft, max(10, 4w) long, meeting at the tip.
{
  const h = head([0, 0, 100, 0], 2);
  assert.deepEqual([h[2], h[3]], [100, 0]);
  near(Math.hypot(h[0] - 100, h[1]), 10);
  near(Math.hypot(h[4] - 100, h[5]), 10);
  near(Math.atan2(Math.abs(h[1]), 100 - h[0]) * 180 / Math.PI, HEAD);
  assert.ok(h[1] * h[5] < 0, "one barb each side");
  near(Math.hypot(...head([0, 0, 0, 50], 6).slice(0, 2).map((v, i) => v - [0, 50][i])), 24);
  // A diagonal arrow pointing up-left: barbs sit back toward the tail.
  const d = head([10, 10, 0, 0], 2);
  assert.ok(d[0] > 0 && d[1] > 0 && d[4] > 0 && d[5] > 0);
  // Zero length doesn't divide by zero.
  assert.ok(head([5, 5, 5, 5], 2).every(Number.isFinite));
  // Painted as two straight lines into the tip, never curved, with a dot at each barb end.
  const [line, cap] = barbs(recorder(), recorder(), h, 0, 0, 2, 1);
  assert.deepEqual(line.ops.map((o) => o[0]), ["move", "line", "move", "line"]);
  assert.deepEqual([line.ops[1].slice(1), line.ops[3].slice(1)], [[200, 0], [200, 0]]);
  near(line.ops[0][1], h[0] * 2);
  assert.deepEqual(cap.ops.map((o) => o[0]), ["move", "arc", "arc", "close", "move", "arc", "arc", "close"]);
}

// Caret moves: whole characters, words, lines.
{
  const e = "a😀b";
  assert.equal(next(e, 1), 3, "steps over a surrogate pair");
  assert.equal(prev(e, 3), 1);
  assert.equal(prev(e, 0), 0);
  assert.equal(next(e, 4), 4);
  const s = "hello, big world";
  assert.equal(wordLeft(s, 16), 11);
  assert.equal(wordLeft(s, 11), 7);
  assert.equal(wordLeft(s, 3), 0);
  assert.equal(wordRight(s, 0), 5);
  assert.equal(wordRight(s, 5), 10);
  assert.equal(wordRight(s, 12), 16);
  assert.equal(wordLeft("ab 😀😀", 7), 0, "emoji aren't words, and aren't split");
  const t = "abcd\nx\nabcdef";
  assert.equal(lineStart(t, 6), 5);
  assert.equal(lineStart(t, 5), 5);
  assert.equal(lineStart(t, 0), 0);
  assert.equal(lineStart("\nx", 0), 0);
  assert.equal(lineEnd(t, 1), 4);
  assert.equal(lineEnd(t, 8), 13);
  assert.equal(column(t, 3), 3);
  assert.equal(column("😀b", 3), 2, "columns count characters");
  // Down from column 3: the short line's end, then column 3 again below it.
  assert.equal(vertical(t, 3, 1, 3), 6);
  assert.equal(vertical(t, 6, 1, 3), 10);
  assert.equal(vertical(t, 10, -1, 3), 6);
  assert.equal(vertical(t, 2, -1, 2), 0, "up from the first line: the start");
  assert.equal(vertical(t, 9, 1, 2), t.length, "down from the last line: the end");
  assert.equal(vertical("😀😀\nab", 5, -1, 1), 2, "keeps surrogate pairs whole");
  const math = "𝐚𝐛 c";  // letters outside the BMP
  assert.equal(wordRight(math, 0), 4, "a word of surrogate pairs ends after them");
  assert.equal(wordLeft(math, 4), 0);
}

// One step, one visible character: emoji with a skin tone, flags, a joined family, an accent.
{
  for (const ch of ["👍🏽", "🇫🇷", "👨‍👩‍👧", "e\u0301", "❤️"]) {
    const s = `a${ch}b`;
    assert.equal(next(s, 1), 1 + ch.length, `next over ${ch}`);
    assert.equal(prev(s, 1 + ch.length), 1, `prev over ${ch}`);
  }
  const flags = "🇫🇷🇩🇪";
  assert.equal(next(flags, 0), 4, "flags pair up");
  assert.equal(prev(flags, 8), 4);
  assert.equal(prev("x\n👍🏽", 6), 2, "steps back within its own line");
}

// Backspace and Delete with nothing selected: a character, a word, or to the line's edge.
{
  const s = "ab cd\nef";
  assert.deepEqual(deleted(s, 5, true, false, false), [4, 5]);
  assert.deepEqual(deleted(s, 5, true, true, false), [3, 5], "Option: the word");
  assert.deepEqual(deleted(s, 5, true, false, true), [0, 5], "Cmd: to the line's start");
  assert.deepEqual(deleted(s, 6, true, false, true), [5, 6], "Cmd at a line's start takes the line break");
  assert.deepEqual(deleted(s, 5, false, false, true), [5, 6], "Cmd-Delete at a line's end takes the line break");
  assert.deepEqual(deleted(s, 0, false, false, true), [0, 5]);
  assert.deepEqual(deleted("a👍🏽", 5, true, false, false), [1, 5], "a whole emoji");
  assert.deepEqual(deleted(s, 0, true, false, true), [0, 0], "nothing before the start");
}

// Saved form: items round-trip, an arrow keeps its flag, and pasted junk is checked.
{
  const items = [
    { k: "s", c: "#ff7b72", w: 3.5, p: [10, 20, 30.04, 40], a: 1 },
    { k: "s", c: "fg", w: 2, p: [0, 0, 5, 5, 9, 1], a: 0 },
    { k: "t", x: 4, y: 5, s: 24, c: "fg", v: "hi\nthere" },
    { k: "t", x: 4, y: 5, s: 24, c: "fg", v: "  " },
    { k: "i", x: 1, y: 2, w: 30, h: 40, src: `${IMAGES}/0123456789abcdef01234567.png` },
  ];
  const d = JSON.parse(JSON.stringify(dump(items, -10, -20)));
  assert.equal(d.strokes[0].a, 1);
  assert.ok(!("a" in d.strokes[1]), "plain strokes save as before");
  assert.equal(d.texts.length, 1, "blank text isn't kept");
  const got = undump(d, 24);
  assert.deepEqual(got.strokes[0], { c: "#ff7b72", w: 3.5, p: [0, 0, 20, 20], a: 1 });
  assert.deepEqual(got.strokes[1].p, [-10, -20, -5, -15, -1, -19]);
  assert.deepEqual(got.texts, [{ x: -6, y: -15, s: 24, c: "fg", v: "hi\nthere" }]);
  assert.deepEqual(got.images, [{ x: -9, y: -18, w: 30, h: 40, src: items[4].src }]);
  const bad = undump({
    strokes: [{ c: 5, w: "x", p: [1, 2, 3, 4, 5, 6], a: 1 }, { p: [1, NaN] }, { p: "12" }, null],
    texts: [{ v: 7 }, { v: "ok", x: "3", y: "nope", s: -2, c: {} }],
    images: [{ src: "/etc/passwd" }, { src: `${IMAGES}/../drawing.json` }, { src: `${IMAGES}/a.png`, w: "0" }],
  }, 24);
  assert.deepEqual(bad.strokes, [{ c: "fg", w: 2, p: [0.1, 0.2, 0.4, 0.6, 0.9, 1.2], a: 0 }], "an arrow needs exactly two points");
  assert.deepEqual(bad.texts, [{ x: 3, y: 0, s: 24, c: "fg", v: "ok" }]);
  assert.deepEqual(bad.images, [{ x: 0, y: 0, w: 100, h: 100, src: `${IMAGES}/a.png` }]);
  assert.throws(() => undump(null, 24));
  assert.throws(() => undump({ strokes: {} }, 24));
  assert.deepEqual(undump({}, 24), { strokes: [], texts: [], images: [] });
  // Anything but an object would load as an empty drawing, and saving would replace the file.
  for (const d of [5, "x", [], true]) assert.throws(() => undump(d, 24), `${JSON.stringify(d)}`);
  assert.throws(() => undump({ version: 3 }, 24), "saved by a newer version");
  assert.deepEqual(undump({ version: 2 }, 24).strokes, []);
  // Colors are "fg" or #hex; sizes stay within reason.
  const odd = undump({
    strokes: [{ c: "red", w: 1e9, p: [0, 0] }, { c: "#ABC", w: 0.01, p: [0, 0] }, { c: "#11223344", w: 3, p: [0, 0] }, { c: "#12345", p: [0, 0] }],
    texts: [{ v: "a", c: "url(x)", s: 1e6 }, { v: "b", c: "#a1b2c3", s: 0.5 }],
  }, 24);
  assert.deepEqual(odd.strokes.map((s) => [s.c, s.w]), [["fg", 200], ["#ABC", 0.5], ["#11223344", 3], ["fg", 2]]);
  assert.deepEqual(odd.texts.map((t) => [t.c, t.s]), [["fg", 1000], ["#a1b2c3", 2]]);
}

// The saved view: a bad zoom would hang the grid, so it's checked.
{
  const zoom = [0.1, 8];
  assert.deepEqual(viewOf({ x: 5, y: -3, z: 2 }, zoom), { x: 5, y: -3, z: 2 });
  assert.deepEqual(viewOf({ x: 5, y: -3, z: -1 }, zoom), { x: 0, y: 0, z: 1 }, "negative zoom");
  assert.deepEqual(viewOf(JSON.parse('{"x":1,"y":2,"z":1e999}'), zoom), { x: 1, y: 2, z: 8 }, "infinite zoom");
  assert.deepEqual(viewOf({ x: 1, y: 2, z: 0.001 }, zoom), { x: 1, y: 2, z: 0.1 });
  assert.deepEqual(viewOf({ x: "a", y: 2, z: 1 }, zoom), { x: 0, y: 0, z: 1 });
  assert.deepEqual(viewOf(undefined, zoom), { x: 0, y: 0, z: 1 });
}

// Tidying the images folder: what goes and what stays.
{
  const used = new Set(["0123456789abcdef01234567.png"]), now = 1_000_000;
  assert.ok(!stale("0123456789abcdef01234567.png", used, now), "named by the drawing or a .bad copy");
  assert.ok(stale("fedcba9876543210fedcba98.png", used, now), "named by nothing");
  assert.ok(!stale(`paste-${now - 30000}.tmp`, used, now), "a young temp file");
  assert.ok(stale(`paste-${now - 61000}.tmp`, used, now));
  assert.ok(stale(`drop-${now - 61000}.png`, used, now));
  assert.ok(!stale("notes.txt", used, now) && !stale("photo.png", used, now), "files the canvas didn't make");
}


// The minimap fits the box inside its padding, centered, and maps back to the world.
{
  const { miniFit } = await import("./geometry.js");
  const b = [-100, 50, 900, 550], m = miniFit(b, 180, 120, 8);
  assert.ok(m.s <= 164 / 1000 && m.s > 164 / 1000 / 2 ** (1 / 8), `scale ${m.s}`);
  near(m.x + ((b[0] + b[2]) / 2) * m.s, 90);
  near(m.y + ((b[1] + b[3]) / 2) * m.s, 60);
  assert.ok(m.x + b[0] * m.s >= 8 && m.x + b[2] * m.s <= 172);
  // A slightly bigger box keeps the same scale.
  assert.equal(miniFit([-100, 50, 902, 550], 180, 120, 8).s, m.s);
}

// The minimap takes the box's shape inside its limits.
{
  const { miniSize } = await import("./geometry.js");
  assert.deepEqual(miniSize([0, 0, 1000, 500], [200, 140], [110, 80], 10), [200, 110]);
  assert.deepEqual(miniSize([0, 0, 500, 1000], [200, 140], [110, 80], 10), [110, 140]);
  assert.deepEqual(miniSize([0, 0, 10, 1000], [200, 140], [110, 80], 10), [110, 140]);
}



console.log("canvas geometry: all checks passed");
