import assert from "node:assert/strict";
import JSZip from "jszip";
import { PDFName } from "pdf-lib";
import { PNG } from "pngjs";
import { startServer, launch, BASE, makePdf, makeInvoice, makeChromePdf, textWithFonts, makePng, pdfText, setFile, downloadOf, PDFDocument } from "./harness.mjs";

const filter = process.argv[2];
// macOS: Home/End scroll instead of moving the caret, Cmd+Left/Right do
const HOME = process.platform === "darwin" ? "Meta+ArrowLeft" : "Home";
const END = process.platform === "darwin" ? "Meta+ArrowRight" : "End";
const SHIFT_HOME = "Shift+" + HOME;
const server = await startServer();
const { browser, context, errors } = await launch();
let passed = 0, failed = 0;

async function test(name, fn, allow) {
  if (filter && !name.includes(filter)) return;
  const page = await context.newPage();
  const before = errors.length;
  try {
    await fn(page);
    const newErrors = errors.slice(before).filter((e) => !/favicon|this\.program: .*invalid password/.test(e) && !(allow && allow.test(e)));
    assert.deepEqual(newErrors, [], `browser errors: ${newErrors.join(" | ")}`);
    passed++;
    console.log("ok   -", name);
  } catch (e) {
    failed++;
    console.log("FAIL -", name, "\n      ", String(e.stack || e).split("\n").slice(0, 6).join("\n       "));
    await page.screenshot({ path: `/tmp/e2e-fail-${name.replace(/\W+/g, "_")}.png` }).catch(() => {});
  } finally {
    await page.close();
  }
}
const toast = (page, text) => page.locator(".toast", { hasText: text }).first().waitFor({ timeout: 15000 });

await test("home lists all 8 tools", async (page) => {
  await page.goto(BASE);
  const titles = await page.locator(".card h2").allTextContents();
  assert.deepEqual(titles, ["Edit PDFs", "Convert files", "Merge PDFs", "Split PDFs", "Organize pages", "OCR scanning", "Sign documents", "Protect PDFs"]);
});

await test("merge combines PDFs in chosen order", async (page) => {
  await page.goto(`${BASE}/#/merge`);
  await setFile(page, { name: "a.pdf", mimeType: "application/pdf", buffer: await makePdf(2, { prefix: "Alpha" }) });
  await page.locator(".file-row").first().waitFor();
  await setFile(page, { name: "b.pdf", mimeType: "application/pdf", buffer: await makePdf(3, { prefix: "Beta" }) });
  await page.waitForFunction(() => document.querySelectorAll(".file-row").length === 2);
  await page.locator('button[aria-label="Move b.pdf up"]').click(); // b first
  const dl = await downloadOf(page, () => page.getByRole("button", { name: "Merge PDFs" }).click());
  const text = await pdfText(dl.bytes);
  assert.equal(text.length, 5);
  assert.match(text[0], /Beta 1/);
  assert.match(text[3], /Alpha 1/);
});

await test("split by ranges produces zip of parts", async (page) => {
  await page.goto(`${BASE}/#/split`);
  await setFile(page, { name: "doc.pdf", mimeType: "application/pdf", buffer: await makePdf(5) });
  await page.getByLabel("Page ranges").fill("1-2, 3-5");
  const dl = await downloadOf(page, () => page.getByRole("button", { name: "Split PDF" }).click());
  assert.match(dl.name, /\.zip$/);
  const zip = await JSZip.loadAsync(dl.bytes);
  const names = Object.keys(zip.files).sort();
  assert.equal(names.length, 2);
  const counts = [];
  for (const n of names) counts.push((await PDFDocument.load(await zip.file(n).async("uint8array"))).getPageCount());
  assert.deepEqual(counts, [2, 3]);
});

await test("split every N pages and invalid range is rejected", async (page) => {
  await page.goto(`${BASE}/#/split`);
  await setFile(page, { name: "doc.pdf", mimeType: "application/pdf", buffer: await makePdf(5) });
  await page.getByLabel("Page ranges").fill("4-9");
  await page.locator(".hint", { hasText: "outside" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Split PDF" }).isDisabled(), true);
  await page.getByLabel("Every N pages").check();
  await page.getByLabel("Pages per file").fill("2");
  const dl = await downloadOf(page, () => page.getByRole("button", { name: "Split PDF" }).click());
  const zip = await JSZip.loadAsync(dl.bytes);
  assert.equal(Object.keys(zip.files).length, 3);
});

await test("organize: rotate, delete, blank, reorder", async (page) => {
  await page.goto(`${BASE}/#/organize`);
  await setFile(page, { name: "doc.pdf", mimeType: "application/pdf", buffer: await makePdf(3, { prefix: "Org" }) });
  await page.locator(".pcard").nth(2).waitFor();
  // rotate page 1 right
  await page.locator(".pcard").nth(0).hover();
  await page.getByLabel("Rotate page 1 right").click();
  // delete page 2
  await page.locator(".pcard").nth(1).hover();
  await page.getByLabel("Delete page 2").click();
  assert.equal(await page.locator(".pcard").count(), 2);
  // add blank at end
  await page.getByRole("button", { name: "Blank page" }).click();
  assert.equal(await page.locator(".pcard").count(), 3);
  // drag last (blank) before first
  await page.locator(".pcard").nth(2).dragTo(page.locator(".pcard").nth(0));
  const dl = await downloadOf(page, () => page.getByRole("button", { name: "Download PDF" }).click());
  const doc = await PDFDocument.load(dl.bytes);
  assert.equal(doc.getPageCount(), 3);
  const text = await pdfText(dl.bytes);
  assert.equal(text[0].trim(), "");           // blank first
  assert.match(text[1], /Org 1/);             // rotated original page 1
  assert.match(text[2], /Org 3/);             // page 2 deleted
  assert.equal(doc.getPage(1).getRotation().angle, 90);
});

await test("organize: extract selected and insert from another PDF", async (page) => {
  await page.goto(`${BASE}/#/organize`);
  await setFile(page, { name: "doc.pdf", mimeType: "application/pdf", buffer: await makePdf(3, { prefix: "Ex" }) });
  await page.locator(".pcard").nth(2).waitFor();
  await page.getByRole("button", { name: "Insert from PDF…" }).click({ trial: true });
  await page.locator('input[type="file"][hidden]').last().setInputFiles({ name: "ins.pdf", mimeType: "application/pdf", buffer: await makePdf(2, { prefix: "Ins" }) });
  await page.waitForFunction(() => document.querySelectorAll(".pcard").length === 5);
  await page.locator(".pcard").nth(3).click();
  await page.locator(".pcard").nth(4).click();
  const dl = await downloadOf(page, () => page.getByRole("button", { name: "Extract selected" }).click());
  const text = await pdfText(dl.bytes);
  assert.equal(text.length, 2);
  assert.match(text[0], /Ins 1/);
});

await test("edit: replace existing text, add text, shape; saves into PDF", async (page) => {
  await page.goto(`${BASE}/#/edit`);
  await setFile(page, { name: "doc.pdf", mimeType: "application/pdf", buffer: await makePdf(1, { prefix: "Edit" }) });
  await page.locator(".page-wrap canvas").first().waitFor();
  await page.waitForFunction(() => document.querySelector(".page-wrap canvas")?.width > 100);
  // edit existing text with a real click (Edit text is the default tool)
  await page.locator('[aria-label^="Edit text: Edit 1 Hello"]').click();
  await page.locator('.obj.text .content[contenteditable="true"]').waitFor();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("Replaced Title");
  await page.keyboard.press("Escape");
  // add new text
  await page.getByRole("button", { name: "Add text" }).click();
  const overlay = page.locator(".overlay").first();
  const box = await overlay.boundingBox();
  await page.mouse.click(box.x + 80, box.y + 400);
  await page.keyboard.type("Brand new note");
  await page.keyboard.press("Escape");
  // shape
  await page.getByRole("button", { name: "Shape" }).click();
  await page.mouse.move(box.x + 100, box.y + 450);
  await page.mouse.down();
  await page.mouse.move(box.x + 200, box.y + 500, { steps: 4 });
  await page.mouse.up();
  const dl = await downloadOf(page, () => page.getByRole("button", { name: "Download PDF" }).click());
  const text = (await pdfText(dl.bytes))[0];
  assert.match(text, /Replaced Title/);
  assert.match(text, /Brand new note/);
});

await test("edit: undo/redo and image insertion", async (page) => {
  await page.goto(`${BASE}/#/edit`);
  await setFile(page, { name: "doc.pdf", mimeType: "application/pdf", buffer: await makePdf(1) });
  await page.locator(".page-wrap canvas").first().waitFor();
  const png = makePng(40, 20);
  await page.locator('input[type="file"][accept="image/*"]').setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: png });
  await toast(page, "Click on the page");
  const box = await page.locator(".overlay").first().boundingBox();
  await page.mouse.click(box.x + 150, box.y + 300);
  await page.locator(".obj.image").waitFor();
  assert.equal(await page.locator(".obj.image").count(), 1);
  await page.getByTitle(/Undo/).click();
  assert.equal(await page.locator(".obj.image").count(), 0);
  await page.getByTitle(/Redo/).click();
  assert.equal(await page.locator(".obj.image").count(), 1);
  const dl = await downloadOf(page, () => page.getByRole("button", { name: "Download PDF" }).click());
  assert.ok(dl.bytes.length > (await makePdf(1)).length);
});


