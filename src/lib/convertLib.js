// Conversions between PDF and Word / Excel / PowerPoint / images / text.
// These run entirely in the browser. PDF -> editable formats reconstruct content from the text layer
// (headings, paragraphs, table-like rows); use the "page images" mode when exact visual fidelity matters.
import { getTextRuns, groupLines, pageBox, renderToCanvas } from "./pdf.js";
import { renderBlocks } from "./layout.js";
import { canvasToBlob } from "./util.js";

const median = (arr) => { if (!arr.length) return 12; const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

function joinRuns(runs) {
  let s = "";
  let prevEnd = null;
  for (const r of runs) {
    if (prevEnd != null && r.x - prevEnd > r.size * 0.15 && !s.endsWith(" ") && !r.str.startsWith(" ")) s += " ";
    s += r.str;
    prevEnd = r.x + r.w;
  }
  return s;
}

/** Lines -> paragraphs with heading detection for one page. */
export async function pageParagraphs(page) {
  const runs = await getTextRuns(page);
  const lines = groupLines(runs).map((l) => ({ text: joinRuns(l.runs).trim(), size: l.size, x: l.runs[0].x, baseline: l.baseline })).filter((l) => l.text);
  const body = median(lines.map((l) => l.size));
  const paras = [];
  let cur = null;
  for (const l of lines) {
    const heading = l.size >= body * 1.25 ? (l.size >= body * 1.7 ? 1 : l.size >= body * 1.4 ? 2 : 3) : 0;
    const gap = cur ? l.baseline - cur.lastBaseline : Infinity;
    const sameBlock = cur && !heading && !cur.heading && gap < Math.max(l.size, cur.size) * 1.7 && Math.abs(l.size - cur.size) < body * 0.25;
    if (sameBlock) {
      cur.text += (cur.text.endsWith("-") ? "" : " ") + l.text;
      cur.lastBaseline = l.baseline;
    } else {
      cur = { text: l.text, size: l.size, heading, lastBaseline: l.baseline };
      paras.push(cur);
    }
  }
  return paras;
}

export async function pdfToImages(doc, { format = "png", dpi = 150, onProgress } = {}) {
  const out = [];
  for (let n = 1; n <= doc.numPages; n++) {
    onProgress?.((n - 1) / doc.numPages, `Rendering page ${n}/${doc.numPages}`);
    const page = await doc.getPage(n);
    const canvas = document.createElement("canvas");
    await renderToCanvas(page, canvas, dpi / 72);
    const blob = await canvasToBlob(canvas, format === "jpeg" ? "image/jpeg" : "image/png", 0.92);
    out.push({ name: `page-${String(n).padStart(String(doc.numPages).length, "0")}.${format === "jpeg" ? "jpg" : "png"}`, bytes: new Uint8Array(await blob.arrayBuffer()) });
  }
  return out;
}

async function pageJpeg(doc, n, scale) {
  const page = await doc.getPage(n);
  const canvas = document.createElement("canvas");
  await renderToCanvas(page, canvas, scale);
  const blob = await canvasToBlob(canvas, "image/jpeg", 0.9);
  return { page, canvas, bytes: new Uint8Array(await blob.arrayBuffer()) };
}

export async function pdfToDocx(doc, { mode = "text", onProgress } = {}) {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, ImageRun, PageBreak } = await import("docx");
  const sections = [];
  if (mode === "image") {
    for (let n = 1; n <= doc.numPages; n++) {
      onProgress?.((n - 1) / doc.numPages, `Page ${n}/${doc.numPages}`);
      const { page, bytes } = await pageJpeg(doc, n, 2);
      const { w, h } = pageBox(page);
      sections.push({
        properties: { page: { size: { width: Math.round(w * 20), height: Math.round(h * 20) }, margin: { top: 0, right: 0, bottom: 0, left: 0, header: 0, footer: 0 } } },
        children: [new Paragraph({ spacing: { before: 0, after: 0 }, children: [new ImageRun({ type: "jpg", data: bytes, transformation: { width: (w * 96) / 72, height: (h * 96) / 72 } })] })],
      });
    }
  } else {
    const children = [];
    const levels = { 1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2, 3: HeadingLevel.HEADING_3 };
    for (let n = 1; n <= doc.numPages; n++) {
      onProgress?.((n - 1) / doc.numPages, `Page ${n}/${doc.numPages}`);
      const paras = await pageParagraphs(await doc.getPage(n));
      for (const p of paras) {
        children.push(new Paragraph({
          heading: p.heading ? levels[p.heading] : undefined,
          spacing: { after: 120 },
          children: [new TextRun({ text: p.text, ...(p.heading ? {} : { size: 22 }) })],
        }));
      }
      if (n < doc.numPages) children.push(new Paragraph({ children: [new PageBreak()] }));
    }
    if (!children.length) children.push(new Paragraph({ children: [new TextRun("(No selectable text found. Try the “page images” mode, or run OCR first.)")] }));
    sections.push({ children });
  }
  const d = new Document({ creator: "PDF Studio", sections });
  return new Uint8Array(await (await Packer.toBlob(d)).arrayBuffer());
}

