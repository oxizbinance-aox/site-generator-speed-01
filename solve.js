// site-generator-speed-01: fresh, fast reimplementation of the makefun-site 1.0.0
// build(input) contract, written from the README + reference behaviour.
// Dependency-free ES module. run(input) returns the output tree (path -> text),
// byte-identical to the reference for every input.
//
// Speed strategy: no regex in hot paths (indexOf / charCodeAt scans), plain-text
// runs are appended unescaped, inline rendering works on string ranges instead
// of slicing, Markdown is lexed+rendered in one line-walking pass, front matter
// is scanned line by line without splitting the whole source, slugify has an
// ASCII fast path plus a cache, word counting is a manual whitespace scan, and
// all output is built with array push + join.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const RESERVED = ['posts', 'tags', 'page'];
const KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** JS \s whitespace, by code unit. */
function isWS(c) {
  return c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 32 || c === 160 || c === 5760 ||
    (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279;
}

// ---------------------------------------------------------------- text helpers

const HTML_RE = /[&<>"']/g;
const HTML_ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
// One class for every inline-special character: structural (\ ` * [) and HTML
// (& < > " '). A single exec finds the next one of either kind, so a plain
// run between two specials needs no escaping scan at all.
const MARK_RE = /[\\`*\[&<>"']/g;

/** Escape & < > " ' in `s`; returns `s` unchanged when it holds none of them. */
function escStr(s) {
  HTML_RE.lastIndex = 0;
  let m = HTML_RE.exec(s);
  if (m === null) return s;
  const parts = [];
  let start = 0;
  while (m !== null) {
    if (m.index > start) parts.push(s.slice(start, m.index));
    parts.push(HTML_ENT[m[0]]);
    start = m.index + 1;
    m = HTML_RE.exec(s);
  }
  if (s.length > start) parts.push(s.slice(start));
  return parts.join('');
}

/** Escape the range s[lo,hi) into the `out` array. */
function escInto(s, lo, hi, out) {
  HTML_RE.lastIndex = lo;
  let m = HTML_RE.exec(s);
  if (m === null || m.index >= hi) {
    if (hi > lo) out.push(s.slice(lo, hi));
    return;
  }
  let start = lo;
  while (m !== null && m.index < hi) {
    if (m.index > start) out.push(s.slice(start, m.index));
    out.push(HTML_ENT[m[0]]);
    start = m.index + 1;
    m = HTML_RE.exec(s);
  }
  if (hi > start) out.push(s.slice(start, hi));
}

const slugCache = new Map();

/** The slug of `text` (see README "Text"). ASCII fast path skips normalize. */
function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  const parts = [];
  let gap = false;
  if (ascii) {
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      let keep = -1;
      if (c >= 65 && c <= 90) keep = c + 32;
      else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
      if (keep === -1) {
        gap = parts.length > 0;
        continue;
      }
      if (gap) parts.push('-');
      gap = false;
      parts.push(String.fromCharCode(keep));
    }
  } else {
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) {
        gap = parts.length > 0;
        continue;
      }
      if (gap) parts.push('-');
      gap = false;
      parts.push(keep);
    }
  }
  let out = parts.join('').slice(0, 64);
  let e = out.length;
  while (e > 0 && out.charCodeAt(e - 1) === 45) e--;
  if (e !== out.length) out = out.slice(0, e);
  if (out === '') out = 'untitled';
  slugCache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = slug + '-' + n;
  taken.add(out);
  return out;
}

/** "2026-11-09" -> "9 November 2026", from the string alone. */
function longDate(date) {
  return (date.charCodeAt(8) - 48) * 10 + (date.charCodeAt(9) - 48) + ' ' +
    MONTHS[(date.charCodeAt(5) - 48) * 10 + (date.charCodeAt(6) - 48) - 1] + ' ' + date.slice(0, 4);
}

const WS_TABLE = new Uint8Array(65536);
for (const w of [9, 10, 11, 12, 13, 32, 160, 5760, 8232, 8233, 8239, 8287, 12288, 65279]) WS_TABLE[w] = 1;
for (let w = 8192; w <= 8202; w++) WS_TABLE[w] = 1;

/** Runs of non-whitespace characters in `text`. */
function wordsOf(text) {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (WS_TABLE[text.charCodeAt(i)]) inWord = false;
    else if (!inWord) { inWord = true; count++; }
  }
  return count;
}

/** `s` with every \r\n and lone \r made \n (fast path when there is no \r). */
function normalizeNL(s) {
  if (s.indexOf('\r') === -1) return s;
  const parts = [];
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 13) {
      parts.push(s.slice(start, i));
      parts.push('\n');
      start = (i + 1 < s.length && s.charCodeAt(i + 1) === 10) ? i + 2 : i + 1;
      i = start - 1;
    }
  }
  parts.push(s.slice(start));
  return parts.join('');
}

// ---------------------------------------------------------------- front matter

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function isDigit(c) { return c >= 48 && c <= 57; }

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: 'key "' + key + '": ' + s.error } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          if (!isDigit(raw.charCodeAt(i))) { ok = false; break; }
        }
      }
      const y = ok ? (raw.charCodeAt(0) - 48) * 1000 + (raw.charCodeAt(1) - 48) * 100 + (raw.charCodeAt(2) - 48) * 10 + (raw.charCodeAt(3) - 48) : 0;
      const mo = ok ? (raw.charCodeAt(5) - 48) * 10 + (raw.charCodeAt(6) - 48) : 0;
      const d = ok ? (raw.charCodeAt(8) - 48) * 10 + (raw.charCodeAt(9) - 48) : 0;
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const rawTags = inner.split(',');
      const tags = new Array(rawTags.length);
      for (let i = 0; i < rawTags.length; i++) {
        const t = rawTags[i].trim();
        if (t === '' || t.indexOf('"') !== -1 || t.indexOf('[') !== -1 || t.indexOf(']') !== -1) {
          return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
        tags[i] = t;
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw.length < 1) return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return { error: 'key "layout": not a template name' };
      }
      return { value: raw };
    }
    case 'slug': {
      if (raw.length < 1 || raw.length > 64) return { error: 'key "slug": not a slug' };
      let i = 0;
      const L = raw.length;
      while (i < L) {
        let j = i;
        while (j < L) {
          const c = raw.charCodeAt(j);
          if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) j++;
          else break;
        }
        if (j === i) return { error: 'key "slug": not a slug' };
        i = j;
        if (i < L) {
          if (raw.charCodeAt(i) !== 45) return { error: 'key "slug": not a slug' };
          i++;
          if (i >= L) return { error: 'key "slug": not a slug' };
        }
      }
      return { value: raw };
    }
    default:
      return { error: 'unknown key "' + key + '"' };
  }
}

/** { data, body } or { error }: scans lines by indexOf, never splits the source. */
function parseFrontMatter(text) {
  if (text.length < 3 || text.charCodeAt(0) !== 45 || text.charCodeAt(1) !== 45 || text.charCodeAt(2) !== 45 ||
      (text.length > 3 && text.charCodeAt(3) !== 10)) {
    return { error: 'no front matter' };
  }
  if (text.length === 3) return { error: 'the front matter is not closed' };
  const data = {};
  let pos = 4;
  let lineNo = 2;
  for (;;) {
    const e = text.indexOf('\n', pos);
    const line = e === -1 ? text.slice(pos) : text.slice(pos, e);
    if (line === '---') {
      if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
      return { data, body: e === -1 ? '' : text.slice(e + 1) };
    }
    if (line.length > 0 && line.charCodeAt(0) !== 35) {
      let blank = true;
      for (let i = 0; i < line.length; i++) {
        const c = line.charCodeAt(i);
        if (c !== 32 && c !== 9) { blank = false; break; }
      }
      if (!blank) {
        let k = 0;
        while (k < line.length) {
          const c = line.charCodeAt(k);
          if ((c >= 97 && c <= 122) || c === 95) k++;
          else break;
        }
        if (k === 0 || line.charCodeAt(k) !== 58) return { error: 'line ' + lineNo + ' is not "key: value"' };
        let raw;
        if (k + 1 === line.length) raw = '';
        else if (line.charCodeAt(k + 1) === 32) raw = line.slice(k + 2);
        else return { error: 'line ' + lineNo + ' is not "key: value"' };
        let rl = raw.length;
        while (rl > 0) {
          const c = raw.charCodeAt(rl - 1);
          if (c === 32 || c === 9) rl--;
          else break;
        }
        if (rl !== raw.length) raw = raw.slice(0, rl);
        const key = line.slice(0, k);
        if (!KEYS.has(key)) return { error: 'unknown key "' + key + '"' };
        if (Object.hasOwn(data, key)) return { error: 'key "' + key + '" is given twice' };
        if (raw === '') return { error: 'key "' + key + '" has no value' };
        const v = valueOf(key, raw);
        if ('error' in v) return v;
        data[key] = v.value;
      }
    }
    if (e === -1) return { error: 'the front matter is not closed' };
    pos = e + 1;
    lineNo++;
  }
}

// ---------------------------------------------------------------- markdown

// Block kinds: 0 blank, 1 fence, 2 heading, 3 hr, 4 quote, 5 bullet, 6 ordered, 7 paragraph.
// One first-character dispatch classifies the line src[s,e); payload in scratch vars.
let _bkLang = '';
let _bkDepth = 0;
let _bkTextStart = 0;
let _bkTextEnd = 0;
let _bkOrd = 1;

function blockKindAt(src, s, e) {
  if (s === e) return 0;
  const c0 = src.charCodeAt(s);
  if (c0 === 32 || c0 === 9) {
    for (let i = s; i < e; i++) {
      const c = src.charCodeAt(i);
      if (c !== 32 && c !== 9) return 7;
    }
    return 0;
  }
  if (c0 === 96) {
    if (e - s >= 3 && src.charCodeAt(s + 1) === 96 && src.charCodeAt(s + 2) === 96) {
      let i = s + 3;
      while (i < e && isLangChar(src.charCodeAt(i))) i++;
      let ok = true;
      for (let j = i; j < e; j++) {
        const c = src.charCodeAt(j);
        if (c !== 32 && c !== 9) { ok = false; break; }
      }
      if (ok) {
        _bkLang = src.slice(s + 3, i);
        return 1;
      }
    }
    return 7;
  }
  if (c0 === 35) {
    let k = s;
    while (k < e && src.charCodeAt(k) === 35) k++;
    const depth = k - s;
    if (depth >= 1 && depth <= 6 && k < e) {
      const c = src.charCodeAt(k);
      if (c === 32 || c === 9) {
        let ts = k;
        while (ts < e && (src.charCodeAt(ts) === 32 || src.charCodeAt(ts) === 9)) ts++;
        let te = e;
        while (te > ts && (src.charCodeAt(te - 1) === 32 || src.charCodeAt(te - 1) === 9)) te--;
        if (te > ts) {
          _bkDepth = depth;
          _bkTextStart = ts;
          _bkTextEnd = te;
          return 2;
        }
      }
    }
    return 7;
  }
  if (c0 === 45 || c0 === 42) {
    if (e - s >= 3 && src.charCodeAt(s + 1) === c0 && src.charCodeAt(s + 2) === c0) {
      let ok = true;
      for (let j = s + 3; j < e; j++) {
        const c = src.charCodeAt(j);
        if (c !== 32 && c !== 9) { ok = false; break; }
      }
      if (ok) return 3;
    }
    if (e - s >= 2 && src.charCodeAt(s + 1) === 32) return 5;
    return 7;
  }
  if (c0 === 62) return 4;
  if (c0 >= 48 && c0 <= 57) {
    let j = s;
    while (j < e && j < s + 9 && isDigit(src.charCodeAt(j))) j++;
    if (j > s && src.charCodeAt(j) === 46 && src.charCodeAt(j + 1) === 32) {
      let v = 0;
      for (let k = s; k < j; k++) v = v * 10 + (src.charCodeAt(k) - 48);
      _bkOrd = v;
      return 6;
    }
    return 7;
  }
  return 7;
}

function isLangChar(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;
}

/** Trimmed [start, end) of the range src[s,e) (spaces/tabs at either end). */
function trimRange(src, s, e) {
  while (s < e && (src.charCodeAt(s) === 32 || src.charCodeAt(s) === 9)) s++;
  while (e > s && (src.charCodeAt(e - 1) === 32 || src.charCodeAt(e - 1) === 9)) e--;
  return [s, e];
}

/** A list item's trimmed [start, end) in src[s,e), or null. */
function listItemAt(src, s, e, isOrdered) {
  if (isOrdered) {
    let j = s;
    while (j < e && j < s + 9 && isDigit(src.charCodeAt(j))) j++;
    if (j > s && src.charCodeAt(j) === 46 && src.charCodeAt(j + 1) === 32) return trimRange(src, j + 2, e);
    return null;
  }
  if ((src.charCodeAt(s) === 45 || src.charCodeAt(s) === 42) && src.charCodeAt(s + 1) === 32) return trimRange(src, s + 2, e);
  return null;
}

function fenceCloseAt(src, s, e) {
  if (e - s < 3 || src.charCodeAt(s) !== 96 || src.charCodeAt(s + 1) !== 96 || src.charCodeAt(s + 2) !== 96) return false;
  for (let j = s + 3; j < e; j++) {
    const c = src.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Two or more spaces then a non-whitespace character in src[s,e). */
function isContinuedAt(src, s, e) {
  let i = s;
  while (i < e && src.charCodeAt(i) === 32) i++;
  return i - s >= 2 && i < e && !isWS(src.charCodeAt(i));
}

/** Whether the line src[s,e) ends a paragraph: blank, fence, heading or hr.
 *  Most continuation lines open on a letter, which can end a paragraph in no
 *  way, so only the ambiguous first characters pay for a full classify. */
function endsParaAt(src, s, e) {
  if (s === e) return true;
  const c = src.charCodeAt(s);
  if (c === 32 || c === 9) {
    for (let i = s; i < e; i++) {
      const d = src.charCodeAt(i);
      if (d !== 32 && d !== 9) return false;
    }
    return true;
  }
  if (c === 96 || c === 35 || c === 45 || c === 42) return blockKindAt(src, s, e) <= 3;
  return false;
}

/** First index >= `from` where `what` occurs outside a backslash escape, or -1. */
function findUnescaped(s, what, from, hi) {
  const wl = what.length;
  for (let j = from; j + wl <= hi; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < hi && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (wl === 1 ? s[j] === what : s.startsWith(what, j)) return j;
  }
  return -1;
}

/** First single `*` from `from` (one whose run is not `**`), outside an escape, or -1. */
function findSingleStar(s, from, hi) {
  for (let j = from; j < hi; j++) {
    const ch = s[j];
    if (ch === '\\' && j + 1 < hi && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (ch !== '*') continue;
    if (j + 1 < hi && s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** Render inline markup of s[lo,hi) into `out`, resolving links through `link`.
 *  One regex scan finds the next special character of either kind; plain runs
 *  between specials are pushed verbatim (they hold no special by
 *  construction). Every lookup sets MARK_RE.lastIndex first, so recursion
 *  through strong/em/link text is safe. */
function inlineInto(s, lo, hi, link, out) {
  let i = lo;
  while (i < hi) {
    let j;
    if (hi - i < 48) {
      // Short range: a direct scan beats a regex exec's setup cost.
      j = -1;
      for (let k = i; k < hi; k++) {
        const d = s.charCodeAt(k);
        if (d === 92 || d === 96 || d === 42 || d === 91 || d === 38 || d === 60 || d === 62 || d === 34 || d === 39) { j = k; break; }
      }
    } else {
      MARK_RE.lastIndex = i;
      const m = MARK_RE.exec(s);
      j = (m === null || m.index >= hi) ? -1 : m.index;
    }
    const segEnd = j === -1 ? hi : j;
    if (segEnd > i) {
      out.push(s.slice(i, segEnd));
      i = segEnd;
    }
    if (j === -1) break;
    const c = s.charCodeAt(j);
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) {
      out.push(c === 38 ? '&amp;' : c === 60 ? '&lt;' : c === 62 ? '&gt;' : c === 34 ? '&quot;' : '&#39;');
      i = j + 1;
      continue;
    }
    if (c === 92) {
      if (j + 1 < hi && ESCAPABLE.has(s[j + 1])) {
        const n = s[j + 1];
        out.push(n === '>' ? '&gt;' : n);
        i = j + 2;
      } else {
        out.push('\\');
        i = j + 1;
      }
      continue;
    }
    if (c === 96) {
      const k = s.indexOf('`', j + 1);
      if (k !== -1 && k < hi && k > j + 1) {
        out.push('<code>');
        escInto(s, j + 1, k, out);
        out.push('</code>');
        i = k + 1;
      } else {
        out.push('`');
        i = j + 1;
      }
      continue;
    }
    if (c === 42) {
      if (j + 1 < hi && s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2, hi);
        if (k > j + 2) {
          out.push('<strong>');
          inlineInto(s, j + 2, k, link, out);
          out.push('</strong>');
          i = k + 2;
        } else {
          out.push('**');
          i = j + 2;
        }
        continue;
      }
      const k = findSingleStar(s, j + 1, hi);
      if (k > j + 1) {
        out.push('<em>');
        inlineInto(s, j + 1, k, link, out);
        out.push('</em>');
        i = k + 1;
      } else {
        out.push('*');
        i = j + 1;
      }
      continue;
    }
    // '['
    const k = findUnescaped(s, ']', j + 1, hi);
    let m2 = -1;
    if (k !== -1 && k + 1 < hi && s[k + 1] === '(') {
      m2 = s.indexOf(')', k + 2);
      if (m2 >= hi) m2 = -1;
    }
    if (m2 !== -1) {
      const target = s.slice(k + 2, m2);
      if (target !== '' && !/\s/.test(target)) {
        out.push('<a href="', escStr(link(target)), '">');
        inlineInto(s, j + 1, k, link, out);
        out.push('</a>');
        i = m2 + 1;
        continue;
      }
    }
    out.push('[');
    i = j + 1;
  }
}