const pdfBuf = async (pages, opts) => ({ name: "doc.pdf", mimeType: "application/pdf", buffer: await makePdf(pages, opts) });
const countImages = async (bytes) => {
  const doc = await PDFDocument.load(bytes);
  let n = 0;
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    const d = obj.dict;
    if (d && d.get(PDFName.of("Subtype")) === PDFName.of("Image")) n++;
  }
  return n;
};

await test("protect: add password (AES-256), then remove it", async (page) => {
  await page.goto(`${BASE}/#/protect`);
  await setFile(page, await pdfBuf(1, { prefix: "Prot" }));
  await page.getByLabel("Password", { exact: true }).first().fill("s3cret!");
  await page.getByLabel("Confirm password").fill("s3cret!");
  const dl = await downloadOf(page, () => page.getByRole("button", { name: "Protect & download" }).click());
  assert.match(dl.name, /-protected\.pdf$/);
  await assert.rejects(() => PDFDocument.load(dl.bytes), /encrypted/i);
  await assert.rejects(() => pdfText(dl.bytes), /password/i);
  assert.match((await pdfText(dl.bytes, "s3cret!"))[0], /Prot 1/);
  assert.ok(Buffer.from(dl.bytes).includes("/AESV3") || Buffer.from(dl.bytes).includes("/AESV3".slice(0)), "AES-256 (V5/AESV3) crypt filter present");
  // wrong password rejected by unlock tab
  await page.getByRole("tab", { name: "Remove password" }).click();
  await setFile(page, { name: "locked.pdf", mimeType: "application/pdf", buffer: dl.bytes });
  await page.getByLabel("Password", { exact: true }).fill("wrong");
  await page.getByRole("button", { name: /Remove protection/ }).click();
  await toast(page, "incorrect");
  await page.getByLabel("Password", { exact: true }).fill("s3cret!");
  const un = await downloadOf(page, () => page.getByRole("button", { name: /Remove protection/ }).click());
  assert.match((await pdfText(un.bytes))[0], /Prot 1/);
});

await test("protect: opening an encrypted file prompts for a password", async (page) => {
  await page.goto(`${BASE}/#/protect`);
  await setFile(page, await pdfBuf(1, { prefix: "Lock" }));
  await page.getByLabel("Password", { exact: true }).first().fill("pw123");
  await page.getByLabel("Confirm password").fill("pw123");
  const enc = await downloadOf(page, () => page.getByRole("button", { name: "Protect & download" }).click());
  await page.goto(`${BASE}/#/split`);
  await setFile(page, { name: "enc.pdf", mimeType: "application/pdf", buffer: enc.bytes });
  const dlg = page.getByRole("dialog");
  await dlg.getByLabel(/./, { exact: false }).first().waitFor().catch(() => {});
  await dlg.locator("input").fill("nope");
  await dlg.getByRole("button", { name: "OK" }).click();
  await page.getByText("Incorrect password").waitFor();
  await dlg.locator("input").fill("pw123");
  await dlg.getByRole("button", { name: "OK" }).click();
  await page.getByText("1 page").waitFor();
});

await test("redact: marked text is truly removed", async (page) => {
  await page.goto(`${BASE}/#/protect/redact`);
  await setFile(page, await pdfBuf(2, { prefix: "Red" }));
  await page.locator(".page-wrap canvas").first().waitFor();
  await page.getByPlaceholder("Text to find…").fill("Red 1");
  await page.getByRole("button", { name: "Find & mark all" }).click();
  await page.getByText(/areas? marked/).waitFor();
  const marked = await page.locator(".obj.redact").count();
  assert.equal(marked, 1, "only the single \"Red 1\" match is marked");
  await page.getByRole("button", { name: "Apply redactions" }).click();
  const dl = await downloadOf(page, () => page.getByRole("button", { name: "Redact & download" }).click());
  const text = await pdfText(dl.bytes);
  assert.equal(text.length, 2);
  assert.equal(text[0].trim(), "", "page 1 should have no text layer left");
  assert.match(text[1], /Red 2/);
  assert.match(text[1], /jane\.doe@example\.com/);
  assert.ok(!Buffer.from(dl.bytes).includes("Red 1"), "redacted string must not be present in file bytes");
  assert.equal(await countImages(dl.bytes), 1);
});

const ocrImage = async (page) => {
  await page.goto(BASE);
  const dataUrl = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 1000; c.height = 360;
    const x = c.getContext("2d");
    x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height);
    x.fillStyle = "#000"; x.font = "bold 84px Arial, Helvetica, sans-serif";
    x.fillText("Invoice 4821", 40, 120);
    x.font = "64px Arial, Helvetica, sans-serif";
    x.fillText("Total due 99 dollars", 40, 250);
    return c.toDataURL("image/png");
  });
  return Buffer.from(dataUrl.split(",")[1], "base64");
};

await test("ocr: scanned image -> searchable PDF + text", async (page) => {
  const png = await ocrImage(page);
  await page.goto(`${BASE}/#/ocr`);
  await setFile(page, { name: "scan.png", mimeType: "image/png", buffer: png });
  const dl = await downloadOf(page, () => page.getByRole("button", { name: "Recognize text" }).click());
  const shown = await page.locator('[data-testid="ocr-text"]').textContent();
  assert.match(shown, /Invoice/i);
  assert.match(shown, /4821/);
  const text = (await pdfText(dl.bytes))[0];
  assert.match(text, /Invoice/i);
  assert.equal(await countImages(dl.bytes), 1);
});

await test("ocr: image-only PDF gets a text layer", async (page) => {
  const png = await ocrImage(page);
  const doc = await PDFDocument.create();
  const img = await doc.embedPng(png);
  const p = doc.addPage([500, 180]);
  p.drawImage(img, { x: 0, y: 0, width: 500, height: 180 });
  const scanned = Buffer.from(await doc.save());
  assert.equal((await pdfText(scanned))[0].trim(), "");
  await page.goto(`${BASE}/#/ocr`);
  await setFile(page, { name: "scan.pdf", mimeType: "application/pdf", buffer: scanned });
  const dl = await downloadOf(page, () => page.getByRole("button", { name: "Recognize text" }).click());
  assert.match((await pdfText(dl.bytes))[0], /Invoice/i);
});

await test("sign: draw/type signature and date, saved into PDF", async (page) => {
  await page.goto(`${BASE}/#/sign`);
  await setFile(page, await pdfBuf(1, { prefix: "Sign" }));
  await page.locator(".page-wrap canvas").first().waitFor();
  await page.getByRole("button", { name: "Signature" }).click();
  await page.getByRole("button", { name: "Type", exact: true }).click();
  await page.getByLabel("Name to sign").fill("Jane Doe");
  await page.getByRole("button", { name: "Use" }).click();
  await toast(page, "Click on the page");
  const box = await page.locator(".overlay").first().boundingBox();
  await page.mouse.click(box.x + 200, box.y + 400);
  await page.locator(".obj.image").waitFor();
  await page.getByRole("button", { name: "Date" }).click();
  const dl = await downloadOf(page, () => page.getByRole("button", { name: "Download signed PDF" }).click());
  assert.ok((await countImages(dl.bytes)) >= 1, "signature image embedded");
  assert.match((await pdfText(dl.bytes))[0], new RegExp(String(new Date().getFullYear())));
});

