// Caret moves in a text box's string: no gpui or herdr imports, so node can test them
// (test.mjs). Indexes are UTF-16 offsets into the string, always between whole characters.

const cp = (s, i) => s.codePointAt(i) ?? 0;
const size = (c) => (c > 0xffff ? 2 : 1);
// What stays with the character before it: combining accents, the emoji presentation selector
// and skin tones. A zero-width joiner also takes the character after it; flags are pairs.
const mark = (c) => (c >= 0x300 && c <= 0x36f) || c === 0xfe0f || (c >= 0x1f3fb && c <= 0x1f3ff);
const flag = (c) => c >= 0x1f1e6 && c <= 0x1f1ff;
const word = (ch) => /[\p{L}\p{M}\p{N}_]/u.test(ch);

/** The index one character on: a whole emoji (joined, toned or a flag) or accented letter. */
export function next(s, i) {
  if (i >= s.length) return s.length;
  const first = cp(s, i);
  i += size(first);
  if (flag(first) && flag(cp(s, i))) return i + 2;
  while (i < s.length) {
    const c = cp(s, i);
    if (mark(c)) i += size(c);
    else if (c === 0x200d && i + 1 < s.length) i += 1 + size(cp(s, i + 1));
    else break;
  }
  return i;
}

/** The index one character back, found by stepping on from the start of its line. */
export function prev(s, i) {
  if (i <= 0) return 0;
  let at = lineStart(s, i - 1);
  for (let n = next(s, at); n < i; n = next(s, at)) at = n;
  return at;
}

/** One code point back. */
const back = (s, i) => i - (i >= 2 && cp(s, i - 2) > 0xffff ? 2 : 1);

/** The start of the word before i (Option-Left). */
export function wordLeft(s, i) {
  while (i > 0 && !word(String.fromCodePoint(cp(s, back(s, i))))) i = back(s, i);
  while (i > 0 && word(String.fromCodePoint(cp(s, back(s, i))))) i = back(s, i);
  return i;
}

/** The end of the word after i (Option-Right). */
export function wordRight(s, i) {
  while (i < s.length && !word(String.fromCodePoint(cp(s, i)))) i += size(cp(s, i));
  while (i < s.length && word(String.fromCodePoint(cp(s, i)))) i += size(cp(s, i));
  return i;
}

export const lineStart = (s, i) => (i <= 0 ? 0 : s.lastIndexOf("\n", i - 1) + 1);

export function lineEnd(s, i) {
  const n = s.indexOf("\n", i);
  return n < 0 ? s.length : n;
}

/** What Backspace (`before`) or Delete takes from caret c with nothing selected, as [from, to):
 *  a character, a word with Option, or up to the line's edge with Cmd, which at the edge
 *  takes the line break. */
export function deleted(s, c, before, alt, cmd) {
  let end = before ? (cmd ? lineStart(s, c) : alt ? wordLeft(s, c) : prev(s, c))
    : (cmd ? lineEnd(s, c) : alt ? wordRight(s, c) : next(s, c));
  if (end === c) end = before ? prev(s, c) : next(s, c);
  return [Math.min(c, end), Math.max(c, end)];
}

/** Characters between i and the start of its line. */
export const column = (s, i) => Array.from(s.slice(lineStart(s, i), i)).length;

/** The index on the line above (dir -1) or below (dir 1), `col` characters in or at that
 *  line's end; from the first line up goes to the start, from the last line down to the end. */
export function vertical(s, i, dir, col) {
  let from;
  if (dir < 0) {
    const start = lineStart(s, i);
    if (start === 0) return 0;
    from = lineStart(s, start - 1);
  } else {
    const end = lineEnd(s, i);
    if (end === s.length) return s.length;
    from = end + 1;
  }
  return from + Array.from(s.slice(from, lineEnd(s, from))).slice(0, col).join("").length;
}