/** Render a Markdown body: { html, toc, excerpt }. One pass over the source
 *  string, working on [start, end) line ranges — lines are never sliced
 *  except where content must be copied (headings for slugify, multi-line
 *  joins). */
function renderMarkdown(src, link) {
  const n = src.length;
  const blocks = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let p = 0;
  const lineEnd = (pos) => {
    const e = src.indexOf('\n', pos);
    return e === -1 ? n : e;
  };
  while (p < n) {
    const e = lineEnd(p);
    const kind = blockKindAt(src, p, e);
    if (kind === 0) {
      p = e + 1;
      continue;
    }
    if (kind === 1) {
      const lang = _bkLang;
      p = e + 1;
      const parts = ['<pre><code', lang === '' ? '' : ' class="language-' + escStr(lang) + '"', '>'];
      let closed = false;
      while (p < n) {
        const e2 = lineEnd(p);
        if (fenceCloseAt(src, p, e2)) {
          p = e2 + 1;
          closed = true;
          break;
        }
        escInto(src, p, e2, parts);
        parts.push('\n');
        p = e2 + 1;
      }
      // An unclosed fence running to a source that ends in "\n" holds one
      // last empty body line (split's trailing ""), which renders as "\n".
      if (!closed && src.charCodeAt(n - 1) === 10) parts.push('\n');
      parts.push('</code></pre>');
      blocks.push(parts.join(''));
      continue;
    }
    if (kind === 2) {
      const depth = _bkDepth;
      const text = src.slice(_bkTextStart, _bkTextEnd);
      const id = uniqueSlug(slugify(text), ids);
      const inner = [];
      inlineInto(src, _bkTextStart, _bkTextEnd, link, inner);
      const html = inner.join('');
      blocks.push('<h' + depth + ' id="' + id + '">' + html + '</h' + depth + '>');
      if (depth === 2 || depth === 3) toc.push({ level: depth, id, html });
      p = e + 1;
      continue;
    }
    if (kind === 3) {
      blocks.push('<hr>');
      p = e + 1;
      continue;
    }
    if (kind === 4) {
      const ranges = [];
      while (p < n) {
        const e2 = lineEnd(p);
        if (src.charCodeAt(p) !== 62) break;
        let s2 = p + 1;
        if (s2 < e2 && src.charCodeAt(s2) === 32) s2++;
        const tr = trimRange(src, s2, e2);
        if (tr[1] > tr[0]) ranges.push(tr);
        p = e2 + 1;
      }
      if (ranges.length === 0) blocks.push('<blockquote>\n</blockquote>');
      else if (ranges.length === 1) {
        const parts = ['<blockquote>\n<p>'];
        inlineInto(src, ranges[0][0], ranges[0][1], link, parts);
        parts.push('</p>\n</blockquote>');
        blocks.push(parts.join(''));
      } else {
        const joined = ranges.map((r) => src.slice(r[0], r[1])).join('\n');
        const parts = ['<blockquote>\n<p>'];
        inlineInto(joined, 0, joined.length, link, parts);
        parts.push('</p>\n</blockquote>');
        blocks.push(parts.join(''));
      }
      continue;
    }
    if (kind === 5 || kind === 6) {
      const isO = kind === 6;
      const ordStart = isO ? _bkOrd : 1;
      const items = [];
      let cur = null;
      while (p < n) {
        const e2 = lineEnd(p);
        const mrange = listItemAt(src, p, e2, isO);
        if (mrange !== null) {
          cur = [mrange];
          items.push(cur);
          p = e2 + 1;
        } else if (cur !== null && isContinuedAt(src, p, e2)) {
          cur.push(trimRange(src, p, e2));
          p = e2 + 1;
        } else break;
      }
      const parts = [];
      parts.push(isO && ordStart !== 1 ? '<ol start="' + ordStart + '">' : isO ? '<ol>' : '<ul>');
      parts.push('\n');
      for (const it of items) {
        parts.push('<li>');
        if (it.length === 1) inlineInto(src, it[0][0], it[0][1], link, parts);
        else {
          const joined = it.map((r) => src.slice(r[0], r[1])).join('\n');
          inlineInto(joined, 0, joined.length, link, parts);
        }
        parts.push('</li>\n');
      }
      parts.push(isO ? '</ol>' : '</ul>');
      blocks.push(parts.join(''));
      continue;
    }
    // Paragraph: lines up to a blank / fence / heading / hr line. When no line
    // needs trimming, the paragraph text is the source range itself.
    let lastEnd = e;
    let clean = src.charCodeAt(p) !== 32 && src.charCodeAt(p) !== 9 &&
      src.charCodeAt(e - 1) !== 32 && src.charCodeAt(e - 1) !== 9;
    let q = e + 1;
    while (q < n) {
      const e2 = lineEnd(q);
      if (endsParaAt(src, q, e2)) break;
      if (src.charCodeAt(q) === 32 || src.charCodeAt(q) === 9 ||
          src.charCodeAt(e2 - 1) === 32 || src.charCodeAt(e2 - 1) === 9) clean = false;
      lastEnd = e2;
      q = e2 + 1;
    }
    const inner = [];
    if (clean) {
      inlineInto(src, p, lastEnd, link, inner);
    } else {
      // Re-walk the lines, trimming each into ranges and joining.
      const ranges = [];
      let r = p;
      while (r <= lastEnd) {
        const e2 = lineEnd(r);
        ranges.push(trimRange(src, r, Math.min(e2, lastEnd)));
        r = e2 + 1;
      }
      const joined = ranges.map((rg) => src.slice(rg[0], rg[1])).join('\n');
      inlineInto(joined, 0, joined.length, link, inner);
    }
    const html = inner.join('');
    if (excerpt === null) excerpt = html;
    blocks.push('<p>' + html + '</p>');
    p = lastEnd + 1;
  }
  return { html: blocks.length === 0 ? '' : blocks.join('\n') + '\n', toc, excerpt: excerpt === null ? '' : excerpt };
}