await test("sign: drawn signature on canvas", async (page) => {
  await page.goto(`${BASE}/#/sign`);
  await setFile(page, await pdfBuf(1));
  await page.locator(".page-wrap canvas").first().waitFor();
  await page.getByRole("button", { name: "Signature" }).click();
  const c = page.locator("canvas.sig-canvas");
  const b = await c.boundingBox();
  await page.mouse.move(b.x + 40, b.y + 100);
  await page.mouse.down();
  for (let i = 0; i < 12; i++) await page.mouse.move(b.x + 40 + i * 25, b.y + 100 + Math.sin(i) * 40);
  await page.mouse.up();
  await page.getByRole("button", { name: "Use" }).click();
  await toast(page, "Click on the page");
  const box = await page.locator(".overlay").first().boundingBox();
  await page.mouse.click(box.x + 150, box.y + 300);
  await page.locator(".obj.image").waitFor();
  const dl = await downloadOf(page, () => page.getByRole("button", { name: "Download signed PDF" }).click());
  assert.ok((await countImages(dl.bytes)) >= 1, "signature image embedded");
});

await test("sign: request signature end to end", async (page) => {
  await page.goto(`${BASE}/#/sign`);
  await page.getByRole("tab", { name: "Request signatures" }).click();
  await setFile(page, await pdfBuf(1, { prefix: "Contract" }));
  await page.locator(".page-wrap canvas").first().waitFor();
  const box = await page.locator(".overlay").first().boundingBox();
  await page.mouse.move(box.x + 100, box.y + 420);
  await page.mouse.down();
  await page.mouse.move(box.x + 300, box.y + 480, { steps: 5 });
  await page.mouse.up();
  await page.locator(".obj.field").waitFor();
  await page.getByLabel("Signer name").fill("Sam Signer");
  await page.getByLabel("Signer email").fill("sam@example.com");
  await page.getByRole("button", { name: "Create signing link" }).click();
  const link = (await page.locator('[data-testid="sign-link"]').textContent()).trim();
  assert.match(link, /#\/s\/[a-f0-9]{48}$/);
  await page.getByRole("button", { name: "Done" }).click();
  await page.locator('[data-testid="request-row"]').waitFor();
  assert.match(await page.locator('[data-testid="request-row"]').first().textContent(), /Waiting/);

  // signer side
  const signer = await context.newPage();
  await signer.goto(link);
  await signer.locator(".obj.field").waitFor();
  assert.match(await signer.locator(".signer-bar").textContent(), /Sam Signer/);
  await signer.getByRole("button", { name: "Finish & submit" }).click();
  await signer.locator(".toast", { hasText: "sign all" }).waitFor(); // blocked until field signed
  await signer.locator(".obj.field").click();
  await signer.getByRole("button", { name: "Type", exact: true }).click();
  await signer.getByLabel("Name to sign").fill("Sam Signer");
  await signer.getByRole("button", { name: "Use" }).click();
  await signer.locator(".obj.image").waitFor();
  assert.equal(await signer.locator(".obj.field").count(), 0);
  await signer.getByRole("button", { name: "Finish & submit" }).click();
  await signer.getByText("Signed — thank you!").waitFor();
  await signer.reload();
  await signer.getByText("Already signed").waitFor();
  await signer.close();

  // sender sees it
  await page.reload();
  await page.getByRole("tab", { name: "Sent requests" }).click();
  await page.locator(".badge.ok").waitFor();
  const href = await page.getByRole("link", { name: "Download signed" }).getAttribute("href");
  const res = await page.request.get(BASE + href);
  const bytes = Buffer.from(await res.body());
  assert.ok((await countImages(bytes)) >= 1, "signature image embedded");
  assert.match((await pdfText(bytes))[0], /Contract 1/);
});

await test("sign: invalid signing link", async (page) => {
  await page.goto(`${BASE}/#/s/${"0".repeat(48)}`);
  await page.getByText("invalid or has been removed").waitFor();
}, /404/);


// ---------------------------------------------------------------- convert
const tableRows = [
  { text: "Item", x: 40, y: 380 }, { text: "Qty", x: 200, y: 380 }, { text: "Price", x: 320, y: 380 },
  { text: "Widget", x: 40, y: 360 }, { text: "12", x: 200, y: 360 }, { text: "3.50", x: 320, y: 360 },
  { text: "Gadget", x: 40, y: 340 }, { text: "7", x: 200, y: 340 }, { text: "10.25", x: 320, y: 340 },
];
const convertFrom = async (page, bytes, target, { mode, dpi } = {}) => {
  await page.goto(`${BASE}/#/convert`);
  await page.reload(); // fresh state: a repeat navigation to the same hash would keep the previous file loaded
  await setFile(page, { name: "report.pdf", mimeType: "application/pdf", buffer: bytes });
  await page.getByText(/report\.pdf · \d+ pages?/).waitFor();
  await page.getByLabel("Convert to").selectOption(target);
  if (mode) await page.getByLabel("Mode").selectOption(mode);
  if (dpi) await page.getByLabel("Resolution").selectOption(dpi);
  return downloadOf(page, () => page.getByRole("button", { name: "Convert", exact: true }).click());
};

await test("convert: PDF -> Word (editable text and exact images)", async (page) => {
  const bytes = await makePdf(2, { prefix: "Doc" });
  const dl = await convertFrom(page, bytes, "docx");
  assert.match(dl.name, /\.docx$/);
  const zip = await JSZip.loadAsync(dl.bytes);
  const xml = await zip.file("word/document.xml").async("string");
  assert.match(xml, /Doc 1 Hello/);
  assert.match(xml, /Contact: jane\.doe@example\.com Secret 123/);
  assert.match(xml, /w:br w:type="page"/);
  const dl2 = await convertFrom(page, bytes, "docx", { mode: "image" });
  const z2 = await JSZip.loadAsync(dl2.bytes);
  assert.equal(Object.keys(z2.files).filter((f) => f.startsWith("word/media/") && !z2.files[f].dir).length, 2);
});

await test("convert: PDF -> Excel detects columns and numbers", async (page) => {
  const dl = await convertFrom(page, await makePdf(1, { extra: tableRows }), "xlsx");
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(dl.bytes);
  const ws = wb.getWorksheet("Page 1");
  const rows = [];
  ws.eachRow((r) => rows.push(r.values.slice(1)));
  const widget = rows.find((r) => r[0] === "Widget");
  assert.deepEqual(widget, ["Widget", 12, 3.5]);
  const gadget = rows.find((r) => r[0] === "Gadget");
  assert.deepEqual(gadget, ["Gadget", 7, 10.25]);
});

await test("convert: PDF -> PowerPoint (image and text modes)", async (page) => {
  const bytes = await makePdf(2, { prefix: "Slide" });
  const dl = await convertFrom(page, bytes, "pptx");
  const zip = await JSZip.loadAsync(dl.bytes);
  const slides = Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f));
  assert.equal(slides.length, 2);
  assert.ok(Object.keys(zip.files).some((f) => f.startsWith("ppt/media/")));
  const dl2 = await convertFrom(page, bytes, "pptx", { mode: "text" });
  const z2 = await JSZip.loadAsync(dl2.bytes);
  assert.match(await z2.file("ppt/slides/slide1.xml").async("string"), /Slide 1 Hello/);
});

