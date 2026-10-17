// Tiny rich-text layout engine used for Word/Excel/PowerPoint/text -> PDF conversion.
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { safeText } from "./ops.js";

const A4 = [595.28, 841.89];

/**
 * blocks:
 *  {type:'h', level:1-3, runs}, {type:'p', runs}, {type:'li', runs, marker}
 *  {type:'table', rows:[[runs]]}, {type:'img', bytes, mime}, {type:'pagebreak'}
 * runs: [{text, bold?, italic?}]
 */
export async function renderBlocks(blocks, { landscape = false, margin = 54, baseSize = 11 } = {}) {
  const doc = await PDFDocument.create();
  const fonts = {
    r: await doc.embedFont(StandardFonts.Helvetica),
    b: await doc.embedFont(StandardFonts.HelveticaBold),
    i: await doc.embedFont(StandardFonts.HelveticaOblique),
    bi: await doc.embedFont(StandardFonts.HelveticaBoldOblique),
  };
  const [W, H] = landscape ? [A4[1], A4[0]] : A4;
  const maxW = W - margin * 2;
  let page = null;
  let y = 0;
  const newPage = () => {
    page = doc.addPage([W, H]);
    y = H - margin;
  };
  newPage();

  const fontFor = (run, forceBold) => {
    const b = forceBold || run.bold;
    return b && run.italic ? fonts.bi : b ? fonts.b : run.italic ? fonts.i : fonts.r;
  };

  /** Break runs into positioned lines of {text, font, x}. */
  const wrapRuns = (runs, size, width, forceBold) => {
    const tokens = [];
    for (const run of runs) {
      const font = fontFor(run, forceBold);
      for (const part of safeText(font, run.text).split(/(\s+)/)) {
        if (!part) continue;
        if (part.includes("\n")) {
          tokens.push({ br: true });
          continue;
        }
        tokens.push({ text: part, font, space: /^\s+$/.test(part) });
      }
    }
    const lines = [];
    let line = [];
    let lw = 0;
    const flush = () => {
      while (line.length && line[line.length - 1].space) line.pop();
      lines.push(line);
      line = [];
      lw = 0;
    };
    for (const t of tokens) {
      if (t.br) {
        flush();
        continue;
      }
      const w = t.font.widthOfTextAtSize(t.text, size);
      if (!t.space && lw + w > width && line.length) flush();
      if (t.space && !line.length) continue;
      line.push({ ...t, w });
      lw += w;
    }
    flush();
    return lines;
  };

  const drawLines = (lines, x0, size, color = rgb(0, 0, 0)) => {
    const lh = size * 1.35;
    for (const line of lines) {
      if (y - lh < margin) newPage();
      y -= lh;
      let x = x0;
      for (const t of line) {
        if (!t.space) page.drawText(t.text, { x, y: y + size * 0.25, size, font: t.font, color });
        x += t.w;
      }
    }
  };

  for (const b of blocks) {
    if (b.type === "pagebreak") {
      newPage();
    } else if (b.type === "h") {
      const size = { 1: 20, 2: 16, 3: 13 }[b.level] || 13;
      y -= size * 0.6;
      drawLines(wrapRuns(b.runs, size, maxW, true), margin, size);
      y -= size * 0.2;
    } else if (b.type === "p") {
      drawLines(wrapRuns(b.runs, baseSize, maxW), margin, baseSize);
      y -= baseSize * 0.5;
    } else if (b.type === "li") {
      const indent = 18;
      const marker = b.marker || "•";
      const lines = wrapRuns(b.runs, baseSize, maxW - indent);
      if (y - baseSize * 1.35 < margin) newPage();
      page.drawText(safeText(fonts.r, marker), { x: margin + 2, y: y - baseSize * 1.35 + baseSize * 0.25, size: baseSize, font: fonts.r });
      drawLines(lines, margin + indent, baseSize);
      y -= baseSize * 0.2;
    } else if (b.type === "img") {
      try {
        const img = b.mime === "image/png" ? await doc.embedPng(b.bytes) : await doc.embedJpg(b.bytes);
        const s = Math.min(maxW / img.width, (H - margin * 2) / img.height, 1);
        const w = img.width * s;
        const h = img.height * s;
        if (y - h < margin) newPage();
        page.drawImage(img, { x: margin, y: y - h, width: w, height: h });
        y -= h + 8;
      } catch {
        /* unsupported image: skip */
      }
    } else if (b.type === "table") {
      const rows = b.rows;
      const cols = Math.max(1, ...rows.map((r) => r.length));
      const cw = maxW / cols;
      const size = Math.max(7, Math.min(baseSize - 1, cw / 7));
      const pad = 3;
      for (let ri = 0; ri < rows.length; ri++) {
        const cells = Array.from({ length: cols }, (_, ci) => wrapRuns(rows[ri][ci] || [], size, cw - pad * 2, ri === 0 && b.header));
        const lh = size * 1.3;
        const rowH = Math.max(...cells.map((c) => c.length || 1)) * lh + pad * 2;
        if (y - rowH < margin) newPage();
        cells.forEach((lines, ci) => {
          const x = margin + ci * cw;
          page.drawRectangle({ x, y: y - rowH, width: cw, height: rowH, borderColor: rgb(0.7, 0.7, 0.7), borderWidth: 0.5 });
          let ty = y - pad;
          for (const line of lines) {
            ty -= lh;
            let tx = x + pad;
            for (const t of line) {
              if (!t.space) page.drawText(t.text, { x: tx, y: ty + size * 0.25, size, font: t.font });
              tx += t.w;
            }
          }
        });
        y -= rowH;
      }
      y -= baseSize * 0.6;
    }
  }
  return doc.save();
}