// ---------------------------------------------------------------- templates

class TemplateError extends Error {}

function pathOf(name, text) {
  const parts = text.split('.');
  for (const seg of parts) {
    if (seg.length === 0) throw new TemplateError('template "' + name + '": ' + JSON.stringify(text) + ' is not a path');
    const c0 = seg.charCodeAt(0);
    if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122) || c0 === 95)) {
      throw new TemplateError('template "' + name + '": ' + JSON.stringify(text) + ' is not a path');
    }
    for (let i = 1; i < seg.length; i++) {
      const c = seg.charCodeAt(i);
      if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95)) {
        throw new TemplateError('template "' + name + '": ' + JSON.stringify(text) + ' is not a path');
      }
    }
  }
  return parts;
}

function isSpacesOnly(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError('template "' + name + '": a ' + (raw ? '{{{' : '{{') + ' is not closed');
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError('template "' + name + '": a {% is not closed');
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = isSpacesOnly(src.slice(lineStart, open)) && isSpacesOnly(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function isNameStart(c) { return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95; }
function isNameChar(c) { return isNameStart(c) || (c >= 48 && c <= 57); }

/** Parse a `for` tag body, or null when it is not one. */
function parseFor(tag) {
  if (!tag.startsWith('for ')) return null;
  let i = 4;
  if (i >= tag.length || !isNameStart(tag.charCodeAt(i))) return null;
  const ns = i;
  i++;
  while (i < tag.length && isNameChar(tag.charCodeAt(i))) i++;
  const varName = tag.slice(ns, i);
  if (tag.slice(i, i + 4) !== ' in ') return null;
  const rest = tag.slice(i + 4);
  if (rest.length === 0) return null;
  for (let j = 0; j < rest.length; j++) if (isWS(rest.charCodeAt(j))) return null;
  return { name: varName, path: rest };
}

/** Parse an `if` tag body, or null when it is not one. */
function parseIf(tag) {
  if (!tag.startsWith('if ')) return null;
  let i = 3;
  let not = false;
  if (tag.slice(i, i + 4) === 'not ') {
    not = true;
    i += 4;
  }
  const rest = tag.slice(i);
  if (rest.length === 0) return null;
  for (let j = 0; j < rest.length; j++) if (isWS(rest.charCodeAt(j))) return null;
  return { not, path: rest };
}

/** Parse an `include` tag body, or null when it is not one. */
function parseInclude(tag) {
  if (!tag.startsWith('include "') || !tag.endsWith('"') || tag.length < 11) return null;
  const inner = tag.slice(9, -1);
  if (inner.length === 0) return null;
  for (let i = 0; i < inner.length; i++) {
    const c = inner.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return null;
  }
  return inner;
}

function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = parseFor(tag)) !== null) {
        const node = { kind: 'for', name: m.name, path: pathOf(name, m.path), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = parseIf(tag)) !== null) {
        const node = { kind: 'if', not: m.not, path: pathOf(name, m.path), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError('template "' + name + '": an else outside an if');
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) {
          throw new TemplateError('template "' + name + '": an ' + tag + ' with no open ' + tag.slice(3));
        }
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else !== null && parent.else !== undefined ? parent.else : parent.then;
      } else if ((m = parseInclude(tag)) !== null) {
        body.push({ kind: 'include', name: m });
      } else {
        throw new TemplateError('template "' + name + '": {% ' + tag + ' %} is not a tag');
      }
    }
  }
  if (stack.length > 1) throw new TemplateError('template "' + name + '": a ' + stack[stack.length - 1].kind + ' is not closed');
  return root.body;
}