export async function pdfToXlsx(doc, { onProgress } = {}) {
  const { default: ExcelJS } = await import("exceljs");
  const wb = new ExcelJS.Workbook();
  wb.creator = "PDF Studio";
  let any = false;
  for (let n = 1; n <= doc.numPages; n++) {
    onProgress?.((n - 1) / doc.numPages, `Page ${n}/${doc.numPages}`);
    const page = await doc.getPage(n);
    const lines = groupLines(await getTextRuns(page));
    if (!lines.length) continue;
    any = true;
    const ws = wb.addWorksheet(`Page ${n}`);
    for (const line of lines) {
      const cells = [];
      let cur = null;
      let prevEnd = null;
      for (const r of line.runs) {
        if (cur != null && r.x - prevEnd <= r.size * 0.9) cur += (r.x - prevEnd > r.size * 0.15 ? " " : "") + r.str;
        else { if (cur != null) cells.push(cur.trim()); cur = r.str; }
        prevEnd = r.x + r.w;
      }
      if (cur != null) cells.push(cur.trim());
      ws.addRow(cells.map((c) => (/^-?\$?[\d,]+(\.\d+)?%?$/.test(c) && /\d/.test(c) && !/^0\d/.test(c) ? toNumber(c) : c)));
    }
    ws.columns.forEach((col) => {
      let max = 8;
      col.eachCell?.({ includeEmpty: false }, (c) => { max = Math.max(max, Math.min(60, String(c.value ?? "").length + 2)); });
      col.width = max;
    });
  }
  if (!any) wb.addWorksheet("Empty").addRow(["No selectable text found. Run OCR first for scanned PDFs."]);
  return new Uint8Array(await wb.xlsx.writeBuffer());
}
const toNumber = (s) => { const pct = s.endsWith("%"); const n = parseFloat(s.replace(/[$,%]/g, "")); return pct ? n / 100 : n; };

export async function pdfToPptx(doc, { mode = "image", onProgress } = {}) {
  const { default: PptxGenJS } = await import("pptxgenjs");
  const pres = new PptxGenJS();
  const first = pageBox(await doc.getPage(1));
  const W = first.w / 72, H = first.h / 72;
  pres.defineLayout({ name: "PDFPAGE", width: W, height: H });
  pres.layout = "PDFPAGE";
  for (let n = 1; n <= doc.numPages; n++) {
    onProgress?.((n - 1) / doc.numPages, `Page ${n}/${doc.numPages}`);
    const slide = pres.addSlide();
    if (mode === "image") {
      const { bytes } = await pageJpeg(doc, n, 2);
      slide.addImage({ data: `image/jpeg;base64,${btoa(bin(bytes))}`, x: 0, y: 0, w: W, h: H });
    } else {
      const page = await doc.getPage(n);
      for (const line of groupLines(await getTextRuns(page))) {
        const text = joinRuns(line.runs).trim();
        if (!text) continue;
        const x = line.runs[0].x, last = line.runs[line.runs.length - 1];
        const top = Math.min(...line.runs.map((r) => r.top));
        slide.addText(text, { x: x / 72, y: top / 72, w: (last.x + last.w - x + 12) / 72, h: (line.size * 1.3) / 72, fontSize: Math.max(6, line.size), fontFace: "Arial", color: "000000", margin: 0, valign: "top", wrap: false });
      }
    }
  }
  const buf = await pres.write({ outputType: "arraybuffer" });
  return new Uint8Array(buf);
}
function bin(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return s;
}

