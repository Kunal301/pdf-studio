// Pure PDF operations built on pdf-lib. No DOM access, so they run in Node for tests.
import { PDFDocument, StandardFonts, rgb, degrees, LineCapStyle, setCharacterSpacing, PDFName, PDFString } from "pdf-lib";
import { removeTextFromPage } from "./stripText.js";
import { charStyles, baseStyle, paraAttrs, hangFor, INDENT_PT } from "./richtext.js";

export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  const n = m ? parseInt(m[1], 16) : 0;
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

/** "1-3,5,8-" -> [[0,1,2],[4],[7..total-1]] (0-based groups, one per comma part). */
export function parseRanges(input, total) {
  const groups = [];
  for (const raw of String(input ?? "").split(",")) {
    const part = raw.trim();
    if (!part) continue;
    let a, b;
    const m = /^(\d*)\s*-\s*(\d*)$/.exec(part);
    if (m) {
      a = m[1] ? +m[1] : 1;
      b = m[2] ? +m[2] : total;
    } else if (/^\d+$/.test(part)) {
      a = b = +part;
    } else {
      throw new Error(`Invalid range "${part}"`);
    }
    if (a < 1 || b > total || a > b) throw new Error(`Range "${part}" is outside 1–${total}`);
    const g = [];
    for (let i = a; i <= b; i++) g.push(i - 1);
    groups.push(g);
  }
  if (!groups.length) throw new Error("Enter at least one page range");
  return groups;
}

export async function pageCount(bytes) {
  return (await PDFDocument.load(bytes)).getPageCount();
}

export async function mergePdfs(list) {
  const out = await PDFDocument.create();
  for (const bytes of list) {
    const doc = await PDFDocument.load(bytes);
    const pages = await out.copyPages(doc, doc.getPageIndices());
    pages.forEach((p) => out.addPage(p));
  }
  return out.save();
}

export async function extractPages(bytes, indices) {
  const src = await PDFDocument.load(bytes);
  const out = await PDFDocument.create();
  const pages = await out.copyPages(src, indices);
  pages.forEach((p) => out.addPage(p));
  return out.save();
}

/** Split into one file per index group. */
export async function splitGroups(bytes, groups) {
  const src = await PDFDocument.load(bytes);
  const results = [];
  for (const indices of groups) {
    const out = await PDFDocument.create();
    const pages = await out.copyPages(src, indices);
    pages.forEach((p) => out.addPage(p));
    results.push({ indices, bytes: await out.save() });
  }
  return results;
}

export function chunkIndices(total, n) {
  const groups = [];
  for (let i = 0; i < total; i += n) {
    const g = [];
    for (let j = i; j < Math.min(total, i + n); j++) g.push(j);
    groups.push(g);
  }
  return groups;
}

/**
 * Build a new document from a plan.
 * sources: Uint8Array[]; plan items: {src, page, rotate} | {blank:{w,h}}
 */
export async function buildFromPlan(sources, plan) {
  const out = await PDFDocument.create();
  const loaded = new Map();
  const load = async (i) => {
    if (!loaded.has(i)) loaded.set(i, await PDFDocument.load(sources[i]));
    return loaded.get(i);
  };
  for (const item of plan) {
    if (item.blank) {
      out.addPage([item.blank.w, item.blank.h]);
      continue;
    }
    const doc = await load(item.src);
    const [copied] = await out.copyPages(doc, [item.page]);
    const base = copied.getRotation().angle;
    copied.setRotation(degrees((((base + (item.rotate || 0)) % 360) + 360) % 360));
    out.addPage(copied);
  }
  return out.save();
}

export async function imagesToPdf(items, { fit = "original", margin = 24 } = {}) {
  const out = await PDFDocument.create();
  for (const { bytes, mime } of items) {
    const img = mime === "image/png" ? await out.embedPng(bytes) : await out.embedJpg(bytes);
    if (fit === "a4") {
      const [W, H] = [595.28, 841.89];
      const page = out.addPage([W, H]);
      const s = Math.min((W - margin * 2) / img.width, (H - margin * 2) / img.height, 1);
      const w = img.width * s;
      const h = img.height * s;
      page.drawImage(img, { x: (W - w) / 2, y: (H - h) / 2, width: w, height: h });
    } else {
      const page = out.addPage([img.width, img.height]);
      page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
    }
  }
  return out.save();
}