function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

function renderInto(nodes, scope, templates, extMap, depth, out) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    if (n.kind === 'text') {
      out.push(n.text);
    } else if (n.kind === 'var') {
      const v = lookup(scope, n.path);
      out.push(typeof v === 'string' ? escStr(v) : escStr(textOf(v)));
    } else if (n.kind === 'raw') {
      const v = lookup(scope, n.path);
      out.push(typeof v === 'string' ? v : textOf(v));
    } else if (n.kind === 'if') {
      const branch = truthy(lookup(scope, n.path)) !== n.not ? n.then : n.else;
      if (branch !== null) renderInto(branch, scope, templates, extMap, depth, out);
    } else if (n.kind === 'for') {
      const xs = lookup(scope, n.path);
      if (Array.isArray(xs)) {
        // One vars object and one loop object per for-node, mutated per item:
        // rendering is synchronous and never retains the scope, so reuse is safe.
        const vars = {};
        const loop = { index: 0, first: false, last: false, length: xs.length };
        vars.loop = loop;
        const child = { vars, parent: scope };
        for (let k = 0; k < xs.length; k++) {
          vars[n.name] = xs[k];
          if (n.name === 'loop') vars.loop = loop;
          loop.index = k + 1;
          loop.first = k === 0;
          loop.last = k === xs.length - 1;
          renderInto(n.body, child, templates, extMap, depth, out);
        }
      }
    } else if (n.kind === 'include') {
      const t = templates.get(n.name);
      if (t !== undefined && depth < 8) {
        const ev = extMap.get(n.name);
        if (ev === null || ev === undefined) {
          renderInto(t, scope, templates, extMap, depth + 1, out);
        } else {
          // Cache this include's output by the identities of the values its
          // free variables resolve to (plus include depth). The values are
          // never mutated during a build, so identity keying is exact.
          let node = n.ic;
          if (node === undefined) node = n.ic = new Map();
          for (let vi = 0; vi < ev.length; vi++) {
            const v = lookup(scope, [ev[vi]]);
            let next = node.get(v);
            if (next === undefined) {
              next = new Map();
              node.set(v, next);
            }
            node = next;
          }
          let s = node.get(depth);
          if (s === undefined) {
            const tmp = [];
            renderInto(t, scope, templates, extMap, depth + 1, tmp);
            s = tmp.join('');
            node.set(depth, s);
          }
          out.push(s);
        }
      }
    }
  }
}