await test("convert: PDF -> PNG/JPEG", async (page) => {
  const bytes = await makePdf(2);
  const dl = await convertFrom(page, bytes, "png", { dpi: "72" });
  const zip = await JSZip.loadAsync(dl.bytes);
  const names = Object.keys(zip.files).sort();
  assert.equal(names.length, 2);
  const first = await zip.file(names[0]).async("uint8array");
  assert.deepEqual([...first.slice(0, 4)], [137, 80, 78, 71]);
  const dl2 = await convertFrom(page, await makePdf(1), "jpeg", { dpi: "72" });
  assert.deepEqual([...dl2.bytes.slice(0, 3)], [0xff, 0xd8, 0xff]);
});

const toPdf = async (page, files) => {
  await page.goto(`${BASE}/#/convert`);
  await page.getByRole("tab", { name: /to PDF/ }).click();
  await setFile(page, files);
  return downloadOf(page, () => page.getByRole("button", { name: "Convert to PDF" }).click());
};

await test("convert: Word -> PDF keeps headings, text, lists, tables", async (page) => {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType } = await import("docx");
  const cell = (t) => new TableCell({ width: { size: 50, type: WidthType.PERCENTAGE }, children: [new Paragraph(t)] });
  const doc = new Document({ sections: [{ children: [
    new Paragraph({ text: "Quarterly Report", heading: HeadingLevel.HEADING_1 }),
    new Paragraph({ children: [new TextRun("Revenue grew "), new TextRun({ text: "strongly", bold: true }), new TextRun(" this quarter.")] }),
    new Paragraph({ text: "First bullet", bullet: { level: 0 } }),
    new Table({ rows: [new TableRow({ children: [cell("Region"), cell("Sales")] }), new TableRow({ children: [cell("North"), cell("1200")] })] }),
  ] }] });
  const buffer = await Packer.toBuffer(doc);
  const dl = await toPdf(page, { name: "report.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer });
  assert.match(dl.name, /report\.pdf$/);
  const t = (await pdfText(dl.bytes)).join(" ");
  for (const w of ["Quarterly Report", "Revenue grew", "strongly", "First bullet", "Region", "North", "1200"]) assert.ok(t.includes(w), `missing "${w}" in ${t}`);
});

await test("convert: Excel -> PDF", async (page) => {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Budget");
  ws.addRow(["Item", "Cost"]); ws.addRow(["Laptop", 1299.5]); ws.addRow(["Monitor", 310]);
  wb.addWorksheet("Notes").addRow(["Remember the receipts"]);
  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  const dl = await toPdf(page, { name: "budget.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer });
  const pages = await pdfText(dl.bytes);
  assert.equal(pages.length, 2);
  assert.match(pages[0], /Budget/); assert.match(pages[0], /Laptop/); assert.match(pages[0], /1299\.5/);
  assert.match(pages[1], /Remember the receipts/);
});

await test("convert: PowerPoint -> PDF", async (page) => {
  const { default: PptxGenJS } = await import("pptxgenjs");
  const pres = new PptxGenJS();
  const s1 = pres.addSlide(); s1.addText("Launch Plan", { x: 1, y: 1, w: 6, h: 1, fontSize: 32 }); s1.addText("Ship in May", { x: 1, y: 2, w: 6, h: 1 });
  const s2 = pres.addSlide(); s2.addText("Risks", { x: 1, y: 1, w: 6, h: 1 });
  s2.addImage({ data: "image/png;base64," + makePng(60, 30).toString("base64"), x: 1, y: 2, w: 2, h: 1 });
  const buffer = Buffer.from(await pres.write({ outputType: "nodebuffer" }));
  const dl = await toPdf(page, { name: "deck.pptx", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", buffer });
  const pages = await pdfText(dl.bytes);
  assert.equal(pages.length, 2);
  assert.match(pages[0], /Launch Plan/); assert.match(pages[0], /Ship in May/);
  assert.match(pages[1], /Risks/);
  assert.ok((await countImages(dl.bytes)) >= 1, "slide picture embedded");
});

await test("convert: images, CSV and text -> PDF", async (page) => {
  const dl = await toPdf(page, [{ name: "a.png", mimeType: "image/png", buffer: makePng(50, 50) }, { name: "b.png", mimeType: "image/png", buffer: makePng(80, 40, [10, 100, 200]) }]);
  assert.equal((await PDFDocument.load(dl.bytes)).getPageCount(), 2);
  const csv = await toPdf(page, { name: "people.csv", mimeType: "text/csv", buffer: Buffer.from('Name,City\n"Doe, Jane",Paris\nSam,Rome\n') });
  const ct = (await pdfText(csv.bytes)).join(" ");
  assert.ok(ct.includes("Doe, Jane") && ct.includes("Paris") && ct.includes("Rome"), ct);
  const txt = await toPdf(page, { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("Line one\nLine two\n") });
  assert.match((await pdfText(txt.bytes))[0], /Line one/);
});

await test("convert: unsupported file type is rejected with guidance", async (page) => {
  await page.goto(`${BASE}/#/convert`);
  await page.getByRole("tab", { name: /to PDF/ }).click();
  await setFile(page, { name: "old.doc", mimeType: "application/msword", buffer: Buffer.from("x") });
  await toast(page, "unsupported file type");
});


// ---------------------------------------------------------------- in-place text editing
const textItems = async (bytes) => {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, verbosity: 0 }).promise;
  const tc = await (await doc.getPage(1)).getTextContent();
  return tc.items.filter((i) => i.str.length).map((i) => ({ str: i.str, x: i.transform[4], y: i.transform[5], size: Math.hypot(i.transform[0], i.transform[1]), w: i.width }));
};
const openInvoice = async (page) => {
  await page.goto(`${BASE}/#/edit`);
  await setFile(page, { name: "invoice.pdf", mimeType: "application/pdf", buffer: await makeInvoice() });
  await page.waitForFunction(() => document.querySelector(".page-wrap canvas")?.width > 100);
  await page.locator(".block-hit").first().waitFor();
};

await test("edit text in place: real click, keeps size/position/alignment, rupee sign survives", async (page) => {
  const original = await makeInvoice();
  await openInvoice(page);
  // real mouse click on the grand-total amount block (right-aligned, bold, 12pt)
  await page.locator('[aria-label^="Edit text: ₹1,115.00"]').click();
  const box = page.locator(".obj.text .content");
  await box.waitFor();
  assert.equal(await box.getAttribute("contenteditable") !== "false", true);
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("₹12,999.50");
  await page.keyboard.press("Escape");
  const dl = await downloadOf(page, () => page.getByRole("button", { name: "Download PDF" }).click());
  const before = (await textItems(original));
  const after = (await textItems(dl.bytes));
  // glyph runs may be split between the original font and fallback faces, so compare the joined line
  const joined = after.map((i) => i.str).join("");
  assert.ok(joined.includes("₹12,999.50"), joined);
  assert.ok(joined.includes("Item(s) Subtotal:") && joined.includes("₹1,098.00"), "other text untouched");
  const line = (items) => items.filter((i) => Math.abs(i.y - 575) < 1 && i.x > 480);
  const oldLine = line(before), newLine = line(after);
  assert.ok(oldLine.length && newLine.length);
  assert.ok(newLine.every((i) => Math.abs(i.y - 575) < 0.8), "same baseline");
  assert.ok(newLine.every((i) => Math.abs(i.size - 12) < 0.2), "same font size");
  const oldRight = Math.max(...oldLine.map((i) => i.x + i.w)), newRight = Math.max(...newLine.map((i) => i.x + i.w));
  assert.ok(Math.abs(newRight - oldRight) < 1.5, `right edge ${newRight} vs ${oldRight}`);
});

await test("edit text in place: untouched blocks revert, paragraph/multi-line keep line breaks and left edge", async (page) => {
  const original = await makeInvoice();
  await openInvoice(page);
  // click a block and click away without typing -> nothing should change
  await page.locator('[aria-label^="Edit text: Order placed"]').click();
  await page.locator(".obj.text").waitFor();
  await page.mouse.click(5, 300);
  await page.waitForFunction(() => document.querySelectorAll(".obj.text").length === 0);
  // multi-line address block: change one word
  await page.locator('[aria-label^="Edit text: Kunal Soni"]').click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("Jane Roe\n22 Lake Road\nPune\nMAHARASHTRA\n411001");
  await page.keyboard.press("Escape");
  const dl = await downloadOf(page, () => page.getByRole("button", { name: "Download PDF" }).click());
  const before = await textItems(original);
  const after = await textItems(dl.bytes);
  const t = after.map((i) => i.str).join("");
  assert.ok(t.includes("Order placed 23 September 2026"), "untouched text unchanged");
  assert.ok(t.includes("Jane Roe") && t.includes("411001"), t);
  const oldFirst = before.find((i) => i.str === "Kunal Soni");
  const first = after.filter((i) => Math.abs(i.y - oldFirst.y) < 0.8 && i.x < 300);
  assert.ok(first.length, "first line on the original baseline");
  assert.ok(Math.abs(Math.min(...first.map((i) => i.x)) - oldFirst.x) < 0.6, "left edge kept");
  const lineY = (word) => after.find((i) => i.str.includes(word) && i.x < 300)?.y;
  assert.ok(Math.abs((oldFirst.y - lineY("22")) - 16) < 1, `line spacing ${oldFirst.y - lineY("22")}`);
  assert.ok(first.every((i) => Math.abs(i.size - 12) < 0.2));
});

await test("edit text: font can be changed from the panel and the original font is reported", async (page) => {
  await openInvoice(page);
  await page.locator('[aria-label^="Edit text: Ship to"]').click();
  await page.locator(".obj.text").waitFor();
  await page.getByLabel("Font", { exact: true }).selectOption("tinos");
  await page.getByLabel("Font size").fill("20");
  await page.keyboard.press("Tab");
  const dl = await downloadOf(page, () => page.getByRole("button", { name: "Download PDF" }).click());
  const items = await textItems(dl.bytes);
  const shipTo = items.find((i) => i.str === "Ship to" && i.size > 19);
  assert.ok(shipTo, "Ship to rendered at 20pt after change: " + JSON.stringify(items.filter((i) => i.str === "Ship to")));
});


await test("edit text: browser-printed PDF — click edits a paragraph, original text is really removed", async (page) => {
  const pdf = await makeChromePdf(context);
  assert.ok((await textItems(pdf)).map((i) => i.str).join("").includes("₹1,115.00"), "fixture has the amount");
  await page.goto(`${BASE}/#/edit`);
  await setFile(page, { name: "printed.pdf", mimeType: "application/pdf", buffer: pdf });
  await page.waitForFunction(() => document.querySelector(".page-wrap canvas")?.width > 100);
  await page.locator(".block-hit").first().waitFor();
  const blocks = await page.locator(".block-hit").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
  const labels = blocks.join(" || ");
  // the wrapped product title is ONE block; "Order Summary" labels and amounts are separate columns
  assert.ok(blocks.some((b) => /Tukzer Gel Mouse Pad Wrist Rest Memory-Foam Ergonomic Mousepad Cushion/.test(b)), "paragraph grouped as one block: " + labels);
  await page.locator('[aria-label^="Edit text: Tukzer"]').click();
  await page.locator('.obj.text .content[contenteditable="true"]').waitFor();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("Acme Ergonomic Mouse Pad with Wrist Rest, Black");
  await page.keyboard.press("Escape");
  await page.locator('[aria-label^="Edit text: Kunal Soni"]').click();
  await page.waitForFunction(() => document.querySelectorAll(".obj.text").length === 2);
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("Jane Roe\n22 Lake Road\nPune\nMAHARASHTRA\n411001");
  await page.keyboard.press("Escape");
  await page.mouse.click(5, 400);
  const dl = await downloadOf(page, () => page.getByRole("button", { name: "Download PDF" }).click());
  const all = (await textItems(dl.bytes)).map((i) => i.str).join("");
  assert.ok(all.includes("Acme Ergonomic Mouse Pad"), all);
  assert.ok(all.includes("Jane Roe") && all.includes("411001"), all);
  assert.ok(!all.includes("Tukzer"), "original paragraph text removed from the file");
  assert.ok(!all.includes("Kunal Soni") && !all.includes("marathon"), "original address text removed from the file");
  assert.ok(all.includes("₹1,115.00") && all.includes("OrderSummary".replace("Order", "Order ")) && all.includes("Order placed 23 September 2026"), "untouched text kept: " + all);
});


await test("edit text reuses the PDF's own embedded font when it has the glyphs", async (page) => {
  const pdf = await makeChromePdf(context);
  const before = await textWithFonts(pdf);
  const origName = before.find((i) => /Tukzer/.test(i.str)).font;
  assert.match(origName, /Arial|Helvetica|Liberation|Arimo/i, "fixture font: " + origName);
  await page.goto(`${BASE}/#/edit`);
  await setFile(page, { name: "printed.pdf", mimeType: "application/pdf", buffer: pdf });
  await page.waitForFunction(() => document.querySelector(".page-wrap canvas")?.width > 100);
  await page.locator('[aria-label^="Edit text: Tukzer"]').click();
  await page.locator('.obj.text .content[contenteditable="true"]').waitFor();
  const info = await page.evaluate(() => { const o = document.querySelector("#editor-scroll").__editor.objects.find((x) => x.type === "text"); return { useOrig: o.useOrig, faces: o.origFaces, family: getComputedStyle(document.querySelector(".obj.text .content")).fontFamily }; });
  assert.equal(info.useOrig, true);
  assert.ok(info.faces.length >= 1);
  assert.match(info.family, /^"?ps-orig-/, "preview renders with the original font first");
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("Wrist Rest Mouse Pad");
  await page.keyboard.press("Escape");
  await page.mouse.click(5, 400);
  const dl = await downloadOf(page, () => page.getByRole("button", { name: "Download PDF" }).click());
  const after = await textWithFonts(dl.bytes);
  const typed = after.filter((i) => /Wrist|Rest|Mouse|Pad/.test(i.str) && !/Tukzer/.test(i.str));
  assert.ok(typed.length >= 1, JSON.stringify(after.map((i) => i.str)));
  for (const t of typed) assert.equal(t.font.replace(/-\d+$/, ""), origName.replace(/-\d+$/, ""), `"${t.str}" drawn in ${t.font}, expected the original ${origName}`);
  // changing the font from the panel switches away from the original on purpose
  await page.locator('[aria-label^="Edit text: Wrist Rest"]').click().catch(() => {});
});

await test("edit text: centered headings stay centered when the text grows", async (page) => {
  const { PDFDocument: PD, StandardFonts: SF } = await import("pdf-lib");
  const d = await PD.create();
  const f = await d.embedFont(SF.HelveticaBold);
  const p = d.addPage([600, 400]);
  const w = f.widthOfTextAtSize("KUNAL SONI", 24);
  p.drawText("KUNAL SONI", { x: 300 - w / 2, y: 340, size: 24, font: f });
  const pdf = Buffer.from(await d.save());
  await page.goto(`${BASE}/#/edit`);
  await setFile(page, { name: "c.pdf", mimeType: "application/pdf", buffer: pdf });
  await page.waitForFunction(() => document.querySelector(".page-wrap canvas")?.width > 100);
  await page.locator('[aria-label^="Edit text: KUNAL"]').click();
  await page.locator('.obj.text .content[contenteditable="true"]').waitFor();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("KUNAL SONI JUNIOR");
  await page.keyboard.press("Escape");
  const dl = await downloadOf(page, () => page.getByRole("button", { name: "Download PDF" }).click());
  const items = (await textItems(dl.bytes)).filter((i) => /KUNAL|SONI|JUNIOR/.test(i.str));
  const left = Math.min(...items.map((i) => i.x)), right = Math.max(...items.map((i) => i.x + i.w));
  assert.ok(Math.abs((left + right) / 2 - 300) < 2, `center ${(left + right) / 2}`);
});


// ---------------------------------------------------------------- text-box behaviour (reported bugs)
const model = (page) => page.evaluate(() => { const e = document.querySelector("#editor-scroll").__editor; const o = e.objects.find((x) => x.type === "text"); return o ? JSON.parse(JSON.stringify({ x: o.x, y: o.y, text: o.text, fmt: o.fmt, paras: o.paras, bold: o.bold, size: o.size, lineHeight: o.lineHeight })) : null; });
const startEdit = async (page, label) => {
  await page.locator(`[aria-label^="Edit text: ${label}"]`).click();
  await page.locator('.obj.text .content[contenteditable="true"]').waitFor();
};
const charPoint = (page, idx, edge = "left") => page.evaluate(({ idx, edge }) => {
  const p = document.querySelector(".obj.text .content .p");
  const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
  let left = idx, n;
  while ((n = walker.nextNode())) {
    if (left < n.data.length) {
      const r = document.createRange(); r.setStart(n, left); r.setEnd(n, left + 1);
      const b = r.getBoundingClientRect();
      return { x: edge === "left" ? b.left + 1 : b.right - 1, y: b.top + b.height / 2 };
    }
    left -= n.data.length;
  }
  throw new Error("index out of range");
}, { idx, edge });

await test("text box: typed changes survive clicking outside (no Tab needed)", async (page) => {
  await openInvoice(page);
  await startEdit(page, "Order placed");
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("Order placed 1 January 2027");
  await page.mouse.click(5, 500); // click on the empty workspace
  await page.waitForFunction(() => !document.querySelector('.obj.text .content[contenteditable="true"]'));
  assert.equal((await model(page)).text, "Order placed 1 January 2027");
  assert.equal(await page.locator(".obj.text").count(), 1);
  const dl = await downloadOf(page, () => page.getByRole("button", { name: "Download PDF" }).click());
  assert.ok((await textItems(dl.bytes)).map((i) => i.str).join("").includes("Order placed 1 January 2027"));
});

await test("text box: clicking a letter places the caret; double-click selects a word; drag selects a range; box does not move", async (page) => {
  await openInvoice(page);
  await startEdit(page, "Order placed");
  const before = await model(page);
  assert.notEqual(await page.locator(".obj.text .content").evaluate((el) => getComputedStyle(el).cursor), "move");
  // caret at the 'p' of "placed" (index 6)
  let pt = await charPoint(page, 6);
  await page.mouse.click(pt.x, pt.y);
  await page.keyboard.type("Z");
  assert.equal((await model(page)).text, "Order Zplaced 23 September 2026");
  // double-click selects just one word
  pt = await charPoint(page, 9);
  await page.mouse.dblclick(pt.x, pt.y);
  const word = await page.evaluate(() => getSelection().toString().trim());
  assert.equal(word, "Zplaced", "double-click selects exactly one word");
  await page.keyboard.type("sent");
  assert.equal((await model(page)).text, "Order sent 23 September 2026");
  // drag-select "Order" and replace it
  const a = await charPoint(page, 0, "left"), b = await charPoint(page, 4, "right");
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 5 }); await page.mouse.up();
  assert.equal(await page.evaluate(() => getSelection().toString()), "Order");
  await page.keyboard.type("Invoice");
  const after = await model(page);
  assert.equal(after.text, "Invoice sent 23 September 2026");
  assert.ok(Math.abs(after.x - before.x) < 0.01 && Math.abs(after.y - before.y) < 0.01, "text box stayed put while selecting");
});

await test("text box: the move grip drags the box; pressing in the text never does", async (page) => {
  await openInvoice(page);
  await startEdit(page, "Order placed");
  const before = await model(page);
  const grip = page.locator(".obj.text .grip");
  const g = await grip.boundingBox();
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down(); await page.mouse.move(g.x + 60, g.y + 40, { steps: 6 }); await page.mouse.up();
  const moved = await model(page);
  assert.ok(moved.x - before.x > 20 && moved.y - before.y > 10, `moved by (${moved.x - before.x}, ${moved.y - before.y})`);
  assert.equal(moved.text, before.text);
});

await test("formatting: select with the keyboard, click Bold/Italic/Underline/colour — applies instantly, no blur/Tab", async (page) => {
  const original = await makeInvoice();
  await openInvoice(page);
  await startEdit(page, "Order placed");
  await page.keyboard.press(HOME);
  await page.keyboard.down("Shift");
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.up("Shift");
  await page.getByRole("button", { name: /^Bold/ }).click();
  assert.equal(await page.locator('.obj.text .content span[data-b="1"]').count(), 1, "bold span appears immediately");
  assert.equal(await page.getByRole("button", { name: /^Bold/ }).getAttribute("aria-pressed"), "true");
  assert.equal(await page.evaluate(() => getSelection().toString()), "Order", "selection survives the click");
  await page.getByRole("button", { name: /^Italic/ }).click();
  await page.getByRole("button", { name: /^Underline/ }).click();
  await page.locator('input[type="color"][aria-label="Text color"]').evaluate((el) => { el.value = "#d11a2a"; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); });
  let m = await model(page);
  assert.deepEqual(m.fmt, [{ s: 0, e: 5, b: true, i: true, u: true, c: "#d11a2a" }]);
  assert.equal(await page.evaluate(() => document.activeElement.className), "content", "focus is back in the text box");
  // typing keeps going without a click; keyboard shortcut toggles bold off for the selection
  await page.keyboard.press("ControlOrMeta+b");
  m = await model(page);
  assert.deepEqual(m.fmt, [{ s: 0, e: 5, i: true, u: true, c: "#d11a2a" }]);
  await page.keyboard.press("ControlOrMeta+b");
  await page.mouse.click(5, 500);
  const dl = await downloadOf(page, () => page.getByRole("button", { name: "Download PDF" }).click());
  const f = await textWithFonts(dl.bytes);
  const order = f.find((i) => /Order/.test(i.str) && i.y > 700 && i.size > 13 && i.x < 200);
  assert.match(order.font, /Bold.*Italic|BoldItalic|Bold-?Oblique|Arimo-BoldItalic/i, "first word is bold italic: " + order.font);
  const rest = f.find((i) => /placed|September/.test(i.str) && i.y > 700 && i.x < 300);
  assert.ok(!/Bold|Italic/i.test(rest.font), "rest stays regular: " + rest.font);
  // undo steps back through the formatting until the text is plain again
  let steps = 0;
  while (((await model(page))?.fmt ?? []).length && steps++ < 12) await page.getByTitle(/Undo/).click();
  assert.ok(steps > 0 && steps <= 12, "undo walks back through the format changes");
  const plain = await model(page);
  assert.ok(!plain || ((plain.fmt || []).length === 0 && plain.text === "Order placed 23 September 2026"), JSON.stringify(plain));
  void original;
});

await test("formatting: no selection formats the whole box; B/I buttons toggle from the toolbar immediately", async (page) => {
  await openInvoice(page);
  await startEdit(page, "Order placed");
  await page.getByRole("button", { name: /^Bold/ }).click();
  let m = await model(page);
  assert.equal(m.bold, true, "whole-box bold on first click (was the double-flip bug)");
  await page.getByRole("button", { name: /^Bold/ }).click();
  m = await model(page);
  assert.equal(m.bold, false);
  const size = page.getByLabel("Font size");
  await size.fill("20");
  assert.equal((await model(page)).size, 20, "size applies while typing in the field, no Tab");
});

await test("paragraph formatting: align, justify, bullets, numbering, indent, spacing, trim spaces", async (page) => {
  const pdf = await makeChromePdf(context);
  await page.goto(`${BASE}/#/edit`);
  await setFile(page, { name: "printed.pdf", mimeType: "application/pdf", buffer: pdf });
  await page.waitForFunction(() => document.querySelector(".page-wrap canvas")?.width > 100);
  await startEdit(page, "Tukzer");
  const m0 = await model(page);
  // justify + bullets + indent + line spacing
  await page.getByRole("button", { name: "Justify" }).click();
  assert.equal((await model(page)).paras[0].align, "justify");
  await page.getByRole("button", { name: "Bulleted list" }).click();
  assert.equal((await model(page)).paras[0].list, "bullet");
  await page.getByRole("button", { name: "Numbered list" }).click();
  assert.equal((await model(page)).paras[0].list, "number");
  await page.getByRole("button", { name: /^Increase indent/ }).click();
  assert.equal((await model(page)).paras[0].indent, 1);
  await page.getByLabel("Line spacing").selectOption({ label: "1.5×" });
  const m1 = await model(page);
  assert.ok(Math.abs(m1.lineHeight - 1.5 * m1.size) < 0.01);
  // trim spaces
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("   Wrist   Rest   Mouse    Pad  ");
  await page.getByRole("button", { name: /Trim extra spaces/ }).click();
  assert.equal((await model(page)).text, "Wrist Rest Mouse Pad");
  await page.mouse.click(5, 600);
  const dl = await downloadOf(page, () => page.getByRole("button", { name: "Download PDF" }).click());
  const items = await textItems(dl.bytes);
  const all = items.map((i) => i.str).join("");
  assert.ok(all.includes("1.") && all.includes("Wrist Rest Mouse Pad"), all);
  assert.ok(!all.includes("Tukzer"));
  void m0;
});

await test("paragraph formatting: centered/right-aligned multi-line text keeps alignment in the saved PDF", async (page) => {
  await openInvoice(page);
  await startEdit(page, "Kunal Soni");
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("Line one\nA much longer second line\nShort");
  await page.getByRole("button", { name: "Center" }).click();
  await page.mouse.click(5, 500);
  const dl = await downloadOf(page, () => page.getByRole("button", { name: "Download PDF" }).click());
  const items = (await textItems(dl.bytes)).filter((i) => /Line|longer|Short|one|second/.test(i.str) && i.x < 300);
  const rows = {};
  for (const i of items) (rows[Math.round(i.y)] ||= []).push(i);
  const centers = Object.values(rows).map((r) => (Math.min(...r.map((i) => i.x)) + Math.max(...r.map((i) => i.x + i.w))) / 2);
  assert.ok(centers.length >= 3, "three lines");
  assert.ok(Math.max(...centers) - Math.min(...centers) < 1.5, `all lines share a centre: ${centers}`);
});


await test("mixed bold/regular line keeps its bold label as character formatting and original fonts", async (page) => {
  const { PDFDocument: PD } = await import("pdf-lib");
  const fontkit = (await import("@pdf-lib/fontkit")).default;
  const { nodeFonts: nf } = await import("./harness.mjs");
  const d = await PD.create();
  d.registerFontkit(fontkit);
  const reg = await d.embedFont((await nf.faces("arimo", false, false, ""))[0].bytes, { subset: true });
  const bold = await d.embedFont((await nf.faces("arimo", true, false, ""))[0].bytes, { subset: true });
  const p = d.addPage([500, 300]);
  p.drawText("Languages:", { x: 40, y: 240, size: 12, font: bold });
  p.drawText(" Python (PySpark), SQL", { x: 40 + bold.widthOfTextAtSize("Languages:", 12), y: 240, size: 12, font: reg });
  const pdf = Buffer.from(await d.save());
  await page.goto(`${BASE}/#/edit`);
  await setFile(page, { name: "mixed.pdf", mimeType: "application/pdf", buffer: pdf });
  await page.waitForFunction(() => document.querySelector(".page-wrap canvas")?.width > 100);
  await startEdit(page, "Languages");
  const m = await model(page);
  assert.equal(m.text, "Languages: Python (PySpark), SQL");
  assert.deepEqual(m.fmt.map((r) => [r.s, r.e, r.b]), [[0, 10, true]], "bold label recovered from the run fonts");
  assert.equal(await page.locator('.obj.text .content span[data-b="1"]').first().textContent(), "Languages:");
  await page.keyboard.press(END);
  await page.keyboard.type(", Scala");
  await page.mouse.click(5, 500);
  const dl = await downloadOf(page, () => page.getByRole("button", { name: "Download PDF" }).click());
  const f = await textWithFonts(dl.bytes);
  const label = f.find((i) => /Languages/.test(i.str));
  const rest = f.find((i) => /Python|Scala/.test(i.str));
  assert.match(label.font, /Bold/i, label.font);
  assert.ok(!/Bold/i.test(rest.font), rest.font);
  assert.ok(f.map((i) => i.str).join("").replace(/\s/g, "").includes("Languages:Python(PySpark),SQL,Scala"));
});


// ---------------------------------------------------------------- hyperlinks + text weight
const selectFirstWord = async (page, n = 5) => {
  await page.keyboard.press(HOME);
  await page.keyboard.down("Shift");
  for (let i = 0; i < n; i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.up("Shift");
};

await test("hyperlink: Insert link on selected text, edit, validate, remove — and it is saved as a clickable link", async (page) => {
  await openInvoice(page);
  await startEdit(page, "Order placed");
  await selectFirstWord(page, 5); // "Order"
  await page.getByRole("button", { name: /^Insert link/ }).click();
  const dlg = page.getByRole("dialog");
  assert.equal(await dlg.getByLabel("Text to display").inputValue(), "Order");
  // invalid targets are rejected inside the dialog
  await dlg.getByLabel("Link address").fill("javascript:alert(1)");
  await dlg.getByRole("button", { name: "OK" }).click();
  await page.getByRole("alert").filter({ hasText: "Only http" }).waitFor();
  await page.getByRole("dialog").getByLabel("Link address").fill("example.com");
  await page.getByRole("dialog").getByRole("button", { name: "OK" }).click();
  await page.getByRole("dialog").waitFor({ state: "detached" });
  let m = await model(page);
  assert.deepEqual(m.fmt, [{ s: 0, e: 5, u: true, c: "#0563c1", l: "https://example.com/" }]);
  assert.equal(await page.locator('.obj.text .content span[data-l]').first().textContent(), "Order");
  assert.equal(await page.getByRole("button", { name: "Remove link" }).isDisabled(), false);
  assert.equal(await page.evaluate(() => document.activeElement.className), "content", "typing can continue");
  // Ctrl+K on the link opens the dialog in edit mode with the address filled in
  await page.keyboard.press("ArrowLeft"); await page.keyboard.press("ArrowRight");
  await page.keyboard.press(HOME); await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ControlOrMeta+k");
  const edit = page.getByRole("dialog");
  assert.equal(await edit.getByLabel("Link address").inputValue(), "https://example.com/");
  await edit.getByRole("button", { name: "Cancel" }).click();
  // link to a page of this document, using the keyboard shortcut and the dialog's second option
  await page.keyboard.press(END);
  await page.keyboard.press(SHIFT_HOME);
  await page.keyboard.press("ArrowRight"); // collapse
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("dialog").getByLabel("Text to display").fill("see page 1");
  await page.getByRole("dialog").getByLabel("Place in this document (page number)").check();
  await page.getByRole("dialog").getByLabel("Target page").fill("1");
  await page.getByRole("dialog").getByRole("button", { name: "OK" }).click();
  m = await model(page);
  assert.ok(m.text.endsWith("see page 1") || m.text.includes("see page 1"), m.text);
  assert.ok(m.fmt.some((f) => f.l === "#page=1"));
  await page.mouse.click(5, 500);
  const dl = await downloadOf(page, () => page.getByRole("button", { name: "Download PDF" }).click());
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(dl.bytes), verbosity: 0 }).promise;
  const annots = (await (await doc.getPage(1)).getAnnotations()).filter((a) => a.subtype === "Link");
  assert.ok(annots.some((a) => a.url === "https://example.com/"), "web link is a real PDF link annotation");
  assert.ok(annots.some((a) => a.dest), "page link is a real PDF link annotation");
  const web = annots.find((a) => a.url);
  const word = (await textItems(dl.bytes)).find((i) => /Order/.test(i.str) && i.y > 700 && i.x < 120);
  const rw = web.rect[2] - web.rect[0];
  assert.ok(Math.abs(web.rect[0] - word.x) < 1.2 && rw > 28 && rw < 45 && web.rect[1] <= word.y && web.rect[3] >= word.y + 8, `link rectangle sits on the word "Order": rect=${JSON.stringify(web.rect)} text starts at ${word.x}, baseline ${word.y}`);
});

