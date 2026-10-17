import assert from "node:assert/strict";
import { PDFDocument, StandardFonts } from "pdf-lib";
import * as ops from "../src/lib/ops.js";
import { renderBlocks } from "../src/lib/layout.js";
import { nodeFonts } from "./fontProvider.mjs";
import { normalizeLink, linkRange, replaceRange, applyFmt } from "../src/lib/richtext.js";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

async function makePdf(n, label = "Page") {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= n; i++) {
    const p = doc.addPage([300, 400]);
    p.drawText(`${label} ${i}`, { x: 40, y: 340, size: 24, font });
  }
  return doc.save();
}
const count = async (b) => (await PDFDocument.load(b)).getPageCount();
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log("ok -", name); };

await test("parseRanges", () => {
  assert.deepEqual(ops.parseRanges("1-3,5,8-", 9), [[0, 1, 2], [4], [7, 8]]);
  assert.deepEqual(ops.parseRanges("-2", 5), [[0, 1]]);
  assert.throws(() => ops.parseRanges("0-2", 5));
  assert.throws(() => ops.parseRanges("4-9", 5));
  assert.throws(() => ops.parseRanges("abc", 5));
  assert.throws(() => ops.parseRanges("", 5));
});
await test("merge", async () => {
  const out = await ops.mergePdfs([await makePdf(2), await makePdf(3), await makePdf(1)]);
  assert.equal(await count(out), 6);
});
await test("split ranges + chunk", async () => {
  const pdf = await makePdf(7);
  const parts = await ops.splitGroups(pdf, ops.parseRanges("1-3,5,7-", 7));
  assert.deepEqual(await Promise.all(parts.map((p) => count(p.bytes))), [3, 1, 1]);
  const chunks = ops.chunkIndices(7, 3);
  assert.deepEqual(chunks.map((c) => c.length), [3, 3, 1]);
});
await test("extract", async () => {
  assert.equal(await count(await ops.extractPages(await makePdf(5), [0, 4])), 2);
});
await test("organize: reorder, rotate, delete, blank, second source", async () => {
  const a = await makePdf(3, "A");
  const b = await makePdf(2, "B");
  const out = await ops.buildFromPlan([a, b], [
    { src: 0, page: 2, rotate: 90 },
    { src: 1, page: 0, rotate: 0 },
    { blank: { w: 300, h: 400 } },
    { src: 0, page: 0, rotate: 270 },
  ]);
  const d = await PDFDocument.load(out);
  assert.equal(d.getPageCount(), 4);
  assert.equal(d.getPage(0).getRotation().angle, 90);
  assert.equal(d.getPage(3).getRotation().angle, 270);
});
await test("images -> pdf", async () => {
  const doc = await PDFDocument.create();
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const out = await ops.imagesToPdf([{ bytes: png, mime: "image/png" }, { bytes: png, mime: "image/png" }], { fit: "a4" });
  assert.equal(await count(out), 2);
});
await test("applyEdits: text/rect/ink/unicode fallback", async () => {
  const pdf = await makePdf(1);
  const out = await ops.applyEdits(pdf, { 0: [
    { type: "rect", x: 10, y: 10, w: 50, h: 20, fill: "#ffffff", opacity: 1 },
    { type: "text", x: 40, y: 40, w: 200, h: 40, text: "Hello wörld → 世界\nsecond line", font: "Times", bold: true, italic: true, size: 14, color: "#ff0000" },
    { type: "ink", points: [[0, 0], [30, 30], [60, 10]], color: "#0000ff", width: 3 },
  ] });
  assert.ok(out.length > (await makePdf(1)).length);
  await PDFDocument.load(out);
});
await test("applyEdits with font chain: rupee sign, accents, wrapping, bold", async () => {
  const pdf = await makePdf(1);
  const out = await ops.applyEdits(pdf, { 0: [
    { type: "text", x: 40, y: 100, w: 300, h: 40, text: "Grand Total: ₹1,115.00 — Zoë café", font: "arimo", bold: true, italic: false, size: 16, color: "#111111", wrap: false },
    { type: "text", x: 40, y: 150, w: 120, h: 60, text: "This paragraph should wrap onto several lines inside a narrow box.", font: "tinos", size: 12, lineHeight: 15, color: "#000000" },
  ] }, {}, { fonts: nodeFonts });
  const doc = await pdfjs.getDocument({ data: new Uint8Array(out), useSystemFonts: true, verbosity: 0 }).promise;
  const tc = await (await doc.getPage(1)).getTextContent();
  const text = tc.items.map((i) => i.str).join("");
  assert.ok(text.includes("₹1,115.00"), text);
  assert.ok(text.includes("Zoë café"), text);
  const wrapped = tc.items.filter((i) => /This paragraph|wrap onto|inside a narrow/.test(i.str));
  assert.ok(new Set(wrapped.map((i) => Math.round(i.transform[5]))).size >= 3, "paragraph wrapped over >=3 lines");
});
await test("applyEdits removes original text under cover boxes (and only there)", async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([400, 300]);
  page.drawText("Kunal Soni", { x: 40, y: 250, size: 12, font });
  page.drawText("Keep this line", { x: 40, y: 230, size: 12, font });
  page.drawText("Right column", { x: 250, y: 250, size: 12, font });
  const pdf = Buffer.from(await doc.save());
  const out = await ops.applyEdits(pdf, { 0: [
    { type: "rect", subtype: "whiteout", fill: "#ffffff", opacity: 1, x: 38, y: 36, w: 80, h: 18, strip: { x: 38.5, y: 38, w: 70, h: 14 } },
    { type: "text", x: 40, y: 38, w: 80, h: 16, text: "Jane Roe", font: "arimo", size: 12, wrap: false, color: "#000000" },
  ] }, {}, { fonts: nodeFonts });
  const d = await pdfjs.getDocument({ data: new Uint8Array(out), useSystemFonts: true, verbosity: 0 }).promise;
  const tc = await (await d.getPage(1)).getTextContent();
  const all = tc.items.map((i) => i.str).join("|");
  assert.ok(!all.includes("Kunal Soni"), "original removed: " + all);
  assert.ok(all.includes("Jane Roe") && all.includes("Keep this line") && all.includes("Right column"), all);
});
await test("rich text export: ranges, alignment, justify, lists, spacing", async () => {
  const pdf = await makePdf(1);
  const o = {
    type: "text", x: 50, y: 60, w: 200, h: 200, font: "arimo", size: 12, lineHeight: 16, color: "#000000", bold: false, italic: false, align: "left", paraSpace: 6,
    text: "Bold word and plain\nThis second paragraph is long enough that it must wrap over several lines to demonstrate justification properly\nfirst bullet\nStep one\nStep two",
    fmt: [{ s: 0, e: 9, b: true }, { s: 14, e: 19, c: "#ff0000", u: true }],
    paras: [{ align: "center" }, { align: "justify" }, { list: "bullet", align: "left" }, { list: "number", align: "left" }, { list: "number", align: "left", indent: 1 }],
  };
  const out = await ops.applyEdits(pdf, { 0: [o] }, {}, { fonts: nodeFonts });
  const d = await pdfjs.getDocument({ data: new Uint8Array(out), useSystemFonts: false, fontExtraProperties: true, verbosity: 0 }).promise;
  const page = await d.getPage(1);
  const tc = await page.getTextContent();
  await page.getOperatorList();
  const items = tc.items.filter((i) => i.str.length).map((i) => ({ s: i.str, x: i.transform[4], y: i.transform[5], w: i.width, f: (page.commonObjs.get(i.fontName)?.name || "").replace(/^[A-Z]{6}\+/, "") }));
  const row = (y) => items.filter((i) => Math.abs(i.y - y) < 0.6);
  // y of first baseline top-left 60 + offset ~ 12.2: PDF y = 792? page is 400x560 → baselines go down by 16 per line, +6 per paragraph
  const first = items.find((i) => /Bold/.test(i.s));
  assert.ok(/Bold/.test(first.f), "bold range uses the bold face: " + first.f);
  const line1 = row(first.y);
  const l1w = Math.min(...line1.map((i) => i.x)), l1r = Math.max(...line1.map((i) => i.x + i.w));
  assert.ok(Math.abs((l1w + l1r) / 2 - 150) < 1.5, `centered: ${(l1w + l1r) / 2}`);
  const red = items.find((i) => /plain/.test(i.s));
  assert.ok(red, "coloured run exists");
  // second paragraph: justified → first line spans the full box width
  const p2y = first.y - 16 - 6;
  const p2 = row(p2y);
  assert.ok(p2.length > 3, "justified line is drawn word by word");
  assert.ok(Math.abs(Math.max(...p2.map((i) => i.x + i.w)) - 250) < 1.2, "justified right edge " + Math.max(...p2.map((i) => i.x + i.w)));
  assert.ok(Math.abs(Math.min(...p2.map((i) => i.x)) - 50) < 0.6, "justified left edge");
  const all = items.map((i) => i.s).join("");
  assert.ok(all.includes("•") && all.includes("1.") && all.includes("2."), all);
  const step2 = items.find((i) => /Step two/.test(i.s));
  const step1 = items.find((i) => /Step one/.test(i.s));
  assert.ok(step2.x - step1.x > 15, "indent applied: " + (step2.x - step1.x));
});
await test("normalizeLink accepts safe targets only", () => {
  assert.deepEqual(normalizeLink("example.com"), { url: "https://example.com/" });
  assert.deepEqual(normalizeLink("a@b.co"), { url: "mailto:a@b.co" });
  assert.deepEqual(normalizeLink("#page=2", { pageCount: 3 }), { url: "#page=2" });
  for (const bad of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "foo bar", "", "#page=9", "vbscript:x"]) assert.ok(normalizeLink(bad, { pageCount: 3 }).error, `rejects ${bad}`);
});
await test("link model: replaceRange keeps other formatting, linkRange finds the whole link", () => {
  const o = { text: "Visit our site today", bold: false, italic: false, color: "#000000", fmt: [{ s: 0, e: 5, b: true }] };
  const r = replaceRange(o, 6, 14, "docs", { l: "https://example.com/", u: true, c: "#0563c1" });
  assert.equal(o.text, "Visit docs today");
  assert.deepEqual(r, { s: 6, e: 10 });
  assert.deepEqual(linkRange(o, 8), { s: 6, e: 10, url: "https://example.com/" });
  assert.equal(linkRange(o, 2), null);
  assert.ok(o.fmt.some((f) => f.b && f.s === 0 && f.e === 5), "bold on 'Visit' untouched");
  applyFmt(o, 6, 10, { l: null, u: null, c: null });
  assert.equal(linkRange(o, 8), null);
});
await test("link annotations: URI + page links are written, unsafe targets are not", async () => {
  const doc = await PDFDocument.create();
  doc.addPage([400, 300]); doc.addPage([400, 300]);
  const base = Buffer.from(await doc.save());
  const o = {
    type: "text", x: 50, y: 40, w: 300, h: 20, font: "arimo", size: 12, lineHeight: 16, color: "#000000", bold: false, italic: false, align: "left", wrap: false,
    text: "Go to site or page two or bad link",
    fmt: [{ s: 6, e: 10, l: "https://example.com/", u: true, c: "#0563c1" }, { s: 14, e: 22, l: "#page=2", u: true, c: "#0563c1" }, { s: 26, e: 34, l: "javascript:alert(1)", u: true }],
  };
  const out = await ops.applyEdits(base, { 0: [o] }, {}, { fonts: nodeFonts });
  const d = await pdfjs.getDocument({ data: new Uint8Array(out), verbosity: 0 }).promise;
  const annots = (await (await d.getPage(1)).getAnnotations()).filter((a) => a.subtype === "Link");
  assert.equal(annots.length, 2, "javascript: link was dropped");
  const web = annots.find((a) => a.url);
  assert.equal(web.url, "https://example.com/");
  const [x0, y0, x1, y1] = web.rect;
  assert.ok(x0 > 50 && x1 > x0 && x1 < 120, `rect x ${x0}..${x1}`);
  assert.ok(y1 - y0 > 8 && y1 - y0 < 20, `rect height ${y1 - y0}`);
  const pg = annots.find((a) => !a.url);
  assert.ok(pg.dest, "internal page link has a destination");
});
await test("blocks -> pdf paginates", async () => {
  const blocks = [{ type: "h", level: 1, runs: [{ text: "Title" }] }];
  for (let i = 0; i < 120; i++) blocks.push({ type: "p", runs: [{ text: "Lorem ipsum dolor sit amet, " }, { text: "bold", bold: true }, { text: " and more text to wrap around the line." }] });
  blocks.push({ type: "table", header: true, rows: [[[{ text: "A" }], [{ text: "B" }]], [[{ text: "1" }], [{ text: "2" }]]] });
  const out = await renderBlocks(blocks);
  assert.ok((await count(out)) >= 3);
});
console.log(`\n${passed} unit tests passed`);