/** Free first-segment names of `nodes` (names not bound by an enclosing for),
 *  or null when the include graph cycles (conservative: not cacheable).
 *  `bound` is the set of loop variables in scope; `visiting` guards cycles. */
function freeVarsOf(nodes, templates, bound, visiting, memo) {
  const out = new Set();
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.kind === 'text') continue;
    if (n.kind === 'var' || n.kind === 'raw') {
      if (!bound.has(n.path[0])) out.add(n.path[0]);
    } else if (n.kind === 'if') {
      if (!bound.has(n.path[0])) out.add(n.path[0]);
      const a = freeVarsOf(n.then, templates, bound, visiting, memo);
      if (a === null) return null;
      for (const x of a) out.add(x);
      if (n.else !== null) {
        const b = freeVarsOf(n.else, templates, bound, visiting, memo);
        if (b === null) return null;
        for (const x of b) out.add(x);
      }
    } else if (n.kind === 'for') {
      if (!bound.has(n.path[0])) out.add(n.path[0]);
      const b2 = new Set(bound);
      b2.add(n.name);
      b2.add('loop');
      const a = freeVarsOf(n.body, templates, b2, visiting, memo);
      if (a === null) return null;
      for (const x of a) out.add(x);
    } else if (n.kind === 'include') {
      const t = templates.get(n.name);
      if (t === undefined) continue;
      if (visiting.has(n.name)) return null;
      const key = n.name + '|' + [...bound].sort().join(',');
      let a = memo.get(key);
      if (a === undefined) {
        visiting.add(n.name);
        a = freeVarsOf(t, templates, bound, visiting, memo);
        visiting.delete(n.name);
        memo.set(key, a);
      }
      if (a === null) return null;
      for (const x of a) out.add(x);
    }
  }
  return out;
}