// ---------------------------------------------------------------- to PDF

const decodeEntities = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

export function textToPdf(text) {
  const blocks = String(text).replace(/\r\n?/g, "\n").split("\n").map((line) => ({ type: "p", runs: [{ text: line || " " }] }));
  return renderBlocks(blocks);
}

export function csvToRows(text) {
  const rows = [];
  let row = [], cell = "", q = false;
  const s = String(text).replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === "," || c === ";" || c === "\t") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && s[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

export function rowsToPdf(rows, title) {
  const blocks = [];
  if (title) blocks.push({ type: "h", level: 2, runs: [{ text: title }] });
  blocks.push({ type: "table", header: true, rows: rows.map((r) => r.map((c) => [{ text: String(c ?? "") }])) });
  return renderBlocks(blocks, { landscape: true, margin: 36, baseSize: 10 });
}

export async function xlsxToPdf(bytes) {
  const { default: ExcelJS } = await import("exceljs");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes);
  const blocks = [];
  wb.eachSheet((ws) => {
    blocks.push({ type: "h", level: 2, runs: [{ text: ws.name }] });
    const cols = Math.max(1, ws.columnCount);
    const rows = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const cells = [];
      for (let c = 1; c <= cols; c++) cells.push(row.getCell(c).text ?? "");
      rows.push(cells);
    });
    if (rows.length) blocks.push({ type: "table", header: true, rows: rows.map((r) => r.map((c) => [{ text: c }])) });
    blocks.push({ type: "pagebreak" });
  });
  if (blocks.at(-1)?.type === "pagebreak") blocks.pop();
  return renderBlocks(blocks, { landscape: true, margin: 36, baseSize: 10 });
}

function dataUrlInfo(src) {
  const m = /^data:(image\/(png|jpe?g));base64,(.*)$/i.exec(src || "");
  if (!m) return null;
  const bin2 = atob(m[3]);
  const bytes = new Uint8Array(bin2.length);
  for (let i = 0; i < bin2.length; i++) bytes[i] = bin2.charCodeAt(i);
  return { bytes, mime: /png/i.test(m[2]) ? "image/png" : "image/jpeg" };
}

