import { h, download, baseName } from "../lib/util.js";
import { dropzone, iconEl, toast } from "../lib/ui.js";
import { loadPdfFile, pageCanvas } from "../lib/pdf.js";
import { buildFromPlan } from "../lib/ops.js";

const BOX_W = 150;
const BOX_H = 190;

export async function mount(root) {
  const page = h("div.tool-page", { style: { maxWidth: "1180px" } }, h("h1", {}, "Organize pages"), h("p.sub", {}, "Reorder by dragging. Rotate, delete, duplicate, insert blank pages or pages from another PDF, or extract a selection."));
  root.append(page);
  const zone = dropzone({ accept: "application/pdf,.pdf", label: "Drop a PDF here or click to browse", onFiles: ([f]) => start(f) });
  page.append(zone);

  /** @type {{bytes:Uint8Array, doc:any, name:string}[]} */
  const sources = [];
  /** items: {key, src, page, rotate, blank?, thumb?:HTMLCanvasElement, w, h} */
  let items = [];
  let selected = new Set();
  let keySeq = 1;
  let name = "document.pdf";
  let dragKey = null;
  let grid, toolbar, status;

  async function makeItem(src, pageIdx) {
    const doc = sources[src].doc;
    const canvas = await pageCanvas(doc, pageIdx + 1, 0.4);
    const p = await doc.getPage(pageIdx + 1);
    const [x0, y0, x1, y1] = p.view;
    return { key: keySeq++, src, page: pageIdx, rotate: 0, canvas, base: p.rotate, w: x1 - x0, h: y1 - y0 };
  }

  async function start(file) {
    let loaded;
    try {
      loaded = await loadPdfFile(file);
    } catch (e) {
      if (e.message !== "Password entry cancelled") toast(e.message, "error", 6000);
      return;
    }
    name = loaded.name;
    sources.push(loaded);
    items = [];
    for (let i = 0; i < loaded.doc.numPages; i++) items.push(await makeItem(0, i));
    build();
  }

  function build() {
    status = h("span.hint");
    const btn = (label, ico, fn, opts = {}) => h("button.btn" + (opts.primary ? ".primary" : "") + (opts.danger ? ".danger" : "") + ".sm", { onclick: fn, disabled: opts.disabled, title: label }, ico && iconEl(ico, 16), label);
    const insertInput = h("input", { type: "file", accept: "application/pdf,.pdf", hidden: true });
    insertInput.addEventListener("change", async () => {
      const f = insertInput.files[0];
      insertInput.value = "";
      if (f) await insertFrom(f);
    });
    toolbar = h("div.panel.row", { style: { position: "sticky", top: "56px", zIndex: 5 } },
      btn("Select all", null, () => { selected = new Set(items.map((i) => i.key)); render(); }),
      btn("Clear", null, () => { selected.clear(); render(); }),
      h("span.sep", { style: { width: "1px", height: "24px", background: "var(--line)" } }),
      btn("Rotate left", "rotateL", () => rotate(-90)),
      btn("Rotate right", "rotate", () => rotate(90)),
      btn("Duplicate", "copy", duplicate),
      btn("Delete", "trash", del, { danger: true }),
      btn("Blank page", "plus", addBlank),
      btn("Insert from PDF…", "plus", () => insertInput.click()),
      insertInput,
      btn("Extract selected", "down", extract),
      h("span", { style: { flex: 1 } }),
      status,
      btn("Download PDF", "down", save, { primary: true }));
    grid = h("div.page-grid");
    page.replaceChildren(h("h1", {}, "Organize pages"), h("p.sub", {}, `${name} — drag pages to reorder, click to select.`), toolbar, grid);
    render();
  }

  const afterSel = () => items.findIndex((i) => selected.has(i.key));
  const targets = () => (selected.size ? items.filter((i) => selected.has(i.key)) : []);

  function rotate(deg) {
    const t = targets();
    if (!t.length) return toast("Select one or more pages first.");
    t.forEach((i) => (i.rotate = (((i.rotate + deg) % 360) + 360) % 360));
    render();
  }
  function del() {
    const t = targets();
    if (!t.length) return toast("Select one or more pages first.");
    if (t.length === items.length) return toast("A PDF needs at least one page.", "error");
    items = items.filter((i) => !selected.has(i.key));
    selected.clear();
    render();
  }
  async function duplicate() {
    const t = targets();
    if (!t.length) return toast("Select one or more pages first.");
    const out = [];
    for (const i of items) {
      out.push(i);
      if (selected.has(i.key)) out.push({ ...i, key: keySeq++ });
    }
    items = out;
    render();
  }
  function addBlank() {
    const ref = items[0];
    const idx = selected.size ? items.map((i) => selected.has(i.key)).lastIndexOf(true) + 1 : items.length;
    items.splice(idx, 0, { key: keySeq++, blank: true, rotate: 0, w: ref.w, h: ref.h, base: 0 });
    render();
  }
  async function insertFrom(file) {
    try {
      const loaded = await loadPdfFile(file);
      sources.push(loaded);
      const si = sources.length - 1;
      const idx = selected.size ? items.map((i) => selected.has(i.key)).lastIndexOf(true) + 1 : items.length;
      const fresh = [];
      for (let i = 0; i < loaded.doc.numPages; i++) fresh.push(await makeItem(si, i));
      items.splice(idx, 0, ...fresh);
      toast(`Inserted ${fresh.length} page${fresh.length === 1 ? "" : "s"} from ${loaded.name}.`, "success");
      render();
    } catch (e) {
      if (e.message !== "Password entry cancelled") toast(e.message, "error", 6000);
    }
  }
  const plan = (list) => list.map((i) => (i.blank ? { blank: { w: i.w, h: i.h } } : { src: i.src, page: i.page, rotate: i.rotate }));
  async function extract() {
    const t = items.filter((i) => selected.has(i.key));
    if (!t.length) return toast("Select the pages to extract first.");
    const out = await buildFromPlan(sources.map((s) => s.bytes), plan(t));
    download(out, `${baseName(name)}-extract.pdf`, "application/pdf");
  }
  async function save() {
    try {
      const out = await buildFromPlan(sources.map((s) => s.bytes), plan(items));
      download(out, `${baseName(name)}-organized.pdf`, "application/pdf");
      toast(`Saved ${items.length} pages.`, "success");
    } catch (e) {
      toast(`Could not save: ${e.message}`, "error", 6000);
    }
  }

  function thumb(i) {
    const box = h("div.pbox");
    if (i.blank) {
      const rot = i.rotate % 180 !== 0;
      const dw = rot ? i.h : i.w, dh = rot ? i.w : i.h;
      const s = Math.min(BOX_W / dw, BOX_H / dh);
      const el = h("div.blank", { style: { width: `${i.w * s}px`, height: `${i.h * s}px`, transform: `translate(-50%,-50%) rotate(${i.rotate}deg)` } });
      box.append(el);
      return box;
    }
    const c = i.canvas;
    const clone = document.createElement("canvas");
    clone.width = c.width; clone.height = c.height;
    clone.getContext("2d").drawImage(c, 0, 0);
    const deg = i.rotate;
    const turned = deg % 180 !== 0;
    const dw = turned ? c.height : c.width, dh = turned ? c.width : c.height;
    const s = Math.min(BOX_W / dw, BOX_H / dh);
    clone.style.width = `${c.width * s}px`;
    clone.style.height = `${c.height * s}px`;
    clone.style.transform = `translate(-50%,-50%) rotate(${deg}deg)`;
    box.append(clone);
    return box;
  }

  function render() {
    grid.replaceChildren(
      ...items.map((i, n) => {
        const sel = selected.has(i.key);
        const card = h("div.pcard" + (sel ? ".selected" : ""), { draggable: true, tabIndex: 0, role: "checkbox", "aria-checked": String(sel), "aria-label": `Page ${n + 1}`, "data-key": i.key },
          h("input.tick", { type: "checkbox", checked: sel, tabIndex: -1, "aria-hidden": "true" }),
          thumb(i),
          h("div.label", {}, i.blank ? `${n + 1} · blank` : `${n + 1}${sources.length > 1 ? ` · ${sources[i.src].name.slice(0, 12)}` : ""}`),
          h("div.tools", {},
            h("button.iconbtn", { title: "Rotate left", "aria-label": `Rotate page ${n + 1} left`, onclick: (e) => { e.stopPropagation(); i.rotate = (i.rotate + 270) % 360; render(); } }, iconEl("rotateL", 16)),
            h("button.iconbtn", { title: "Rotate right", "aria-label": `Rotate page ${n + 1} right`, onclick: (e) => { e.stopPropagation(); i.rotate = (i.rotate + 90) % 360; render(); } }, iconEl("rotate", 16)),
            h("button.iconbtn.danger", { title: "Delete page", "aria-label": `Delete page ${n + 1}`, onclick: (e) => { e.stopPropagation(); if (items.length === 1) return toast("A PDF needs at least one page.", "error"); items = items.filter((x) => x.key !== i.key); selected.delete(i.key); render(); } }, iconEl("trash", 16))));
        const toggle = () => { selected.has(i.key) ? selected.delete(i.key) : selected.add(i.key); render(); };
        card.addEventListener("click", toggle);
        card.addEventListener("keydown", (e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); toggle(); } });
        card.addEventListener("dragstart", (e) => { dragKey = i.key; e.dataTransfer.effectAllowed = "move"; card.classList.add("dragging"); });
        card.addEventListener("dragend", () => { dragKey = null; render(); });
        card.addEventListener("dragover", (e) => { e.preventDefault(); card.classList.add("dropbefore"); });
        card.addEventListener("dragleave", () => card.classList.remove("dropbefore"));
        card.addEventListener("drop", (e) => {
          e.preventDefault();
          if (dragKey == null || dragKey === i.key) return;
          // move the dragged page (plus other selected pages if it was selected) before this one
          const moving = selected.has(dragKey) ? items.filter((x) => selected.has(x.key)) : items.filter((x) => x.key === dragKey);
          const rest = items.filter((x) => !moving.includes(x));
          const at = rest.findIndex((x) => x.key === i.key);
          rest.splice(at < 0 ? rest.length : at, 0, ...moving);
          items = rest;
          render();
        });
        return card;
      })
    );
    status.textContent = `${items.length} page${items.length === 1 ? "" : "s"}${selected.size ? ` · ${selected.size} selected` : ""}`;
  }
  void afterSel;
}
