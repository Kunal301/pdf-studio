import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const PORT = 8799;
export const BASE = `http://127.0.0.1:${PORT}`;
const EDGE = process.env.BROWSER_PATH || "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";

export async function startServer() {
  const data = mkdtempSync(join(tmpdir(), "pdfstudio-data-"));
  const proc = spawn("node", ["server/index.js"], { cwd: root, env: { ...process.env, PORT: String(PORT), DATA_DIR: data }, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("server start timeout")), 10000);
    proc.on("exit", (code) => rej(new Error(`test server exited early (code ${code}) — is port ${PORT} already in use? Run: pkill -f server/index.js`)));
    proc.stdout.on("data", (d) => { if (String(d).includes("running")) { clearTimeout(t); res(); } });
    proc.stderr.on("data", (d) => process.stderr.write(d));
  });
  return { proc, data };
}

export async function launch() {
  const browser = await chromium.launch({ executablePath: EDGE, headless: true });
  const downloadsDir = mkdtempSync(join(tmpdir(), "pdfstudio-dl-"));
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1400, height: 900 } });
  const errors = [];
  // Be as strict as Firefox/Safari: createElement must receive a valid bare tag name.
  await context.addInitScript(() => {
    const orig = Document.prototype.createElement;
    Document.prototype.createElement = function (name, ...rest) {
      if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(String(name))) throw new DOMException(`Invalid tag name: ${name}`, "InvalidCharacterError");
      return orig.call(this, name, ...rest);
    };
  });
  context.on("page", (p) => {
    p.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    p.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
  });
  return { browser, context, errors, downloadsDir };
}

export async function makePdf(pages, { prefix = "Page", extra = [] } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) {
    const p = doc.addPage([420, 560]);
    p.drawText(`${prefix} ${i} Hello`, { x: 40, y: 500, size: 24, font, color: rgb(0, 0, 0) });
    p.drawText("Contact: jane.doe@example.com Secret 123", { x: 40, y: 450, size: 14, font });
    for (const e of extra) p.drawText(e.text, { x: e.x, y: e.y, size: e.size || 12, font });
  }
  return Buffer.from(await doc.save());
}

export async function pdfText(bytes, password) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), password, useSystemFonts: true, isEvalSupported: false, verbosity: 0 }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const tc = await (await doc.getPage(i)).getTextContent();
    pages.push(tc.items.map((x) => x.str).join(" "));
  }
  return pages;
}

export async function setFile(page, file, selector = 'input[type="file"]') {
  await page.locator(selector).first().setInputFiles(file);
}

export async function downloadOf(page, action) {
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), action()]);
  const path = join(mkdtempSync(join(tmpdir(), "pdfstudio-file-")), dl.suggestedFilename());
  await dl.saveAs(path);
  return { path, name: dl.suggestedFilename(), bytes: readFileSync(path) };
}

export { readFileSync, mkdirSync, join, root, PDFDocument };