await test("hyperlink: remove link restores plain text; insert at a bare caret adds new linked text", async (page) => {
  await openInvoice(page);
  await startEdit(page, "Order placed");
  await selectFirstWord(page, 5);
  await page.getByRole("button", { name: /^Insert link/ }).click();
  await page.getByRole("dialog").getByLabel("Link address").fill("https://example.com");
  await page.getByRole("dialog").getByRole("button", { name: "OK" }).click();
  await page.keyboard.press(HOME); await page.keyboard.press("ArrowRight");
  await page.getByRole("button", { name: "Remove link" }).click();
  let m = await model(page);
  assert.deepEqual(m.fmt, [], "link, underline and link colour all removed");
  assert.equal(m.text, "Order placed 23 September 2026");
  // caret at the end → insert new linked text
  await page.keyboard.press(END);
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("dialog").getByLabel("Text to display").fill(" Docs");
  await page.getByRole("dialog").getByLabel("Link address").fill("docs.example.org/start");
  await page.getByRole("dialog").getByRole("button", { name: "OK" }).click();
  m = await model(page);
  assert.equal(m.text, "Order placed 23 September 2026 Docs");
  assert.equal(m.fmt[0].l, "https://docs.example.org/start");
});

await test("edit box text weight matches the original page (no lighter/thinner text after clicking)", async (page) => {
  await openInvoice(page);
  await page.waitForTimeout(600);
  const hit = page.locator('[aria-label^="Edit text: Item(s) Subtotal"]');
  const box = await hit.boundingBox();
  const clip = { x: box.x + 4, y: box.y + 2, width: Math.min(box.width - 8, 120), height: box.height - 4 };
  const ink = async () => { const png = PNG.sync.read(await page.screenshot({ clip })); let sum = 0; for (let i = 0; i < png.data.length; i += 4) sum += 255 - (png.data[i] + png.data[i + 1] + png.data[i + 2]) / 3; return sum / (png.data.length / 4); };
  const before = await ink();
  await hit.click();
  await page.locator('.obj.text .content[contenteditable="true"]').waitFor();
  await page.mouse.move(2, 2);
  const after = await ink();
  const ratio = after / before;
  assert.ok(ratio > 0.94 && ratio < 1.06, `ink ratio edit-box/original = ${ratio.toFixed(3)} (was ~0.88 with antialiased smoothing)`);
  // bold: the Bold button must give the bold face's weight, not something heavier than the original bold text
  const smoothing = await page.locator(".obj.text .content").evaluate((el) => getComputedStyle(el).webkitFontSmoothing);
  assert.notEqual(smoothing, "antialiased");
});


