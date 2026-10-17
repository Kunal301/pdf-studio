import { h, download, baseName, readBytes, zipFiles, imageFileToEmbeddable } from "../lib/util.js";
import { dropzone, iconEl, toast, progressBar, fileChip } from "../lib/ui.js";
import { loadPdfFile } from "../lib/pdf.js";
import { imagesToPdf } from "../lib/ops.js";
import * as conv from "../lib/convertLib.js";

const MIME = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export async function mount(root) {
  const tabs = [["from", "PDF to Word, Excel, PowerPoint, images"], ["to", "Word, Excel, PowerPoint, images to PDF"]];
  const tabBar = h("div.tabs-inline", { role: "tablist" });
  const body = h("div");
  const show = (id) => {
    tabBar.replaceChildren(...tabs.map(([t, l]) => h("button" + (t === id ? ".active" : ""), { role: "tab", "aria-selected": String(t === id), onclick: () => show(t) }, l)));
    body.replaceChildren();
    (id === "from" ? fromPdf : toPdf)(body);
  };
  root.append(h("div.tool-page", {}, h("h1", {}, "Convert files"), h("p.sub", {}, "Convert PDFs to Word, Excel, PowerPoint and images — and those formats back to PDF. Everything runs on your computer."), tabBar, body));
  show("from");

  function fromPdf(box) {
    let loaded = null;
    const info = h("div.hint", {}, "No file selected");
    const target = h("select", { "aria-label": "Convert to", onchange: opts }, [["docx", "Word (.docx)"], ["xlsx", "Excel (.xlsx)"], ["pptx", "PowerPoint (.pptx)"], ["png", "PNG images"], ["jpeg", "JPEG images"]].map(([v, l]) => h("option", { value: v }, l)));
    const mode = h("select", { "aria-label": "Mode" }, [["text", "Editable text (reconstructed)"], ["image", "Exact look (page images)"]].map(([v, l]) => h("option", { value: v }, l)));
    const dpi = h("select", { "aria-label": "Resolution" }, [["72", "72 DPI (screen)"], ["150", "150 DPI"], ["300", "300 DPI (print)"]].map(([v, l]) => h("option", { value: v, selected: v === "150" }, l)));
    const modeWrap = h("label.field", {}, h("span", {}, "Layout"), mode);
    const dpiWrap = h("label.field", { style: { display: "none" } }, h("span", {}, "Resolution"), dpi);
    const note = h("p.hint");
    const prog = progressBar();
    const progWrap = h("div", { style: { display: "none" } }, prog.el);
    const btn = h("button.btn.primary", { disabled: true, onclick: run }, iconEl("convert", 18), "Convert");
    function opts() {
      const t = target.value;
      modeWrap.style.display = t === "docx" || t === "pptx" ? "" : "none";
      dpiWrap.style.display = t === "png" || t === "jpeg" ? "" : "none";
      mode.value = t === "pptx" ? "image" : "text";
      note.textContent = { docx: "“Editable text” rebuilds headings and paragraphs from the PDF text; complex layouts, tables and images are simplified. “Exact look” puts each page in Word as an image.", xlsx: "Table-like rows on each page become spreadsheet rows (one sheet per page). Scanned PDFs need OCR first.", pptx: "“Exact look” makes one slide per page with the page as a picture; “Editable text” places text boxes at their original positions.", png: "One image per page, delivered as a ZIP when there are several.", jpeg: "One image per page, delivered as a ZIP when there are several." }[t];
    }
    const zone = dropzone({ accept: "application/pdf,.pdf", label: "Drop a PDF here or click to browse", onFiles: async ([f]) => { try { loaded = await loadPdfFile(f); info.textContent = `${loaded.name} · ${loaded.doc.numPages} page${loaded.doc.numPages === 1 ? "" : "s"}`; btn.disabled = false; } catch (e) { if (e.message !== "Password entry cancelled") toast(e.message, "error", 6000); } } });
    async function run() {
      btn.disabled = true;
      progWrap.style.display = "";
      const onProgress = (f, t) => prog.set(f, t);
      try {
        const { doc, name } = loaded;
        const base = baseName(name);
        const t = target.value;
        let out, fname, type;
        if (t === "docx") { out = await conv.pdfToDocx(doc, { mode: mode.value, onProgress }); fname = `${base}.docx`; type = MIME.docx; }
        else if (t === "xlsx") { out = await conv.pdfToXlsx(doc, { onProgress }); fname = `${base}.xlsx`; type = MIME.xlsx; }
        else if (t === "pptx") { out = await conv.pdfToPptx(doc, { mode: mode.value, onProgress }); fname = `${base}.pptx`; type = MIME.pptx; }
        else {
          const imgs = await conv.pdfToImages(doc, { format: t, dpi: +dpi.value, onProgress });
          if (imgs.length === 1) { out = imgs[0].bytes; fname = `${base}-${imgs[0].name}`; type = t === "png" ? "image/png" : "image/jpeg"; }
          else { out = await zipFiles(imgs.map((i) => ({ name: `${base}-${i.name}`, bytes: i.bytes }))); fname = `${base}-images.zip`; type = "application/zip"; }
        }
        prog.set(1, "Done");
        download(out, fname, type);
        toast(`Saved ${fname}`, "success");
      } catch (e) {
        console.error(e);
        toast(`Conversion failed: ${e.message}`, "error", 8000);
      } finally { btn.disabled = false; }
    }
    box.append(zone, h("div", { style: { height: "12px" } }), info, h("div", { style: { height: "12px" } }),
      h("div.panel", {}, h("div.row", {}, h("label.field", {}, h("span", {}, "Convert to"), target), modeWrap, dpiWrap), note, btn, h("div", { style: { height: "10px" } }), progWrap));
    opts();
  }

  function toPdf(box) {
    let files = [];
    const list = h("div.row");
    const combine = h("input", { type: "checkbox", checked: true });
    const fit = h("select", { "aria-label": "Image size" }, [["a4", "Fit to A4 page"], ["original", "Original image size"]].map(([v, l]) => h("option", { value: v }, l)));
    const prog = progressBar();
    const progWrap = h("div", { style: { display: "none" } }, prog.el);
    const btn = h("button.btn.primary", { disabled: true, onclick: run }, iconEl("convert", 18), "Convert to PDF");
    const render = () => { list.replaceChildren(...files.map((f, i) => fileChip(f, () => { files.splice(i, 1); render(); }))); btn.disabled = !files.length; };
    const kind = (f) => { const n = f.name.toLowerCase(); if (/\.docx$/.test(n)) return "docx"; if (/\.xlsx$/.test(n)) return "xlsx"; if (/\.pptx$/.test(n)) return "pptx"; if (/\.(csv|tsv)$/.test(n)) return "csv"; if (/\.(txt|md|log)$/.test(n)) return "txt"; if (f.type.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp)$/.test(n)) return "img"; return null; };
    const zone = dropzone({ accept: ".docx,.xlsx,.pptx,.csv,.txt,.md,image/*", multiple: true, label: "Drop Word, Excel, PowerPoint, text or image files here", onFiles: (fs) => { for (const f of fs) kind(f) ? files.push(f) : toast(`${f.name}: unsupported file type (older .doc/.xls/.ppt files must be saved as .docx/.xlsx/.pptx first).`, "error", 7000); render(); } });
    async function run() {
      btn.disabled = true;
      progWrap.style.display = "";
      const results = [];
      try {
        const imgs = files.filter((f) => kind(f) === "img");
        const others = files.filter((f) => kind(f) !== "img");
        let i = 0;
        const total = others.length + (imgs.length ? 1 : 0);
        if (imgs.length) {
          prog.set(0, "Converting images…");
          const items = [];
          for (const f of imgs) items.push(await imageFileToEmbeddable(f));
          if (combine.checked || imgs.length === 1) results.push({ name: `${imgs.length === 1 ? baseName(imgs[0].name) : "images"}.pdf`, bytes: await imagesToPdf(items, { fit: fit.value }) });
          else for (let k = 0; k < imgs.length; k++) results.push({ name: `${baseName(imgs[k].name)}.pdf`, bytes: await imagesToPdf([items[k]], { fit: fit.value }) });
          i++;
        }
        for (const f of others) {
          prog.set(i / total, `Converting ${f.name}…`);
          const k = kind(f);
          let bytes;
          if (k === "docx") bytes = await conv.docxToPdf(await readBytes(f));
          else if (k === "xlsx") bytes = await conv.xlsxToPdf(await readBytes(f));
          else if (k === "pptx") bytes = await conv.pptxToPdf(await readBytes(f));
          else if (k === "csv") bytes = await conv.rowsToPdf(conv.csvToRows(await f.text()), baseName(f.name));
          else bytes = await conv.textToPdf(await f.text());
          results.push({ name: `${baseName(f.name)}.pdf`, bytes });
          i++;
        }
        prog.set(1, "Done");
        if (results.length === 1) download(results[0].bytes, results[0].name, "application/pdf");
        else download(await zipFiles(results), "converted-pdfs.zip", "application/zip");
        toast(`Created ${results.length} PDF${results.length === 1 ? "" : "s"}.`, "success");
      } catch (e) {
        console.error(e);
        toast(`Conversion failed: ${e.message}`, "error", 8000);
      } finally { btn.disabled = !files.length; }
    }
    box.append(zone, h("div", { style: { height: "12px" } }), list, h("div", { style: { height: "12px" } }),
      h("div.panel", {}, h("div.row", {}, h("label.check", {}, combine, "Combine images into one PDF"), h("label.field", {}, h("span", {}, "Images"), fit)),
        h("p.hint", {}, "Word, Excel and PowerPoint files are converted with a built-in renderer: text, headings, lists, tables and PNG/JPEG pictures are kept, but fonts, colors and complex layout are simplified."),
        btn, h("div", { style: { height: "10px" } }), progWrap));
  }
}
