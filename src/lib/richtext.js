// Rich-text helpers for text objects.
//
// Model (stored on the object, JSON-serialisable):
//   text   plain string, paragraphs separated by "\n"
//   fmt    [{s, e, b?, i?, u?, c?}]  character-range overrides (b=bold, i=italic, u=underline, c=colour)
//   paras  [{align?, list?, indent?}] one entry per paragraph ("left|center|right|justify", "bullet|number", 0..n)
//   bold/italic/color/align  object-level base style
//
// While a box is being edited the DOM is the source of truth (div.p per paragraph, span per styled run);
// parseRich() reads it back into the model, renderRich() writes the model into the DOM.

export const INDENT_PT = 18;
export const hangFor = (size) => size * 1.6;

export function paraAttrs(o, idx) {
  const p = (o.paras || [])[idx] || {};
  return { align: p.align || o.align || "left", list: p.list || null, indent: p.indent || 0 };
}

export function baseStyle(o) {
  return { b: !!o.bold, i: !!o.italic, u: false, c: o.color || "#000000" };
}

/** Per UTF-16 index override objects (or null). */
export function charStyles(o) {
  const n = (o.text || "").length;
  const arr = new Array(n).fill(null);
  for (const r of o.fmt || []) {
    for (let k = Math.max(0, r.s); k < Math.min(n, r.e); k++) {
      const st = { ...(arr[k] || {}) };
      for (const key of ["b", "i", "u", "c", "l"]) if (r[key] !== undefined) st[key] = r[key];
      arr[k] = st;
    }
  }
  return arr;
}

const sameStyle = (a, b) => {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.b === b.b && a.i === b.i && a.u === b.u && a.c === b.c && a.l === b.l;
};

export function compressStyles(arr, o) {
  const base = baseStyle(o);
  const clean = arr.map((st) => {
    if (!st) return null;
    const c = {};
    if (st.b !== undefined && st.b !== base.b) c.b = st.b;
    if (st.i !== undefined && st.i !== base.i) c.i = st.i;
    if (st.u) c.u = true;
    if (st.c !== undefined && st.c.toLowerCase() !== base.c.toLowerCase()) c.c = st.c;
    if (st.l) c.l = st.l;
    return Object.keys(c).length ? c : null;
  });
  const out = [];
  let k = 0;
  while (k < clean.length) {
    if (!clean[k]) { k++; continue; }
    let j = k + 1;
    while (j < clean.length && sameStyle(clean[j], clean[k])) j++;
    out.push({ s: k, e: j, ...clean[k] });
    k = j;
  }
  return out;
}

export function applyFmt(o, s, e, patch) {
  const arr = charStyles(o);
  for (let k = Math.max(0, s); k < Math.min(arr.length, e); k++) {
    if ((o.text || "")[k] === "\n") continue;
    const next = { ...(arr[k] || {}), ...patch };
    for (const key of Object.keys(next)) if (next[key] === null) delete next[key]; // null removes a property
    arr[k] = next;
  }
  o.fmt = compressStyles(arr, o);
}

/** Effective style of the character at index k (clamped). */
export function styleAt(o, k) {
  const base = baseStyle(o);
  const st = charStyles(o)[Math.max(0, Math.min((o.text || "").length - 1, k))] || {};
  return { b: st.b ?? base.b, i: st.i ?? base.i, u: st.u ?? false, c: st.c ?? base.c, l: st.l || null };
}

/** True when every non-newline char in [s,e) has the given flag. */
export function allHave(o, s, e, key) {
  const arr = charStyles(o);
  const base = baseStyle(o);
  let any = false;
  for (let k = s; k < e; k++) {
    if (o.text[k] === "\n") continue;
    any = true;
    const v = (arr[k] || {})[key] ?? base[key];
    if (!v) return false;
  }
  return any;
}

// ------------------------------------------------------------------ DOM <-> model

export function applyParaStyle(div, attrs, size, zoom) {
  div.className = "p";
  div.dataset.align = attrs.align;
  if (attrs.list) div.dataset.list = attrs.list; else delete div.dataset.list;
  div.dataset.indent = String(attrs.indent || 0);
  const ind = (attrs.indent || 0) * INDENT_PT * zoom;
  const hang = attrs.list ? hangFor(size) * zoom : 0;
  div.style.textAlign = attrs.align;
  div.style.textAlignLast = attrs.align === "justify" ? "left" : "";
  div.style.paddingLeft = `${ind + hang}px`;
  div.style.setProperty("--mark-left", `${ind}px`);
}

export function refreshMarkers(content) {
  let n = 0;
  for (const div of content.children) {
    const list = div.dataset?.list;
    if (list === "number") { n++; div.dataset.marker = `${n}.`; }
    else { n = 0; if (list === "bullet") div.dataset.marker = "•"; else delete div.dataset.marker; }
  }
}

