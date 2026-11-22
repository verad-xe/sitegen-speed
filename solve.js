// sitegen-speed: a fast drop-in replacement for makefun-site 1.0.0.
// An original implementation of the same build: the same front matter,
// template dialect, Markdown subset, slug rule and report, byte for byte.
// Written from the makefun-site README and its reference behaviour;
// no code is copied from the reference implementation.
//
// Speed comes from: single-pass Markdown rendering with run-based HTML
// escaping, cached slug work, a hand-rolled front-matter scanner, and
// templates compiled once per case into plain JavaScript functions
// (via new Function) so rendering a page is straight-line code instead
// of a node-tree walk.

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;

/** `text` with & < > " and ' escaped. */
export function escapeHtml(text) {
  return text.replace(ESC_RE, (c) => ESCAPES[c]);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
export function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

const slugCache = new Map();

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every
 * run of characters other than a-z and 0-9 one "-", none at either end,
 * at most 64 characters (a "-" left at the cut dropped), "untitled" when
 * nothing is left. Results are cached: titles and tags repeat.
 */
export function slugify(text) {
  let v = slugCache.get(text);
  if (v !== undefined) return v;
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    const code = ch.codePointAt(0);
    let keep = null;
    if (code >= 65 && code <= 90) keep = String.fromCharCode(code + 32);
    else if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  v = out === '' ? 'untitled' : out;
  if (slugCache.size > 50000) slugCache.clear();
  slugCache.set(text, v);
  return v;
}

/** `slug` made unique against `taken` (and added to it). */
export function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
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

function isDigit(c) {
  return c >= 48 && c <= 57;
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  if (key === 'title' || key === 'summary') {
    const s = stringOf(raw);
    return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
  }
  if (key === 'date') {
    let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
    if (ok) {
      for (let i = 0; i < 10 && ok; i++) {
        if (i !== 4 && i !== 7 && !isDigit(raw.charCodeAt(i))) ok = false;
      }
    }
    const y = ok ? Number(raw.slice(0, 4)) : 0;
    const mo = ok ? Number(raw.slice(5, 7)) : 0;
    const d = ok ? Number(raw.slice(8, 10)) : 0;
    if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
      return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    }
    return { value: raw };
  }
  if (key === 'tags') {
    if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
    const inner = raw.slice(1, -1);
    if (inner.trim() === '') return { value: [] };
    const tags = inner.split(',').map((t) => t.trim());
    for (const t of tags) {
      if (t === '' || t.indexOf('"') !== -1 || t.indexOf('[') !== -1 || t.indexOf(']') !== -1) {
        return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
    }
    return { value: tags };
  }
  if (key === 'draft') {
    return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
  }
  if (key === 'layout') {
    let ok = raw.length > 0;
    for (let i = 0; i < raw.length && ok; i++) {
      const c = raw.charCodeAt(i);
      if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) ok = false;
    }
    return ok ? { value: raw } : { error: 'key "layout": not a template name' };
  }
  if (key === 'slug') {
    let ok = raw.length > 0 && raw.length <= 64 && raw.charCodeAt(0) !== 45 && raw.charCodeAt(raw.length - 1) !== 45;
    for (let i = 0; i < raw.length && ok; i++) {
      const c = raw.charCodeAt(i);
      if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) ok = false;
      if (c === 45 && raw.charCodeAt(i + 1) === 45) ok = false;
    }
    return ok ? { value: raw } : { error: 'key "slug": not a slug' };
  }
  return { error: `unknown key "${key}"` };
}

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function isKeyChar(c) {
  return (c >= 97 && c <= 122) || c === 95;
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends.
 */
export function parseFrontMatter(text) {
  let firstEnd = text.indexOf('\n');
  if (firstEnd === -1) firstEnd = text.length;
  if (text.slice(0, firstEnd) !== '---') return { error: 'no front matter' };
  // Find the closing line, exactly "---".
  let p = firstEnd === text.length ? text.length : firstEnd + 1;
  let ln = 2;
  let closePos = -1;
  let bodyStart = text.length;
  while (p <= text.length) {
    let e = text.indexOf('\n', p);
    if (e === -1) e = text.length;
    if (text.slice(p, e) === '---') {
      closePos = p;
      bodyStart = e === text.length ? text.length : e + 1;
      break;
    }
    if (e === text.length) break;
    p = e + 1;
    ln++;
  }
  if (closePos === -1) return { error: 'the front matter is not closed' };
  const data = {};
  p = firstEnd === text.length ? text.length : firstEnd + 1;
  ln = 2;
  while (p < closePos) {
    let e = text.indexOf('\n', p);
    if (e === -1 || e > closePos) e = closePos;
    const line = text.slice(p, e);
    if (!isBlankLine(line) && line.charCodeAt(0) !== 35) {
      let i = 0;
      while (i < line.length && isKeyChar(line.charCodeAt(i))) i++;
      const key = line.slice(0, i);
      let raw;
      if (i === 0 || line.charCodeAt(i) !== 58) return { error: `line ${ln} is not "key: value"` };
      if (i + 1 === line.length) raw = '';
      else if (line.charCodeAt(i + 1) === 32) raw = line.slice(i + 2);
      else return { error: `line ${ln} is not "key: value"` };
      let r = raw.length;
      while (r > 0 && (raw.charCodeAt(r - 1) === 32 || raw.charCodeAt(r - 1) === 9)) r--;
      raw = raw.slice(0, r);
      if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    if (e >= closePos) break;
    p = e + 1;
    ln++;
  }
  if (!hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ---------------------------------------------------------------- markdown

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

function trimLine(line) {
  if (line.length === 0) return line;
  const a0 = line.charCodeAt(0);
  const b0 = line.charCodeAt(line.length - 1);
  if (a0 !== 32 && a0 !== 9 && b0 !== 32 && b0 !== 9) return line;
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
}

function isLangChar(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;
}

/** Fence-open language, or null. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  while (j < line.length && isLangChar(line.charCodeAt(j))) j++;
  const lang = line.slice(3, j);
  while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
  return j === line.length ? lang : null;
}

function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let c = 0;
  while (c < line.length && line.charCodeAt(c) === 35) c++;
  if (c < 1 || c > 6) return null;
  if (c >= line.length) return null;
  const s = line.charCodeAt(c);
  if (s !== 32 && s !== 9) return null;
  const text = trimLine(line.slice(c + 1));
  return text === '' ? null : { depth: c, text };
}

function isHr(line) {
  const head = line.slice(0, 3);
  if (head !== '---' && head !== '***') return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  return isBlankLine(line) || fenceOpen(line) !== null || headingOf(line) !== null || isHr(line);
}

/** A list item's text, or null when the line does not open/continue this list. */
function listMatch(line, ordered) {
  if (ordered) {
    let j = 0;
    while (j < line.length && isDigit(line.charCodeAt(j))) j++;
    if (j >= 1 && j <= 9 && line.charCodeAt(j) === 46 && line.charCodeAt(j + 1) === 32) {
      return { start: Number(line.slice(0, j)), text: line.slice(j + 2) };
    }
    return null;
  }
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return { start: 1, text: line.slice(2) };
  return null;
}

function isContinued(line) {
  let j = 0;
  while (j < line.length && line.charCodeAt(j) === 32) j++;
  if (j < 2 || j >= line.length) return false;
  return !/\s/.test(line[j]);
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  const wlen = what.length;
  let j = from;
  while (j <= s.length - wlen) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j += 2;
      continue;
    }
    if (s.startsWith(what, j)) return j;
    j++;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** `s` rendered inline; `link(target)` is a link's href. */
export function inline(s, link) {
  const n = s.length;
  let o = '';
  let i = 0;
  while (i < n) {
    // Jump to the next special character; copy the plain run in one go.
    const a = s.indexOf('\\', i);
    const b = s.indexOf('`', i);
    const cc = s.indexOf('*', i);
    const d = s.indexOf('[', i);
    let j = n;
    if (a !== -1 && a < j) j = a;
    if (b !== -1 && b < j) j = b;
    if (cc !== -1 && cc < j) j = cc;
    if (d !== -1 && d < j) j = d;
    if (j > i) o += escapeHtml(s.slice(i, j));
    if (j >= n) break;
    i = j;
    const c = s[i];
    if (c === '\\') {
      if (i + 1 < n && ESCAPABLE.has(s[i + 1])) {
        o += s[i + 1];
        i += 2;
      } else {
        o += '\\';
        i++;
      }
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', i + 1);
      if (k > i + 1) {
        o += `<code>${escapeHtml(s.slice(i + 1, k))}</code>`;
        i = k + 1;
      } else {
        o += '`';
        i++;
      }
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const k = findUnescaped(s, '**', i + 2);
        if (k > i + 2) {
          o += `<strong>${inline(s.slice(i + 2, k), link)}</strong>`;
          i = k + 2;
        } else {
          o += '**';
          i += 2;
        }
        continue;
      }
      const k = findSingleStar(s, i + 1);
      if (k > i + 1) {
        o += `<em>${inline(s.slice(i + 1, k), link)}</em>`;
        i = k + 1;
      } else {
        o += '*';
        i++;
      }
      continue;
    }
    // c === '['
    const k = findUnescaped(s, ']', i + 1);
    const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
    const target = m === -1 ? '' : s.slice(k + 2, m);
    if (target !== '' && !/\s/.test(target)) {
      o += `<a href="${escapeHtml(link(target))}">${inline(s.slice(i + 1, k), link)}</a>`;
      i = m + 1;
    } else {
      o += '[';
      i++;
    }
  }
  return o;
}

/**
 * `src` rendered in one pass: its HTML, its table of contents (every
 * level 2 and 3 heading) and its excerpt (the first paragraph's HTML).
 */
export function renderMarkdown(src, link) {
  const lines = src.split('\n');
  const n = lines.length;
  const blocks = [];
  const toc = [];
  const ids = new Set();
  let excerpt = '';
  let hasExcerpt = false;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (isBlankLine(line)) {
      i++;
      continue;
    }
    const lang = fenceOpen(line);
    if (lang !== null) {
      i++;
      let s = `<pre><code${lang === '' ? '' : ` class="language-${lang}"`}>`;
      while (i < n && !isFenceClose(lines[i])) {
        s += escapeHtml(lines[i]);
        s += '\n';
        i++;
      }
      i++;
      s += '</code></pre>';
      blocks.push(s);
      continue;
    }
    const hd = headingOf(line);
    if (hd !== null) {
      const id = uniqueSlug(slugify(hd.text), ids);
      const html = inline(hd.text, link);
      blocks.push(`<h${hd.depth} id="${id}">${html}</h${hd.depth}>`);
      if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
      i++;
      continue;
    }
    if (isHr(line)) {
      blocks.push('<hr>');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const kept = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        const t = trimLine(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
        if (t !== '') kept.push(t);
      }
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(kept.join('\n'), link)}</p>\n</blockquote>`);
      continue;
    }
    const first = listMatch(line, false);
    const firstOrd = first === null ? listMatch(line, true) : null;
    if (first !== null || firstOrd !== null) {
      const ordered = firstOrd !== null;
      const start = ordered ? firstOrd.start : 1;
      const items = [];
      while (i < n) {
        const m = listMatch(lines[i], ordered);
        if (m !== null) {
          items.push([trimLine(m.text)]);
          i++;
        } else if (isContinued(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const tag = ordered ? 'ol' : 'ul';
      const open = ordered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      let s = `${open}\n`;
      for (const parts of items) s += `<li>${inline(parts.join('\n'), link)}</li>\n`;
      s += `</${tag}>`;
      blocks.push(s);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), link);
    if (!hasExcerpt) {
      excerpt = html;
      hasExcerpt = true;
    }
    blocks.push(`<p>${html}</p>`);
  }
  let html = '';
  for (const b of blocks) {
    html += b;
    html += '\n';
  }
  return { html, toc, excerpt };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
export const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
export class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
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
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
export function parseTemplate(name, src) {
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
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

// Runtime helpers for compiled templates. F is the scope stack: F[0] is
// the page's values, later frames are loop scopes, innermost last.
const H = {
  lk(F, name) {
    for (let i = F.length - 1; i >= 0; i--) {
      if (hasOwn(F[i], name)) return F[i][name];
    }
    return undefined;
  },
  g(o, k) {
    return o !== null && typeof o === 'object' && hasOwn(o, k) ? o[k] : undefined;
  },
  txt(v) {
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return String(v);
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (Array.isArray(v)) {
      let s = '';
      for (let i = 0; i < v.length; i++) {
        if (i > 0) s += ', ';
        s += H.txt(v[i]);
      }
      return s;
    }
    return '';
  },
  tru(v) {
    if (Array.isArray(v)) return v.length > 0;
    return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
  },
};

/**
 * Compile a parsed template into a renderer function
 * fn(F, T, E, D, H) -> string. Loop-bound names resolve to locals at
 * compile time; every other first name is looked up in the scope stack,
 * innermost first, exactly as the dialect requires.
 */
function compileTemplate(nodes) {
  let uid = 0;
  const stack = []; // each frame: Map name -> local variable id
  function pathExpr(path) {
    const first = path[0];
    let base = null;
    for (let s = stack.length - 1; s >= 0; s--) {
      const hit = stack[s].get(first);
      if (hit !== undefined) {
        base = hit;
        break;
      }
    }
    let e = base !== null ? base : `H.lk(F,${JSON.stringify(first)})`;
    for (let k = 1; k < path.length; k++) e = `H.g(${e},${JSON.stringify(path[k])})`;
    return e;
  }
  function gen(list) {
    let code = '';
    for (const n of list) {
      if (n.kind === 'text') code += `o+=${JSON.stringify(n.text)};`;
      else if (n.kind === 'var') code += `o+=E(H.txt(${pathExpr(n.path)}));`;
      else if (n.kind === 'raw') code += `o+=H.txt(${pathExpr(n.path)});`;
      else if (n.kind === 'if') {
        const cond = `H.tru(${pathExpr(n.path)})!==${n.not}`;
        if (n.else === null) code += `if(${cond}){${gen(n.then)}}`;
        else code += `if(${cond}){${gen(n.then)}}else{${gen(n.else)}}`;
      } else if (n.kind === 'for') {
        const id = uid++;
        const xv = `_x${id}`;
        const kv = `_k${id}`;
        const vv = `_v${id}`;
        const lv = `_l${id}`;
        const fv = `_f${id}`;
        const frame = new Map();
        frame.set(n.name, vv);
        frame.set('loop', lv);
        stack.push(frame);
        const body = gen(n.body);
        stack.pop();
        code += `{const ${xv}=${pathExpr(n.path)};if(Array.isArray(${xv})){for(let ${kv}=0;${kv}<${xv}.length;${kv}++){const ${vv}=${xv}[${kv}];const ${lv}={index:${kv}+1,first:${kv}===0,last:${kv}===${xv}.length-1,length:${xv}.length};const ${fv}={[${JSON.stringify(n.name)}]:${vv},loop:${lv}};F.push(${fv});${body}F.pop();}}}`;
      } else if (n.kind === 'include') {
        code += `if(D<8){const _t=T.get(${JSON.stringify(n.name)});if(_t!==undefined)o+=_t(F,T,E,D+1,H);}`;
      }
    }
    return code;
  }
  const body = `let o="";${gen(nodes)}return o;`;
  return new Function('F', 'T', 'E', 'D', 'H', body);
}

// ---------------------------------------------------------------- the build

/** The report file every build writes. */
export const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself. */
export const RESERVED = Object.freeze(['posts', 'tags', 'page']);

/** The words of a body: its runs of characters other than whitespace (the /\s/ set, checked by code point, with no allocation). */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let ws;
    if (c < 128) ws = c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 32;
    else ws = c === 160 || c === 5760 || (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279;
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** One site's output tree: path -> text. */
export function run(input) {
  slugCache.clear();
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(cmp)) {
    try {
      templates.set(name, compileTemplate(parseTemplate(name, input.templates[name])));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. Sources, in code-unit order of their paths; .md is a source, the rest static.
  const files = [...input.files].sort((x, y) => cmp(x.path, y.path));
  let sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter, in order: refused, reserved dir, post without date,
  // unknown layout, then draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  sources = kept;

  // 3. Permalinks: slug made unique in its directory, in source order.
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  const bySource = new Map();
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    s.slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of sources) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
      if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, link);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. Collections: posts, newest first, equal dates by slug.
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => cmp(y.data.date, x.data.date) || cmp(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. Tags, grouped by slug, named as first met in collection order.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => bySlug.get(slugify(name)) ?? { name, slug: slugify(name), url: '', posts: [] });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || cmp(x.slug, y.slug));

  // Cards, pages and links as templates read them.
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const pageOf = (s) => ({
    ...(s.post ? cards.get(s) : cardOf(s)),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) });

  // 7. Layouts: every page, the index pages, the tag pages, then statics.
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const render = (name, vars) => {
    const fn = templates.get(name);
    return fn === undefined ? null : fn([{ site, tags: allTags, recent, ...vars }], templates, escapeHtml, 0, H);
  };
  for (const s of sources) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: tagOf(t) });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report.
  const lines = [...report, ...broken].sort(cmp);
  const pageCount = sources.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