import { deflateSync } from "node:zlib";
function crc32(buf) {
  let c, crc = ~0;
  for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return ~crc >>> 0;
}
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
/** Solid-colour RGBA PNG. */
export function makePng(w = 40, h = 20, [r, g, b] = [200, 30, 60]) {
  const row = Buffer.alloc(1 + w * 4);
  for (let x = 0; x < w; x++) row.set([r, g, b, 255], 1 + x * 4);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

import fontkit from "@pdf-lib/fontkit";
import { nodeFonts } from "./fontProvider.mjs";
export { nodeFonts };

/** Invoice-like PDF with embedded (subset) fonts, ₹ amounts, columns, right-aligned numbers and a coloured paragraph. */
export async function makeInvoice() {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const regular = await nodeFonts.faces("arimo", false, false, "");
  const bold = await nodeFonts.faces("arimo", true, false, "");
  const f = await doc.embedFont(regular[0].bytes, { subset: true });
  const fx = await doc.embedFont(regular[1].bytes, { subset: true }); // latin-ext face holds ₹
  const fb = await doc.embedFont(bold[0].bytes, { subset: true });
  const fbx = await doc.embedFont(bold[1].bytes, { subset: true });
  const page = doc.addPage([600, 800]);
  const t = (text, x, y, size, font = f, color = rgb(0, 0, 0)) => page.drawText(text, { x, y, size, font, color });
  const amount = (text, rightX, y, size, bold = false) => {
    // "₹" lives in the latin-ext face, digits in latin
    const fa = bold ? fbx : fx, fd = bold ? fb : f;
    const wd = fd.widthOfTextAtSize(text.slice(1), size), wa = fa.widthOfTextAtSize("₹", size);
    t("₹", rightX - wd - wa, y, size, fa);
    t(text.slice(1), rightX - wd, y, size, fd);
  };
  t("Order placed 23 September 2026", 40, 740, 14);
  t("Order number 408-9748513-5571540", 340, 740, 14);
  t("Ship to", 40, 690, 14, fb);
  ["Kunal Soni", "1104, b wing , marathon", "neoskies", "MUMBAI, MAHARASHTRA", "400078"].forEach((l, i) => t(l, 40, 670 - i * 16, 12));
  t("Order Summary", 340, 690, 14, fb);
  [["Item(s) Subtotal:", "₹1,098.00"], ["Shipping:", "₹19.00"], ["Cash/Pay on Delivery fee:", "₹17.00"]].forEach(([l, a], i) => { t(l, 340, 670 - i * 16, 12); amount(a, 560, 670 - i * 16, 12); });
  t("Grand Total:", 340, 575, 12, fb);
  amount("₹1,115.00", 560, 575, 12, true);
  ["Tukzer Gel Mouse Pad Wrist Rest Memory-Foam Ergonomic", "Mousepad| Cushion Wrist Support & Pain Relief| Suitable for Gaming,", "Computer, Laptop, Home & Office Non-Slip Rubber Base (Black)"].forEach((l, i) => t(l, 60, 520 - i * 15, 11, f, rgb(0.15, 0.3, 0.75)));
  return Buffer.from(await doc.save());
}

/** A browser-printed (Skia/Chrome) invoice PDF: real-world content-stream structure. */
export async function makeChromePdf(context) {
  const page = await context.newPage();
  await page.setContent(`<html><body style="font-family:Arial,Helvetica,sans-serif;margin:40px">
    <h3 style="margin:0 0 6px">Order placed 23 September 2026 &nbsp;|&nbsp; Order number 408-9748513-5571540</h3>
    <div style="display:flex;gap:80px"><div><b>Ship to</b><br>Kunal Soni<br>1104, b wing , marathon<br>neoskies<br>MUMBAI, MAHARASHTRA<br>400078</div>
    <div style="width:240px"><b>Order Summary</b>
      <div style="display:flex;justify-content:space-between"><span>Item(s) Subtotal:</span><span>₹1,098.00</span></div>
      <div style="display:flex;justify-content:space-between"><span>Shipping:</span><span>₹19.00</span></div>
      <div style="display:flex;justify-content:space-between"><b>Grand Total:</b><b>₹1,115.00</b></div></div></div>
    <p style="width:330px;color:#1d4ed8;font-size:15px">Tukzer Gel Mouse Pad Wrist Rest Memory-Foam Ergonomic Mousepad Cushion Wrist Support and Pain Relief Suitable for Gaming Computer Laptop Home Office</p>
  </body></html>`);
  const pdf = await page.pdf({ format: "A4" });
  await page.close();
  return Buffer.from(pdf);
}

/** Text items with the real (embedded) font name used for each — to verify which typeface was drawn. */
export async function textWithFonts(bytes, pageNo = 1) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, fontExtraProperties: true, verbosity: 0 }).promise;
  const page = await doc.getPage(pageNo);
  const tc = await page.getTextContent();
  await page.getOperatorList();
  return tc.items.filter((i) => i.str.trim()).map((i) => {
    let name = "";
    try { name = page.commonObjs.get(i.fontName).name; } catch { /* unresolved */ }
    return { str: i.str, font: name.replace(/^[A-Z]{6}\+/, ""), size: Math.hypot(i.transform[0], i.transform[1]), x: i.transform[4], y: i.transform[5] };
  });
}
