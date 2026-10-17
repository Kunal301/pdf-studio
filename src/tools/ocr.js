import { h, download, baseName, readBytes, imageFileToEmbeddable, canvasToBlob } from "../lib/util.js";
import { dropzone, iconEl, toast, progressBar, fileChip } from "../lib/ui.js";
import { loadPdfFile, renderToCanvas } from "../lib/pdf.js";
import { addInvisibleText } from "../lib/ops.js";
import { PDFDocument } from "pdf-lib";

const LANGS = [["eng", "English"]];

async function createOcrWorker(lang, logger) {
  const { createWorker } = await import("tesseract.js");
  return createWorker(lang, 1, {
    workerPath: "/vendor/tesseract/worker.min.js",
    corePath: "/vendor/tesseract/core",
    langPath: "/vendor/tessdata",
    gzip: true,
    logger,
  });
}

/** Flatten tesseract output into word boxes regardless of result shape. */
function wordsOf(data) {
  if (Array.isArray(data.words) && data.words.length) return data.words;
  const out = [];
  for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) for (const w of l.words || []) out.push(w);
  return out;
}

/** Map a box measured in a page rendered with `rotate` back to the unrotated frame (points). */
export function unrotate(box, rotate, W, H) {
  const pts = [[box.x0, box.y0], [box.x1, box.y0], [box.x1, box.y1], [box.x0, box.y1]].map(([u, v]) => {
    if (rotate === 90) return [v, H - u];
    if (rotate === 180) return [W - u, H - v];
    if (rotate === 270) return [W - v, u];
    return [u, v];
  });
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

export async function mount(root) {
  let files = [];
  const listEl = h("div.row");
  const langSel = h("select", { "aria-label": "Language" }, LANGS.map(([v, l]) => h("option", { value: v }, l)));
  const qualitySel = h("select", { "aria-label": "Quality" }, [["2", "Standard (faster)"], ["3", "High (slower, more accurate)"]].map(([v, l]) => h("option", { value: v }, l)));
  const wantPdf = h("input", { type: "checkbox", checked: true });
  const wantTxt = h("input", { type: "checkbox", checked: true });
  const runBtn = h("button.btn.primary", { onclick: run, disabled: true }, iconEl("ocr", 18), "Recognize text");
  const out = h("div");
  const prog = progressBar();

  function renderFiles() {
    listEl.replaceChildren(...files.map((f, i) => fileChip(f, () => { files.splice(i, 1); renderFiles(); })));
    runBtn.disabled = !files.length;
  }

  async function run() {
    runBtn.disabled = true;
    out.replaceChildren(prog.el);
    prog.set(0, "Starting OCR engine…");
    const quality = +qualitySel.value;
    let worker;
    try {
      let current = "";
      let base = 0, span = 0;
      worker = await createOcrWorker(langSel.value, (m) => {
        if (m.status === "recognizing text") prog.set(base + (m.progress || 0) * span, `${current} — recognizing…`);
      });
      // count total pages first for stable progress
      const inputs = [];
      for (const f of files) {
        if (/pdf$/i.test(f.type) || /\.pdf$/i.test(f.name)) {
          const l = await loadPdfFile(f);
          inputs.push({ kind: "pdf", ...l });
        } else {
          inputs.push({ kind: "img", file: f, name: f.name });
        }
      }
      const totalPages = inputs.reduce((n, i) => n + (i.kind === "pdf" ? i.doc.numPages : 1), 0);
      let done = 0;
      const textParts = [];
      const pdfOut = await PDFDocument.create();

      for (const inp of inputs) {
        if (inp.kind === "pdf") {
          const src = await PDFDocument.load(inp.bytes);
          const dst = await PDFDocument.create();
          const copied = await dst.copyPages(src, src.getPageIndices());
          copied.forEach((p) => dst.addPage(p));
          for (let n = 1; n <= inp.doc.numPages; n++) {
            current = `${inp.name} · page ${n}/${inp.doc.numPages}`;
            base = done / totalPages; span = 1 / totalPages;
            prog.set(base, current);
            const pg = await inp.doc.getPage(n);
            const canvas = document.createElement("canvas");
            await renderToCanvas(pg, canvas, quality, { rotation: pg.rotate });
            const { data } = await worker.recognize(canvas, {}, { text: true, blocks: true });
            textParts.push(`--- ${inp.name} · page ${n} ---\n${data.text.trim()}`);
            let dstPage = dst.getPage(n - 1);
            const [x0, y0, x1, y1] = pg.view;
            const W = x1 - x0, H = y1 - y0;
            const rot = pg.rotate || 0;
            if (rot) {
              // Rasterize rotated pages so text positions and orientation stay consistent.
              const jpg = await dst.embedJpg(new Uint8Array(await (await canvasToBlob(canvas, "image/jpeg", 0.9)).arrayBuffer()));
              const np = dst.insertPage(n - 1, rot % 180 ? [H, W] : [W, H]);
              np.drawImage(jpg, { x: 0, y: 0, width: np.getWidth(), height: np.getHeight() });
              dst.removePage(n);
              dstPage = np;
              await addInvisibleText(dst, dstPage, wordsOf(data).map((w) => ({ text: w.text, x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1 })), canvas.width / np.getWidth());
            } else {
              await addInvisibleText(dst, dstPage, wordsOf(data).map((w) => ({ text: w.text, x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1 })), quality);
            }
            done++;
          }
          const pages = await pdfOut.copyPages(dst, dst.getPageIndices());
          pages.forEach((p) => pdfOut.addPage(p));
        } else {
          current = inp.name;
          base = done / totalPages; span = 1 / totalPages;
          prog.set(base, current);
          const { bytes, mime } = await imageFileToEmbeddable(inp.file);
          const img = mime === "image/png" ? await pdfOut.embedPng(bytes) : await pdfOut.embedJpg(bytes);
          const k = 0.48; // 150 dpi
          const page = pdfOut.addPage([img.width * k, img.height * k]);
          page.drawImage(img, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
          const { data } = await worker.recognize(new Blob([bytes], { type: mime }), {}, { text: true, blocks: true });
          textParts.push(`--- ${inp.name} ---\n${data.text.trim()}`);
          await addInvisibleText(pdfOut, page, wordsOf(data).map((w) => ({ text: w.text, x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1 })), 1 / k);
          done++;
        }
      }
      prog.set(1, "Done");
      const text = textParts.join("\n\n");
      const name = baseName(files[0].name) + (files.length > 1 ? "-combined" : "");
      const pdfBytes = await pdfOut.save();
      out.replaceChildren(
        h("div.panel", {},
          h("h3", {}, `Recognized ${done} page${done === 1 ? "" : "s"} · ${text.split(/\s+/).filter(Boolean).length} words`),
          h("div.row", {},
            wantPdf.checked && h("button.btn.primary", { onclick: () => download(pdfBytes, `${name}-searchable.pdf`, "application/pdf") }, iconEl("down", 18), "Searchable PDF"),
            wantTxt.checked && h("button.btn", { onclick: () => download(text, `${name}.txt`, "text/plain") }, iconEl("down", 18), "Text (.txt)"),
            h("button.btn", { onclick: () => navigator.clipboard?.writeText(text).then(() => toast("Copied text.", "success")) }, iconEl("copy", 18), "Copy text")),
          h("div", { style: { height: "12px" } }),
          h("pre.ocr-text", { "data-testid": "ocr-text" }, text || "(no text found)")));
      if (wantPdf.checked) download(pdfBytes, `${name}-searchable.pdf`, "application/pdf");
    } catch (e) {
      console.error(e);
      out.replaceChildren();
      if (e.message !== "Password entry cancelled") toast(`OCR failed: ${e.message}`, "error", 8000);
    } finally {
      await worker?.terminate();
      runBtn.disabled = !files.length;
    }
  }

  root.append(
    h("div.tool-page", {},
      h("h1", {}, "OCR scanning"),
      h("p.sub", {}, "Turn scanned PDFs or photos into searchable, selectable text. Recognition runs on your computer with no upload."),
      dropzone({ accept: "application/pdf,.pdf,image/*", multiple: true, label: "Drop scanned PDFs or images here, or click to browse", onFiles: (f) => { files.push(...f); renderFiles(); } }),
      h("div", { style: { height: "12px" } }), listEl, h("div", { style: { height: "12px" } }),
      h("div.panel", {},
        h("div.row", {}, h("label.field", {}, h("span", {}, "Language"), langSel), h("label.field", {}, h("span", {}, "Quality"), qualitySel)),
        h("div", { style: { height: "10px" } }),
        h("div.row", {}, h("label.check", {}, wantPdf, "Searchable PDF"), h("label.check", {}, wantTxt, "Plain text")),
        h("p.hint", {}, "English is bundled so OCR works offline. To add a language, copy its <code>.traineddata.gz</code> file into <code>public/vendor/tessdata</code> and list it in <code>src/tools/ocr.js</code>.".replace(/<\/?code>/g, "")),
        h("div", { style: { height: "6px" } }), runBtn),
      out)
  );
  void readBytes;
}