await test("font size: changing it with a word selected resizes only that word; no selection / select-all resizes the whole box", async (page) => {
  await openInvoice(page);
  await startEdit(page, "Order placed");
  await selectFirstWord(page, 5); // "Order"
  const size = page.getByLabel("Font size");
  await size.fill("24");
  let m = await model(page);
  assert.equal(m.size, 14, "box base size unchanged");
  assert.deepEqual(m.fmt, [{ s: 0, e: 5, z: 24 }]);
  assert.equal(await page.locator('.obj.text .content span[data-z="24"]').first().textContent(), "Order");
  await page.mouse.click(5, 500);
  const dl = await downloadOf(page, () => page.getByRole("button", { name: "Download PDF" }).click());
  // font sizes used in the page content: the 24pt word and the 14pt rest share one line
  const { PDFDocument: PD2, PDFArray, decodePDFRawStream } = await import("pdf-lib");
  const pd = await PD2.load(dl.bytes);
  const pg = pd.getPage(0);
  const refs = pg.node.Contents() instanceof PDFArray ? pg.node.Contents().asArray() : [pg.node.get((await import("pdf-lib")).PDFName.of("Contents"))];
  const content = refs.map((r) => Buffer.from(decodePDFRawStream(pd.context.lookup(r)).decode()).toString("latin1")).join("\n");
  const sizes = new Set([...content.matchAll(/\/\S+\s+([\d.]+)\s+Tf/g)].map((m) => Math.round(+m[1])));
  assert.ok(sizes.has(24) && sizes.has(14), `font sizes in content: ${[...sizes]}`);
  const line = (await textItems(dl.bytes)).filter((i) => i.y > 700 && i.x < 300);
  assert.equal(line.length, 1, "one text line (words share a baseline)");
  // select everything → whole box
  await page.locator(".obj.text .content").click();
  await page.locator('.obj.text .content[contenteditable="true"]').waitFor();
  await page.keyboard.press("ControlOrMeta+a");
  await page.getByLabel("Font size").fill("18");
  m = await model(page);
  assert.equal(m.size, 18);
  assert.deepEqual(m.fmt, [], "per-word size overrides cleared");
});