const FONT_TABLE = {
  Helvetica: ["Helvetica", "HelveticaBold", "HelveticaOblique", "HelveticaBoldOblique"],
  Times: ["TimesRoman", "TimesRomanBold", "TimesRomanItalic", "TimesRomanBoldItalic"],
  Courier: ["Courier", "CourierBold", "CourierOblique", "CourierBoldOblique"],
};

export function standardFontName(family, bold, italic) {
  const row = FONT_TABLE[family] || FONT_TABLE.Helvetica;
  return StandardFonts[row[(bold ? 1 : 0) + (italic ? 2 : 0)]];
}

/** Standard fonts only encode WinAnsi; replace anything else so drawing never throws. */
export function safeText(font, text) {
  let out = "";
  for (const ch of String(text)) {
    if (ch === "\n") {
      out += ch;
      continue;
    }
    try {
      font.encodeText(ch);
      out += ch;
    } catch {
      out += "?";
    }
  }
  return out;
}

export function wrapText(font, text, size, maxWidth) {
  const lines = [];
  for (const para of safeText(font, text).split("\n")) {
    const words = para.split(/(\s+)/).filter((w) => w.length);
    let line = "";
    for (const w of words) {
      const trial = line + w;
      if (line && font.widthOfTextAtSize(trial.trimEnd(), size) > maxWidth) {
        lines.push(line.trimEnd());
        line = /^\s+$/.test(w) ? "" : w;
      } else {
        line = trial;
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

/** Vertical offset from a text box's top to its first baseline (matches CSS line-height centering). */
export function baselineOffset(size, lineHeight, asc, desc) {
  return (lineHeight - (asc + desc) * size) / 2 + asc * size;
}

/** Only these targets are ever written into a PDF (never javascript:, file:, data: ...). */
function safeLinkTarget(url, pageCount) {
  const pg = /^#page=(\d+)$/.exec(url || "");
  if (pg) return +pg[1] >= 1 && +pg[1] <= pageCount ? { page: +pg[1] - 1 } : null;
  try {
    const u = new URL(url);
    return ["http:", "https:", "mailto:", "tel:"].includes(u.protocol) ? { uri: u.protocol === "mailto:" || u.protocol === "tel:" ? url : u.href } : null;
  } catch {
    return null;
  }
}

/** Clickable Link annotation over `rect` ({x0,y0,x1,y1} in PDF space). */
function addLinkAnnotation(doc, page, rect, url) {
  const target = safeLinkTarget(url, doc.getPageCount());
  if (!target) return;
  const ctx = doc.context;
  const entries = { Type: "Annot", Subtype: "Link", Rect: [rect.x0, rect.y0, rect.x1, rect.y1], Border: [0, 0, 0], F: 4 };
  const dict = ctx.obj(entries);
  if (target.uri) dict.set(PDFName.of("A"), ctx.obj({ Type: "Action", S: "URI", URI: PDFString.of(target.uri) }));
  else dict.set(PDFName.of("Dest"), ctx.obj([doc.getPage(target.page).ref, PDFName.of("Fit")]));
  page.node.addAnnot(ctx.register(dict));
}

/**
 * Draw a rich text box: per-character bold/italic/underline/colour, paragraph alignment (incl. justify),
 * bullets/numbering, indents, line/paragraph/character spacing — with glyph-aware font fallback
 * (each character uses the first face that has its glyph; the PDF's own font program comes first).
 */
async function drawRichText(doc, page, o, { toX, toY }, fonts, embedded, fontData = {}) {
  const size = o.size || 12;
  const text = String(o.text ?? "");
  const base = baseStyle(o);
  const cs = charStyles(o);
  const items = [];
  let off = 0;
  let para = 0;
  for (const ch of Array.from(text)) {
    const st = cs[off] || {};
    items.push({ ch, para, b: st.b ?? base.b, i: st.i ?? base.i, u: st.u ?? false, c: st.c ?? base.c, l: st.l ?? null });
    off += ch.length;
    if (ch === "\n") para++;
  }
  const attrs = Array.from({ length: para + 1 }, (_, p) => paraAttrs(o, p));
  const vkey = (b, i) => `${+b}${+i}`;
  const origB = o.ob ?? !!o.bold;
  const origI = o.oi ?? !!o.italic;
  const markerChars = [...(attrs.some((a) => a.list === "bullet") ? "•" : ""), ...(attrs.some((a) => a.list === "number") ? "0123456789." : "")];
  const markerItems = markerChars.map((ch) => ({ ch, b: base.b, i: base.i }));

  const variantFaces = new Map();
  const buildFaces = async (b, i) => {
    let faces = await fonts.faces(o.font, b, i, text);
    const ids = o.useOrig ? (o.origV ? o.origV[vkey(b, i)] || [] : b === origB && i === origI ? o.origFaces || [] : []) : [];
    if (ids.length) {
      const origs = [];
      for (const id of ids) {
        if (!fontData[id]) continue;
        try { origs.push({ id: `orig:${id}`, bytes: fontData[id], fk: fonts.fontkit.create(fontData[id]) }); } catch { /* unusable font program */ }
      }
      faces = [...origs, ...faces];
    }
    return faces;
  };
  for (const it of [...items, ...markerItems]) {
    if (it.ch !== "\n" && !variantFaces.has(vkey(it.b, it.i))) variantFaces.set(vkey(it.b, it.i), await buildFaces(it.b, it.i));
  }
  const pick = (it) => {
    const faces = variantFaces.get(vkey(it.b, it.i));
    const cp = it.ch.codePointAt(0);
    let fi = faces.findIndex((f) => f.fk.hasGlyphForCodePoint(cp));
    let ch = it.ch;
    if (fi < 0) { ch = "?"; fi = faces.findIndex((f) => f.fk.hasGlyphForCodePoint(63)); if (fi < 0) fi = 0; }
    return { fi, ch };
  };
  for (;;) {
    const needed = new Map();
    for (const it of [...items, ...markerItems]) {
      if (it.ch === "\n") continue;
      const r = pick(it);
      it.fi = r.fi; it.ch2 = r.ch;
      needed.set(`${vkey(it.b, it.i)}:${r.fi}`, { key: vkey(it.b, it.i), fi: r.fi });
    }
    let failed = null;
    for (const n of needed.values()) {
      const f = variantFaces.get(n.key)[n.fi];
      try {
        if (!embedded.has(f.id)) embedded.set(f.id, await doc.embedFont(f.bytes, { subset: true }));
      } catch (e) {
        if (!f.id.startsWith("orig:")) throw e;
        failed = n;
        break;
      }
    }
    if (!failed) break;
    variantFaces.set(failed.key, variantFaces.get(failed.key).filter((_, k) => k !== failed.fi)); // original font can't be embedded
  }
  const fontOf = (it) => embedded.get(variantFaces.get(vkey(it.b, it.i))[it.fi].id);
  const track = o.tracking || 0;
  const widthOf = (arr) => {
    let w = 0;
    for (let a = 0; a < arr.length;) {
      const f = fontOf(arr[a]);
      let z = a + 1;
      while (z < arr.length && fontOf(arr[z]) === f) z++;
      w += f.widthOfTextAtSize(arr.slice(a, z).map((x) => x.ch2).join(""), size) + track * (z - a);
      a = z;
    }
    return w;
  };

  const L = o.lineHeight || size * 1.2;
  const primary = (variantFaces.get(vkey(base.b, base.i)) || [...variantFaces.values()][0])[0].fk;
  const upm = primary.unitsPerEm || 1000;
  const asc = o.asc ?? primary.ascent / upm;
  const desc = o.desc ?? -primary.descent / upm;
  const off0 = baselineOffset(size, L, asc, desc);
  const wrapOn = o.wrap !== false;
  const paraSpace = o.paraSpace || 0;

  const drawPieces = (pieces, x, y, extra) => {
    const links = [];
    for (const pc of pieces) {
      const w = pc.f.widthOfTextAtSize(pc.text, size) + track * pc.n;
      if (pc.text.trim()) {
        if (track) page.pushOperators(setCharacterSpacing(track));
        page.drawText(pc.text, { x: toX(x), y, size, font: pc.f, color: hexToRgb(pc.c) });
        if (track) page.pushOperators(setCharacterSpacing(0));
      }
      if (pc.u && pc.text.length) {
        page.drawLine({ start: { x: toX(x), y: y - size * 0.12 }, end: { x: toX(x + w), y: y - size * 0.12 }, thickness: Math.max(0.5, size / 18), color: hexToRgb(pc.c) });
      }
      const wFull = w + (pc.sp ? extra : 0);
      if (pc.l) {
        const last = links[links.length - 1];
        if (last && last.url === pc.l && Math.abs(last.x1 - x) < 0.6) last.x1 = x + wFull;
        else links.push({ url: pc.l, x0: x, x1: x + wFull });
      }
      x += wFull;
    }
    for (const lk of links) addLinkAnnotation(doc, page, { x0: toX(lk.x0), x1: toX(lk.x1), y0: y - size * 0.24, y1: y + size * 0.82 }, lk.url);
  };
  const toPieces = (line, splitSpaces) => {
    const pieces = [];
    for (const it of line) {
      const f = fontOf(it);
      const sp = it.ch === " ";
      const last = pieces[pieces.length - 1];
      if (last && last.f === f && last.c === it.c && last.u === it.u && last.l === (it.l ?? null) && (!splitSpaces || (!sp && !last.sp))) { last.text += it.ch2; last.n++; }
      else pieces.push({ f, c: it.c, u: it.u, l: it.l ?? null, text: it.ch2, sp, n: 1 });
    }
    return pieces;
  };

  let lineNo = 0;
  let counter = 0;
  attrs.forEach((a, p) => {
    const pItems = items.filter((it) => it.para === p && it.ch !== "\n");
    const ind = a.indent * INDENT_PT;
    const hang = a.list ? hangFor(size) : 0;
    const x0 = o.x + ind + hang;
    const avail = Math.max((o.w || 0) - ind - hang, size);
    // wrap at spaces
    const lines = [];
    if (!wrapOn) lines.push(pItems);
    else {
      const tokens = [];
      for (const it of pItems) {
        const sp = /\s/.test(it.ch);
        const last = tokens[tokens.length - 1];
        if (last && last.sp === sp && !sp) last.items.push(it);
        else tokens.push({ sp, items: [it] });
      }
      let line = [];
      for (const t of tokens) {
        if (line.length && !t.sp && widthOf([...line, ...t.items]) > avail + 0.01) {
          while (line.length && /\s/.test(line[line.length - 1].ch)) line.pop();
          lines.push(line);
          line = [];
        }
        if (t.sp && !line.length) continue;
        line.push(...t.items);
      }
      while (line.length && /\s/.test(line[line.length - 1].ch)) line.pop();
      lines.push(line);
    }
    if (a.list === "number") counter++; else counter = 0;
    lines.forEach((line, li) => {
      const y = toY(o.y + off0 + lineNo * L + p * paraSpace);
      lineNo++;
      if (li === 0 && a.list) {
        const marker = a.list === "bullet" ? "•" : `${counter}.`;
        const mitems = Array.from(marker).map((ch) => ({ ch, b: base.b, i: base.i, c: pItems[0]?.c ?? base.c, u: false }));
        for (const mi of mitems) { const r = pick(mi); mi.fi = r.fi; mi.ch2 = r.ch; }
        drawPieces(toPieces(mitems, false), o.x + ind, y, 0);
      }
      const lw = widthOf(line);
      let x = x0;
      let extra = 0;
      if (a.align === "center") x = x0 + (avail - lw) / 2;
      else if (a.align === "right") x = x0 + avail - lw;
      else if (a.align === "justify" && wrapOn && li < lines.length - 1) {
        const spaces = line.filter((it) => it.ch === " ").length;
        if (spaces) extra = Math.max(0, (avail - lw) / spaces);
      }
      drawPieces(toPieces(line, extra > 0), x, y, extra);
    });
  });
}

/**
 * Apply editor objects to a PDF. Coordinates in `objects` are PDF points measured from the
 * top-left corner of the page's crop box (the frame pdf.js displays).
 * editsByPage: { [pageIndex]: object[] }, assets: { [id]: {bytes, mime} }
 */
export async function applyEdits(bytes, editsByPage, assets = {}, { fonts, fontData = {} } = {}) {
  const doc = await PDFDocument.load(bytes);
  if (fonts) doc.registerFontkit(fonts.fontkit);
  const embeddedFaces = new Map();
  const fontCache = new Map();
  const getFont = async (family, bold, italic) => {
    const name = standardFontName(family, bold, italic);
    if (!fontCache.has(name)) fontCache.set(name, await doc.embedFont(name));
    return fontCache.get(name);
  };
  const imgCache = new Map();
  const getImage = async (id) => {
    if (!imgCache.has(id)) {
      const a = assets[id];
      if (!a) throw new Error(`Missing image asset ${id}`);
      imgCache.set(id, a.mime === "image/png" ? await doc.embedPng(a.bytes) : await doc.embedJpg(a.bytes));
    }
    return imgCache.get(id);
  };

  const pages = doc.getPages();
  for (const [key, objects] of Object.entries(editsByPage)) {
    const page = pages[Number(key)];
    if (!page || !objects?.length) continue;
    const box = page.getCropBox();
    const toY = (y, h = 0) => box.y + box.height - y - h;
    const toX = (x) => box.x + x;

    // Edited text really replaces the original: drop the original text operators under the cover boxes.
    const strips = objects.filter((o) => o.type === "rect" && o.strip).map((o) => ({
      x0: box.x + o.strip.x, x1: box.x + o.strip.x + o.strip.w,
      y0: toY(o.strip.y, o.strip.h), y1: toY(o.strip.y),
    }));
    if (strips.length) {
      try { removeTextFromPage(doc, page, strips); } catch (e) { console.warn("Could not remove original text; it stays covered:", e); }
    }

    for (const o of objects) {
      if (o.type === "rect") {
        const opacity = o.opacity ?? 1;
        page.drawRectangle({
          x: toX(o.x),
          y: toY(o.y, o.h),
          width: o.w,
          height: o.h,
          color: o.fill ? hexToRgb(o.fill) : undefined,
          opacity: o.fill ? opacity : undefined,
          borderColor: o.stroke ? hexToRgb(o.stroke) : undefined,
          borderWidth: o.stroke ? o.strokeWidth || 1 : 0,
          borderOpacity: o.stroke ? 1 : undefined,
        });
      } else if (o.type === "text" && fonts) {
        await drawRichText(doc, page, o, { toX, toY }, fonts, embeddedFaces, fontData);
      } else if (o.type === "text") {
        const font = await getFont(o.font, o.bold, o.italic);
        const size = o.size || 12;
        const lineHeight = size * 1.2;
        const lines = wrapText(font, o.text || "", size, Math.max(o.w, size));
        lines.forEach((line, i) => {
          const lw = font.widthOfTextAtSize(line, size);
          let x = o.x;
          if (o.align === "center") x += (o.w - lw) / 2;
          else if (o.align === "right") x += o.w - lw;
          page.drawText(line, {
            x: toX(x),
            y: toY(o.y + size * 0.93 + i * lineHeight),
            size,
            font,
            color: hexToRgb(o.color || "#000000"),
          });
        });
      } else if (o.type === "image") {
        const img = await getImage(o.asset);
        page.drawImage(img, { x: toX(o.x), y: toY(o.y, o.h), width: o.w, height: o.h, opacity: o.opacity ?? 1 });
      } else if (o.type === "ink") {
        const pts = o.points || [];
        const color = hexToRgb(o.color || "#000000");
        for (let i = 1; i < pts.length; i++) {
          page.drawLine({
            start: { x: toX(pts[i - 1][0]), y: toY(pts[i - 1][1]) },
            end: { x: toX(pts[i][0]), y: toY(pts[i][1]) },
            thickness: o.width || 2,
            color,
            lineCap: LineCapStyle.Round,
          });
        }
      }
    }
  }
  return doc.save();
}

/** Remove document-level metadata (used after redaction). */
export async function stripMetadata(bytes) {
  const doc = await PDFDocument.load(bytes);
  doc.setTitle("");
  doc.setAuthor("");
  doc.setSubject("");
  doc.setKeywords([]);
  doc.setProducer("");
  doc.setCreator("");
  return doc.save();
}

/** Word-box invisible text layer for OCR. words: [{text,x0,y0,x1,y1}] in pixels at `scale` px per point. */
export async function addInvisibleText(doc, page, words, scale) {
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const box = page.getCropBox();
  for (const w of words) {
    const text = safeText(font, w.text).replace(/\s+/g, " ").trim();
    if (!text) continue;
    const bw = (w.x1 - w.x0) / scale;
    const bh = (w.y1 - w.y0) / scale;
    let size = Math.max(bh * 0.85, 2);
    const tw = font.widthOfTextAtSize(text, size);
    if (tw > bw && bw > 0) size = Math.max(size * (bw / tw), 1);
    page.drawText(text, {
      x: box.x + w.x0 / scale,
      y: box.y + box.height - w.y1 / scale + bh * 0.15,
      size,
      font,
      color: rgb(1, 1, 1),
      opacity: 0,
    });
  }
}
