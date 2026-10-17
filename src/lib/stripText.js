// Remove text-showing operators that start inside given boxes from a page's content stream, so edited text
// is truly replaced instead of only being covered. Conservative: an operator is only removed when doing so
// cannot shift the position of other text. Text inside Form XObjects is not touched.
import { PDFArray, PDFName, PDFRawStream, decodePDFRawStream } from "pdf-lib";

const WS = new Set([" ", "\n", "\r", "\t", "\f", "\0"]);
const DELIM = new Set(["(", ")", "<", ">", "[", "]", "{", "}", "/", "%"]);

function tokenize(src) {
  const toks = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (WS.has(c)) { i++; continue; }
    const s = i;
    if (c === "%") { while (i < n && src[i] !== "\n" && src[i] !== "\r") i++; continue; }
    if (c === "(") {
      let depth = 1;
      i++;
      while (i < n && depth > 0) {
        if (src[i] === "\\") i += 2;
        else { if (src[i] === "(") depth++; else if (src[i] === ")") depth--; i++; }
      }
      toks.push({ t: "str", s, e: i });
    } else if (c === "<") {
      if (src[i + 1] === "<") { i += 2; toks.push({ t: "<<", s, e: i }); }
      else { while (i < n && src[i] !== ">") i++; i++; toks.push({ t: "str", s, e: i }); }
    } else if (c === ">") {
      if (src[i + 1] === ">") { i += 2; toks.push({ t: ">>", s, e: i }); } else i++;
    } else if (c === "[" || c === "]") {
      i++;
      toks.push({ t: c, s, e: i });
    } else if (c === "{" || c === "}" || c === ")") {
      i++;
    } else if (c === "/") {
      i++;
      while (i < n && !WS.has(src[i]) && !DELIM.has(src[i])) i++;
      toks.push({ t: "name", s, e: i, v: src.slice(s, i) });
    } else {
      while (i < n && !WS.has(src[i]) && !DELIM.has(src[i])) i++;
      const w = src.slice(s, i);
      if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(w)) toks.push({ t: "num", s, e: i, v: parseFloat(w) });
      else {
        toks.push({ t: "op", s, e: i, v: w });
        if (w === "BI") {
          // inline image: skip dictionary, then binary data up to "EI"
          const idIdx = src.indexOf("ID", i);
          if (idIdx < 0) break;
          let j = idIdx + 3;
          for (;;) {
            const k = src.indexOf("EI", j);
            if (k < 0) { j = n; break; }
            if (WS.has(src[k - 1] ?? " ") && (k + 2 >= n || WS.has(src[k + 2]))) { j = k + 2; break; }
            j = k + 2;
          }
          i = j;
          toks.push({ t: "op", s: i, e: i, v: "EI" });
        }
      }
    }
  }
  return toks;
}

const mul = (a, b) => [
  a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
];
const ID = [1, 0, 0, 1, 0, 0];

/** Walk the stream and describe every text-show operator. */
function scan(src) {
  const toks = tokenize(src);
  const shows = [];
  let ctm = ID, tm = ID, tlm = ID, leading = 0, rise = 0, positioned = true;
  const stack = [];
  let operands = [];
  const num = (k) => operands[k]?.v ?? 0;
  const point = () => {
    const x = tm[2] * rise + tm[4], y = tm[3] * rise + tm[5];
    return [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]];
  };
  const nextLine = () => { tlm = mul([1, 0, 0, 1, 0, -leading], tlm); tm = tlm; };
  let arrStart = null;
  let depth = 0;
  for (const tk of toks) {
    if (tk.t === "[") { if (depth++ === 0) arrStart = tk; continue; }
    if (tk.t === "]") { if (--depth === 0) operands.push({ t: "arr", s: arrStart.s, e: tk.e }); continue; }
    if (depth > 0) continue;
    if (tk.t !== "op") { operands.push(tk); continue; }
    const op = tk.v;
    const first = operands.length ? Math.min(...operands.map((o) => o.s)) : tk.s;
    switch (op) {
      case "q": stack.push(ctm); break;
      case "Q": ctm = stack.pop() || ctm; break;
      case "cm": if (operands.length >= 6) ctm = mul(operands.slice(-6).map((o) => o.v), ctm); break;
      case "BT": tm = tlm = ID; positioned = true; break;
      case "Tm": if (operands.length >= 6) { tm = tlm = operands.slice(-6).map((o) => o.v); positioned = true; } break;
      case "Td": tlm = mul([1, 0, 0, 1, num(operands.length - 2), num(operands.length - 1)], tlm); tm = tlm; positioned = true; break;
      case "TD": leading = -num(operands.length - 1); tlm = mul([1, 0, 0, 1, num(operands.length - 2), num(operands.length - 1)], tlm); tm = tlm; positioned = true; break;
      case "T*": nextLine(); positioned = true; break;
      case "TL": leading = num(operands.length - 1); break;
      case "Ts": rise = num(operands.length - 1); break;
      case "Tj": case "TJ": {
        const [x, y] = point();
        shows.push({ op, x, y, from: first, to: tk.e, positioned });
        positioned = false;
        break;
      }
      case "'": case '"': {
        nextLine();
        const [x, y] = point();
        shows.push({ op, x, y, from: first, to: tk.e, positioned: true });
        positioned = false;
        break;
      }
      default: break;
    }
    operands = [];
  }
  return shows;
}

/**
 * boxes: [{x0,y0,x1,y1}] in PDF user space (y up). Returns {bytes, removed}.
 */
export function stripTextInBoxes(src, boxes) {
  const shows = scan(src);
  const inBox = (s) => boxes.some((b) => s.x >= b.x0 && s.x <= b.x1 && s.y >= b.y0 && s.y <= b.y1);
  const remove = new Array(shows.length).fill(false);
  // an op is removable if it is in a box and the next op doesn't rely on its advance (or is removed too)
  for (let i = shows.length - 1; i >= 0; i--) {
    if (!inBox(shows[i])) continue;
    const next = shows[i + 1];
    remove[i] = !next || next.positioned || remove[i + 1];
  }
  let out = "";
  let pos = 0;
  let removed = 0;
  shows.forEach((s, i) => {
    if (!remove[i]) return;
    out += src.slice(pos, s.from);
    out += s.op === "'" || s.op === '"' ? " T* " : " ";
    pos = s.to;
    removed++;
  });
  out += src.slice(pos);
  return { text: out, removed };
}

const toLatin1 = (bytes) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return s;
};
const fromLatin1 = (s) => {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255;
  return b;
};

/** Rewrite a pdf-lib page's content without text that starts inside `boxes` (PDF user space). Returns count removed. */
export function removeTextFromPage(doc, page, boxes) {
  const ctx = doc.context;
  const contents = page.node.Contents();
  if (!contents) return 0;
  const refs = contents instanceof PDFArray ? contents.asArray() : [page.node.get(PDFName.of("Contents"))];
  const parts = [];
  for (const ref of refs) {
    const st = ctx.lookup(ref);
    if (!(st instanceof PDFRawStream)) return 0; // unusual stream type: leave the page alone
    parts.push(toLatin1(decodePDFRawStream(st).decode()));
  }
  const { text, removed } = stripTextInBoxes(parts.join("\n"), boxes);
  if (!removed) return 0;
  const stream = ctx.flateStream(fromLatin1(text));
  page.node.set(PDFName.of("Contents"), ctx.register(stream));
  return removed;
}