/** Per template: its cache key variables (free names other than the per-run
 *  constants site/tags/recent), or null when it must not be include-cached:
 *  cyclic, referencing an enclosing `loop` (a shared object mutated per
 *  iteration, so identity keying would be wrong), or too many free names. */
function computeExtMap(templates) {
  const memo = new Map();
  const extMap = new Map();
  for (const name of templates.keys()) {
    const fv = freeVarsOf(templates.get(name), templates, new Set(), new Set(), memo);
    if (fv === null || fv.has('loop')) {
      extMap.set(name, null);
      continue;
    }
    const arr = [];
    for (const x of fv) if (x !== 'site' && x !== 'tags' && x !== 'recent') arr.push(x);
    arr.sort();
    extMap.set(name, arr.length > 4 ? null : arr);
  }
  return extMap;
}

// ---------------------------------------------------------------- build

function dirOf(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

function isScheme(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  let i = 1;
  while (i < target.length) {
    const c = target.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46) i++;
    else break;
  }
  return i < target.length && target.charCodeAt(i) === 58;
}

/** One site's output tree: path -> text. */
export function run(input) {
  const templates = new Map();
  const report = [];
  const tnames = Object.keys(input.templates).sort(cmp);
  for (let i = 0; i < tnames.length; i++) {
    const name = tnames[i];
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  let base = input.site.base_url;
  let be = base.length;
  while (be > 0 && base.charCodeAt(be - 1) === 47) be--;
  if (be !== base.length) base = base.slice(0, be);
  const extMap = computeExtMap(templates);

  const files = [...input.files].sort((a, b) => cmp(a.path, b.path));
  const sources = [];
  const statics = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: normalizeNL(f.content) });
    else statics.push({ path: f.path, content: f.content });
  }

  // Front matter + drop checks, in order.
  const kept = [];
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push('refused ' + s.path + ': ' + fm.error);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own = undefined;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== undefined) {
      report.push('refused ' + s.path + ': ' + own + '/ is the generator\'s own');
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push('refused ' + s.path + ': a post needs a date');
      continue;
    }
    const layout = s.data.layout !== undefined ? s.data.layout : s.post ? 'post' : 'page';
    if (!templates.has(layout)) {
      report.push('refused ' + s.path + ': layout "' + layout + '" is no template that parses');
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push('draft ' + s.path);
      continue;
    }
    kept.push(s);
  }

  // Permalinks.
  const taken = new Map();
  const bySource = new Map();
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug !== undefined ? s.data.slug : slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : dir + '/' + slug;
    s.url = base + '/' + s.outDir + '/';
    bySource.set(s.path, s);
  }

  // Markdown + link resolution.
  const staticPaths = new Set();
  for (let i = 0; i < statics.length; i++) staticPaths.add(statics[i].path);
  const broken = new Set();
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    const dir = dirOf(s.path);
    const srcPath = s.path;
    const link = (target) => {
      if (isScheme(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null) {
        const pg = bySource.get(path);
        if (pg !== undefined) return pg.url + frag;
        if (staticPaths.has(path)) return base + '/' + path + frag;
      }
      broken.add('broken-link ' + srcPath + ' -> ' + target);
      return target;
    };
    const md = renderMarkdown(s.body, link);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // Collections: newest first, equal dates by slug.
  const posts = [];
  for (let i = 0; i < kept.length; i++) if (kept[i].post) posts.push(kept[i]);
  posts.sort((x, y) => cmp(y.data.date, x.data.date) || cmp(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // Tags.
  const ownTagNames = (s) => {
    const seen = new Set();
    const out = [];
    const tags = s.data.tags !== undefined ? s.data.tags : [];
    for (let i = 0; i < tags.length; i++) {
      const sl = slugify(tags[i]);
      if (!seen.has(sl)) {
        seen.add(sl);
        out.push(tags[i]);
      }
    }
    return out;
  };
  const bySlug = new Map();
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    p.tagRefs = [];
    const names = ownTagNames(p);
    for (let j = 0; j < names.length; j++) {
      const name = names[j];
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: base + '/tags/' + slug + '/', posts: [], card: { name, slug, url: base + '/tags/' + slug + '/' } };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    if (s.post) continue;
    const names = ownTagNames(s);
    s.tagRefs = new Array(names.length);
    for (let j = 0; j < names.length; j++) {
      const sl = slugify(names[j]);
      const t = bySlug.get(sl);
      s.tagRefs[j] = t !== undefined ? t : { name: names[j], slug: sl, url: '', posts: [], card: { name: names[j], slug: sl, url: '' } };
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || cmp(x.slug, y.slug));

  // Cards + pages.
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date !== undefined ? s.data.date : '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary !== undefined ? s.data.summary : '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => t.card),
  });
  for (let i = 0; i < kept.length; i++) kept[i].card = cardOf(kept[i]);
  const linkOf = (s) => s === null ? null : {
    title: s.data.title,
    url: s.url,
    date: s.data.date !== undefined ? s.data.date : '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
  };
  const pageOf = (s) => ({
    ...s.card,
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer !== undefined && s.newer !== null ? s.newer : null),
    older: linkOf(s.older !== undefined && s.older !== null ? s.older : null),
    is_post: s.post,
  });

  // Layouts.
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => p.card);
  const output = {};
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderInto(nodes, { vars, parent: null }, templates, extMap, 0, out);
    return out.join('');
  };
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    output[s.outDir + '/index.html'] = render(s.layout, { site, tags: allTags, recent, page: pageOf(s) });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? base + '/' : base + '/page/' + k + '/');
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      site, tags: allTags, recent,
      posts: posts.slice((k - 1) * per, k * per).map((p) => p.card),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : 'page/' + k + '/index.html'] = html;
  }
  for (let i = 0; i < tags.length; i++) {
    const t = tags[i];
    const html = render('tag', {
      site, tags: allTags, recent,
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => p.card) },
    });
    if (html !== null) output['tags/' + t.slug + '/index.html'] = html;
  }
  const tagsHtml = render('tags', { site, tags: allTags, recent });
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (let i = 0; i < statics.length; i++) {
    const f = statics[i];
    if (Object.hasOwn(output, f.path)) report.push('shadowed ' + f.path + ': a built page has its path');
    else output[f.path] = f.content;
  }

  // Report.
  const lines = [...report, ...broken].sort(cmp);
  let pageCount = 0;
  for (let i = 0; i < kept.length; i++) if (!kept[i].post) pageCount++;
  lines.push('built ' + pageCount + ' pages, ' + posts.length + ' posts, ' + tags.length + ' tags and ' + statics.length + ' static files');
  output['build-report.txt'] = lines.join('\n') + '\n';
  return output;
}