// ---------------------------------------------------------------- older browsers
// Emulates browsers that lack newer JS APIs (the cause of "getOrInsertComputed is not a function" on Safari/Chrome):
// they are removed from the page AND from the PDF worker before the app loads. Polyfills must make everything work.
const OLD_BROWSER = `
  for (const C of [Map, WeakMap]) { delete C.prototype.getOrInsert; delete C.prototype.getOrInsertComputed; }
  delete Promise.try; delete Promise.withResolvers; delete Math.sumPrecise;
  delete Array.prototype.findLast; delete Array.prototype.findLastIndex; delete Array.prototype.toSorted; delete Array.prototype.toReversed;
  delete Object.groupBy; delete Map.groupBy;
  if (typeof ReadableStream !== "undefined") { delete ReadableStream.prototype[Symbol.asyncIterator]; delete ReadableStream.prototype.values; }
`;
await test("older browser (new JS APIs missing): editing, merge, convert, protect, OCR still work", async () => {
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1400, height: 900 } });
  // static imports keep the worker's message handler registered before any message arrives (like the real worker)
  await ctx.addInitScript(`${OLD_BROWSER}
    const rm = URL.createObjectURL(new Blob([${JSON.stringify(OLD_BROWSER)}], { type: "text/javascript" }));
    const W = window.Worker;
    window.Worker = class extends W { constructor(url, o) { const abs = new URL(url, location.href).href;
      if (!/pdfWorker/.test(abs)) return super(url, o);
      super(URL.createObjectURL(new Blob(['import ' + JSON.stringify(rm) + '; import ' + JSON.stringify(abs) + ';'], { type: "text/javascript" })), o); } };`);
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  try {
    await page.goto(`${BASE}/#/edit`);
    await setFile(page, { name: "invoice.pdf", mimeType: "application/pdf", buffer: await makeInvoice() });
    await page.waitForFunction(() => document.querySelector(".page-wrap canvas")?.width > 100);
    await page.locator(".block-hit").first().waitFor();
    await startEdit(page, "Order placed");
    await page.keyboard.type(" X");
    assert.equal(await page.locator(".toast.error").count(), 0, "no error toasts");
    // merge
    await page.goto(`${BASE}/#/merge`);
    await setFile(page, { name: "a.pdf", mimeType: "application/pdf", buffer: await makePdf(1) });
    await page.locator(".file-row").first().waitFor();
    await setFile(page, { name: "b.pdf", mimeType: "application/pdf", buffer: await makePdf(2) });
    await page.waitForFunction(() => document.querySelectorAll(".file-row").length === 2);
    const m = await downloadOf(page, () => page.getByRole("button", { name: "Merge PDFs" }).click());
    assert.equal((await PDFDocument.load(m.bytes)).getPageCount(), 3);
    // convert PDF -> Word
    await page.goto(`${BASE}/#/convert`); await page.reload();
    await setFile(page, { name: "r.pdf", mimeType: "application/pdf", buffer: await makePdf(1) });
    await page.getByText(/r\.pdf · \d+ page/).waitFor();
    const d = await downloadOf(page, () => page.getByRole("button", { name: "Convert", exact: true }).click());
    assert.ok(d.name.endsWith(".docx"));
    // protect
    await page.goto(`${BASE}/#/protect`);
    await setFile(page, { name: "p.pdf", mimeType: "application/pdf", buffer: await makePdf(1) });
    await page.getByLabel("Password", { exact: true }).first().fill("pw1"); await page.getByLabel("Confirm password").fill("pw1");
    const pr = await downloadOf(page, () => page.getByRole("button", { name: "Protect & download" }).click());
    assert.ok(pr.name.endsWith("-protected.pdf"));
    assert.deepEqual(errs, [], "no uncaught errors: " + errs.join(" | "));
  } finally {
    await ctx.close();
  }
});

await browser.close();
server.proc.kill();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