export async function docxToPdf(bytes) {
  const { default: mammoth } = await import("mammoth/mammoth.browser.js");
  const { value: html } = await mammoth.convertToHtml({ arrayBuffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }, {
    convertImage: mammoth.images.imgElement(async (img) => ({ src: `data:${img.contentType};base64,${await img.read("base64")}` })),
  });
  const dom = new DOMParser().parseFromString(html, "text/html");
  const blocks = [];
  const runsOf = (node, st = {}) => {
    const out = [];
    node.childNodes.forEach((n) => {
      if (n.nodeType === 3) {
        const t = n.textContent.replace(/\s+/g, " ");
        if (t) out.push({ text: t, bold: st.bold, italic: st.italic });
      } else if (n.nodeType === 1) {
        const tag = n.tagName.toLowerCase();
        if (tag === "br") out.push({ text: "\n" });
        else if (tag !== "img") out.push(...runsOf(n, { bold: st.bold || tag === "strong" || tag === "b", italic: st.italic || tag === "em" || tag === "i" }));
      }
    });
    return out;
  };
  const pushImages = (el) => el.querySelectorAll("img").forEach((im) => { const i = dataUrlInfo(im.getAttribute("src")); if (i) blocks.push({ type: "img", ...i }); });
  const walk = (el, listCtx) => {
    for (const n of el.children) {
      const tag = n.tagName.toLowerCase();
      if (/^h[1-6]$/.test(tag)) blocks.push({ type: "h", level: Math.min(3, +tag[1]), runs: runsOf(n) });
      else if (tag === "p") { const runs = runsOf(n); if (runs.some((r) => r.text.trim())) blocks.push(listCtx ? { type: "li", runs, marker: listCtx.marker() } : { type: "p", runs }); pushImages(n); }
      else if (tag === "ul" || tag === "ol") { let i = 0; walk2(n, tag === "ol" ? () => `${++i}.` : () => "•"); }
      else if (tag === "table") {
        const rows = [...n.querySelectorAll("tr")].map((tr) => [...tr.children].map((td) => runsOf(td)));
        blocks.push({ type: "table", header: !!n.querySelector("th"), rows });
      } else walk(n, listCtx);
    }
  };
  const walk2 = (listEl, marker) => {
    for (const li of listEl.children) {
      if (li.tagName.toLowerCase() !== "li") continue;
      const own = runsOf(li.cloneNode(true).cloneNode(true));
      const nested = li.querySelector("ul,ol");
      let runs = own;
      if (nested) { const clone = li.cloneNode(true); clone.querySelectorAll("ul,ol").forEach((x) => x.remove()); runs = runsOf(clone); }
      blocks.push({ type: "li", runs, marker: marker() });
      pushImages(li);
      if (nested) { let i = 0; walk2(nested, nested.tagName.toLowerCase() === "ol" ? () => `${++i}.` : () => "–"); }
    }
  };
  walk(dom.body);
  if (!blocks.length) blocks.push({ type: "p", runs: [{ text: "(This document has no text content.)" }] });
  return renderBlocks(blocks);
}

export async function pptxToPdf(bytes) {
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(bytes);
  const slideFiles = Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f)).sort((a, b) => +a.match(/(\d+)\.xml/)[1] - +b.match(/(\d+)\.xml/)[1]);
  const blocks = [];
  let n = 0;
  for (const f of slideFiles) {
    n++;
    if (n > 1) blocks.push({ type: "pagebreak" });
    const xml = await zip.file(f).async("string");
    const paras = [...xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>|<a:p [^>]*>([\s\S]*?)<\/a:p>/g)].map((m) => [...(m[1] ?? m[2]).matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)].map((t) => decodeEntities(t[1])).join("")).filter((t) => t.trim());
    blocks.push({ type: "h", level: 3, runs: [{ text: `Slide ${n}` }] });
    paras.forEach((t, i) => blocks.push(i === 0 ? { type: "h", level: 1, runs: [{ text: t }] } : { type: "li", runs: [{ text: t }] }));
    const relPath = f.replace("slides/", "slides/_rels/") + ".rels";
    const rels = zip.file(relPath) ? await zip.file(relPath).async("string") : "";
    const map = Object.fromEntries([...rels.matchAll(/<Relationship [^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)].map((m) => [m[1], m[2]]));
    for (const m of xml.matchAll(/r:embed="([^"]+)"/g)) {
      const target = map[m[1]];
      if (!target) continue;
      const path = "ppt/" + target.replace(/^\.\.\//, "");
      const file = zip.file(path);
      if (file && /\.(png|jpe?g)$/i.test(path)) blocks.push({ type: "img", bytes: await file.async("uint8array"), mime: /png$/i.test(path) ? "image/png" : "image/jpeg" });
    }
  }
  if (!blocks.length) blocks.push({ type: "p", runs: [{ text: "(No slides found.)" }] });
  return renderBlocks(blocks, { landscape: true, margin: 48, baseSize: 14 });
}