/** Write the model into `content`. styleSpan(span, style) applies CSS for a styled run. */
export function renderRich(content, o, zoom, styleSpan) {
  content.replaceChildren();
  const paras = String(o.text ?? "").split("\n");
  const cs = charStyles(o);
  let off = 0;
  paras.forEach((ptxt, pi) => {
    const div = document.createElement("div");
    applyParaStyle(div, paraAttrs(o, pi), o.size, zoom);
    if (!ptxt.length) div.append(document.createElement("br"));
    let k = 0;
    while (k < ptxt.length) {
      const st = cs[off + k];
      let j = k + 1;
      while (j < ptxt.length && sameStyle(cs[off + j], st)) j++;
      const chunk = ptxt.slice(k, j);
      if (st) {
        const sp = document.createElement("span");
        sp.textContent = chunk;
        for (const key of ["b", "i", "u", "c", "l"]) if (st[key] !== undefined) sp.dataset[key] = String(st[key] === true ? 1 : st[key] === false ? 0 : st[key]);
        styleSpan(sp, st);
        div.append(sp);
      } else div.append(document.createTextNode(chunk));
      k = j;
    }
    content.append(div);
    off += ptxt.length + 1;
  });
  refreshMarkers(content);
}

function normalizeParas(content) {
  // wrap stray inline children into paragraphs (browsers sometimes leave text/br directly in the root)
  const kids = [...content.childNodes];
  let run = null;
  for (const n of kids) {
    const isPara = n.nodeType === 1 && n.tagName === "DIV";
    if (isPara) { run = null; continue; }
    if (!run) { run = document.createElement("div"); run.className = "p"; content.insertBefore(run, n); }
    run.append(n);
  }
}

function styleOfNode(node, content) {
  const st = {};
  for (let el = node.parentElement; el && el !== content; el = el.parentElement) {
    const d = el.dataset || {};
    if (st.b === undefined && d.b !== undefined) st.b = d.b === "1";
    if (st.i === undefined && d.i !== undefined) st.i = d.i === "1";
    if (st.u === undefined && d.u !== undefined) st.u = d.u === "1";
    if (st.c === undefined && d.c !== undefined) st.c = d.c;
    if (st.l === undefined && d.l !== undefined) st.l = d.l;
  }
  return Object.keys(st).length ? st : null;
}

export function readParaAttrs(div, fallbackAlign) {
  const d = div.dataset || {};
  return { align: d.align || fallbackAlign || "left", list: d.list || null, indent: +d.indent || 0 };
}

function textNodesOf(root) {
  const out = [];
  const walk = (n) => {
    for (const c of n.childNodes) {
      if (c.nodeType === 3) out.push(c);
      else if (c.nodeType === 1) {
        if (c.tagName === "BR") out.push({ br: true, parent: c.parentElement, el: c });
        else walk(c);
      }
    }
  };
  walk(root);
  return out;
}

/** Read the DOM back into {text, fmt, paras}. `o` supplies the base style/align. */
export function parseRich(content, o) {
  normalizeParas(content);
  const divs = [...content.children];
  let text = "";
  const styles = [];
  const paras = [];
  divs.forEach((div, di) => {
    paras.push(readParaAttrs(div, o.align));
    const nodes = textNodesOf(div);
    nodes.forEach((n, ni) => {
      if (n.br) {
        // a lone <br> is just the placeholder of an empty paragraph; a <br> between text is a line break
        if (nodes.length > 1 && ni < nodes.length - 1) { text += "\n"; styles.push(null); }
        return;
      }
      const t = n.data.replace(/ /g, " ").replace(/​/g, "");
      const st = styleOfNode(n, content);
      for (const ch of t) { text += ch; for (let u = 0; u < ch.length; u++) styles.push(st); }
    });
    if (di < divs.length - 1) { text += "\n"; styles.push(null); }
  });
  const base = baseStyle(o);
  const tmp = { text, bold: base.b, italic: base.i, color: base.c };
  return { text, paras, fmt: compressStyles(styles, tmp) };
}

// ------------------------------------------------------------------ selection <-> offsets

function paraLen(div) {
  let n = 0;
  for (const t of textNodesOf(div)) if (!t.br) n += t.data.replace(/​/g, "").length;
  return n;
}

/** Text offset (paragraphs joined by "\n") of a DOM point. */
export function offsetOf(content, node, nodeOffset) {
  const divs = [...content.children];
  let acc = 0;
  for (let i = 0; i < divs.length; i++) {
    const div = divs[i];
    if (node === content) return i < nodeOffset ? acc + paraLen(div) + 1 : acc; // approximate for root-level points
    if (div.contains(node)) {
      const r = document.createRange();
      r.setStart(div, 0);
      r.setEnd(node, nodeOffset);
      return acc + r.toString().replace(/​/g, "").length;
    }
    acc += paraLen(div) + 1;
  }
  return acc;
}

