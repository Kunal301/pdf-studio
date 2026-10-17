import "./polyfills.js";
// The legacy build bundles the polyfills older Safari/iOS needs (e.g. async iteration of ReadableStream).
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { readBytes } from "./util.js";
import { promptText } from "./ui.js";
import { decryptPdf } from "./qpdf.js";

// Our own module worker so polyfills run inside the worker thread too.
pdfjs.GlobalWorkerOptions.workerPort = new Worker(new URL("./pdfWorker.js", import.meta.url), { type: "module" });

export function openDoc(bytes, password) {
  return pdfjs.getDocument({ data: bytes.slice(), password, isEvalSupported: false, fontExtraProperties: true }).promise;
}

/**
 * Open a PDF file. If it needs a password, ask for it and return decrypted bytes
 * so every tool can work with the document normally.
 */
export async function loadPdfFile(file, { interactive = true } = {}) {
  let bytes = await readBytes(file);
  let message = "This PDF is password protected. Enter the password to open it.";
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const doc = await openDoc(bytes);
      return { name: file.name, bytes, doc };
    } catch (e) {
      if (e?.name !== "PasswordException" || !interactive) throw e;
      const pw = await promptText("Password required", message, { password: true });
      if (pw == null) throw new Error("Password entry cancelled");
      try {
        bytes = new Uint8Array(await decryptPdf(bytes, pw));
      } catch (err) {
        if (!err.wrongPassword) throw err;
        message = "Incorrect password. Try again.";
      }
    }
  }
  throw new Error("Could not unlock the PDF");
}

export function pageBox(page) {
  const [x0, y0, x1, y1] = page.view;
  return { x0, y0, w: x1 - x0, h: y1 - y0 };
}

/** rotation 0 shows the page in the frame its content is authored in (what pdf-lib edits address). */
export async function renderToCanvas(page, canvas, scale, { rotation } = {}) {
  const viewport = page.getViewport({ scale, rotation: rotation ?? page.rotate });
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, canvas, viewport }).promise;
  return viewport;
}

export async function pageCanvas(doc, n, scale, opts) {
  const page = await doc.getPage(n);
  const canvas = document.createElement("canvas");
  await renderToCanvas(page, canvas, scale, opts);
  return canvas;
}

/** Text runs in top-left page space (points), unrotated frame. */
export async function getTextRuns(page) {
  const box = pageBox(page);
  const tc = await page.getTextContent();
  const runs = [];
  for (const it of tc.items) {
    if (!it.str || !it.str.trim()) continue;
    const [a, b, , , e, f] = it.transform;
    const size = Math.hypot(a, b) || 10;
    runs.push({
      str: it.str,
      font: it.fontName,
      x: e - box.x0,
      baseline: box.h - (f - box.y0),
      w: it.width,
      size,
      top: box.h - (f - box.y0) - size * 0.82,
      h: size * 1.05,
    });
  }
  return runs;
}

export { groupLines } from "./textBlocks.js";
