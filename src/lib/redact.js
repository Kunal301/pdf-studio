import { PDFDocument, degrees } from "pdf-lib";
import { renderToCanvas, getTextRuns, groupLines, pageBox } from "./pdf.js";

/**
 * Permanently redact: every page with redaction boxes is re-created from a rasterized image with the
 * boxes burned in, so the original text/images underneath no longer exist in the file.
 * boxesByPage: {[pageIndex]: {x,y,w,h}[]} in points from the top-left of the page's crop box.
 */
export async function applyRedactions(bytes, doc, boxesByPage, { stripMeta = true, scale = 2.5 } = {}) {
  const src = await PDFDocument.load(bytes);
  const out = await PDFDocument.create();
  for (let i = 0; i < src.getPageCount(); i++) {
    const boxes = boxesByPage[i];
    if (!boxes?.length) {
      const [p] = await out.copyPages(src, [i]);
      out.addPage(p);
      continue;
    }
    const page = await doc.getPage(i + 1);
    const canvas = document.createElement("canvas");
    await renderToCanvas(page, canvas, scale, { rotation: 0 });
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#000";
    for (const b of boxes) ctx.fillRect(Math.floor(b.x * scale), Math.floor(b.y * scale), Math.ceil(b.w * scale) + 1, Math.ceil(b.h * scale) + 1);
    const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.92));
    const img = await out.embedJpg(new Uint8Array(await blob.arrayBuffer()));
    const { w, h } = pageBox(page);
    const np = out.addPage([w, h]);
    np.drawImage(img, { x: 0, y: 0, width: w, height: h });
    if (page.rotate) np.setRotation(degrees(page.rotate));
  }
  if (stripMeta) {
    out.setTitle(""); out.setAuthor(""); out.setSubject(""); out.setKeywords([]); out.setProducer(""); out.setCreator("");
  }
  return out.save();
}

export const PATTERNS = {
  email: { label: "Email addresses", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  phone: { label: "Phone numbers", re: /(?:\+?\d{1,3}[ .-]?)?(?:\(\d{3}\)|\d{3})[ .-]?\d{3}[ .-]?\d{4}/g },
  ssn: { label: "SSN-style numbers", re: /\b\d{3}-\d{2}-\d{4}\b/g },
  card: { label: "Card-style numbers", re: /\b(?:\d[ -]?){13,19}\b/g },
};

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Find matches (per visual line, across text runs) and return boxes in points. */
export async function findTextBoxes(doc, { query, patterns = [] }) {
  const regexes = [];
  if (query) regexes.push(new RegExp(escapeRe(query), "gi"));
  for (const k of patterns) regexes.push(new RegExp(PATTERNS[k].re.source, "g"));
  const hits = [];
  for (let p = 0; p < doc.numPages; p++) {
    const page = await doc.getPage(p + 1);
    const runs = await getTextRuns(page);
    for (const line of groupLines(runs)) {
      let text = "";
      const spans = []; // per character: {x0,x1}
      let prevEnd = null;
      for (const r of line.runs) {
        if (prevEnd != null && r.x - prevEnd > r.size * 0.15) {
          text += " ";
          spans.push({ x0: prevEnd, x1: r.x });
        }
        const cw = r.w / Math.max(1, r.str.length);
        for (let c = 0; c < r.str.length; c++) spans.push({ x0: r.x + c * cw, x1: r.x + (c + 1) * cw });
        text += r.str;
        prevEnd = r.x + r.w;
      }
      const top = Math.min(...line.runs.map((r) => r.top));
      const bottom = Math.max(...line.runs.map((r) => r.top + r.h));
      for (const re of regexes) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(text))) {
          if (!m[0].length) { re.lastIndex++; continue; }
          const a = spans[m.index], b = spans[m.index + m[0].length - 1];
          if (a && b) hits.push({ page: p, x: a.x0 - 1, y: top - 1, w: b.x1 - a.x0 + 2, h: bottom - top + 2, text: m[0] });
        }
      }
    }
  }
  return hits;
}