export function selectionOffsets(content) {
  const sel = getSelection();
  if (!sel || !sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  if (!content.contains(r.startContainer) || !content.contains(r.endContainer)) return null;
  const a = offsetOf(content, r.startContainer, r.startOffset);
  const b = offsetOf(content, r.endContainer, r.endOffset);
  return { s: Math.min(a, b), e: Math.max(a, b) };
}

function locate(content, off) {
  const divs = [...content.children];
  for (let i = 0; i < divs.length; i++) {
    const len = paraLen(divs[i]);
    if (off <= len) {
      let left = off;
      for (const t of textNodesOf(divs[i])) {
        if (t.br) continue;
        if (left <= t.data.length) return { node: t, offset: left };
        left -= t.data.length;
      }
      return { node: divs[i], offset: divs[i].childNodes.length };
    }
    off -= len + 1;
  }
  const last = divs[divs.length - 1];
  return { node: last || content, offset: last ? last.childNodes.length : 0 };
}

export function setSelectionOffsets(content, s, e) {
  const a = locate(content, s);
  const b = locate(content, e);
  const r = document.createRange();
  r.setStart(a.node, a.offset);
  r.setEnd(b.node, b.offset);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}

/** Paragraph indices touched by [s,e]. */
export function parasInRange(text, s, e) {
  const out = [];
  let off = 0;
  String(text).split("\n").forEach((p, i) => {
    const start = off, end = off + p.length;
    if (e >= start && s <= end) out.push(i);
    off = end + 1;
  });
  return out;
}

export function trimSpaces(text) {
  return String(text).split("\n").map((l) => l.replace(/[ \t ]+/g, " ").replace(/^ | $/g, "")).join("\n");
}

/** Collapse repeated spaces and strip leading/trailing spaces on every line, keeping formatting. Returns true if changed. */
export function trimModel(o) {
  const text = o.text || "";
  const cs = charStyles(o);
  const outText = [];
  const outStyle = [];
  let off = 0;
  text.split("\n").forEach((line, li, all) => {
    const res = [];
    let prevSpace = true;
    for (let k = 0; k < line.length; k++) {
      const ch = line[k];
      const sp = ch === " " || ch === "\t" || ch === "\u00a0";
      if (sp) { if (prevSpace) continue; prevSpace = true; res.push([" ", cs[off + k]]); }
      else { prevSpace = false; res.push([ch, cs[off + k]]); }
    }
    while (res.length && res[res.length - 1][0] === " ") res.pop();
    for (const [c, st] of res) { outText.push(c); outStyle.push(st); }
    if (li < all.length - 1) { outText.push("\n"); outStyle.push(null); }
    off += line.length + 1;
  });
  const next = outText.join("");
  if (next === text) return false;
  o.text = next;
  o.fmt = compressStyles(outStyle, o);
  return true;
}

// ------------------------------------------------------------------ hyperlinks

export const LINK_COLOR = "#0563c1"; // Word's "Hyperlink" blue
const ALLOWED_SCHEMES = new Set(["http:", "https:", "mailto:", "tel:"]);

/** Turn what the user typed into a safe link target, or an error. "#page=N" links inside the document. */
export function normalizeLink(input, { pageCount = Infinity } = {}) {
  const raw = String(input || "").trim();
  if (!raw) return { error: "Enter an address." };
  const pg = /^#page=(\d+)$/.exec(raw);
  if (pg) {
    const n = +pg[1];
    return n >= 1 && n <= pageCount ? { url: raw } : { error: `Page must be between 1 and ${pageCount}.` };
  }
  if (/\s/.test(raw)) return { error: "Addresses cannot contain spaces." };
  let url = raw;
  if (/^[^\s@/:]+@[^\s@/:]+\.[^\s@/:]+$/.test(raw)) url = `mailto:${raw}`;
  else if (!/^[a-z][a-z0-9+.-]*:/i.test(raw)) url = `https://${raw}`;
  let parsed;
  try { parsed = new URL(url); } catch { return { error: "That doesn't look like a valid address." }; }
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) return { error: "Only http, https, mailto and tel links are allowed." };
  if (/^https?:$/.test(parsed.protocol) && !/\./.test(parsed.hostname) && parsed.hostname !== "localhost") return { error: "That doesn't look like a valid web address." };
  return { url: parsed.protocol === "mailto:" || parsed.protocol === "tel:" ? url : parsed.href };
}

/** Contiguous range around index k that carries the same link. */
export function linkRange(o, k) {
  const cs = charStyles(o);
  const here = cs[k]?.l ? k : cs[k - 1]?.l ? k - 1 : -1;
  if (here < 0) return null;
  const url = cs[here].l;
  let s = here, e = here + 1;
  while (s > 0 && cs[s - 1]?.l === url) s--;
  while (e < cs.length && cs[e]?.l === url) e++;
  return { s, e, url };
}

/** Replace text[s,e) with newText; the new characters take `style` (merged over the first replaced char's style). */
export function replaceRange(o, s, e, newText, style = {}) {
  const text = o.text || "";
  const cs = charStyles(o);
  const inherit = cs[s] || cs[s - 1] || null;
  const clean = String(newText).replace(/\n/g, " ");
  const mid = Array.from({ length: clean.length }, () => ({ ...(inherit || {}), ...style }));
  const nextStyles = [...cs.slice(0, s), ...mid, ...cs.slice(e)];
  o.text = text.slice(0, s) + clean + text.slice(e);
  o.fmt = compressStyles(nextStyles, o);
  return { s, e: s + clean.length };
}
