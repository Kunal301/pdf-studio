import { h, download, fmtSize } from "../lib/util.js";
import { dropzone, iconEl, toast, progressBar } from "../lib/ui.js";
import { loadPdfFile, pageCanvas } from "../lib/pdf.js";
import { mergePdfs } from "../lib/ops.js";

export async function mount(root) {
  /** @type {{id:number,name:string,bytes:Uint8Array,pages:number,thumb:string}[]} */
  let items = [];
  let nextId = 1;
  let dragId = null;
  const listEl = h("div.file-list");
  const mergeBtn = h("button.btn.primary", { onclick: merge }, iconEl("merge", 18), "Merge PDFs");
  const summary = h("span.hint");
  const nameInput = h("input.text-input", { value: "merged.pdf", "aria-label": "Output file name", style: { maxWidth: "260px" } });

  async function add(files) {
    for (const f of files) {
      try {
        const { bytes, doc, name } = await loadPdfFile(f);
        const canvas = await pageCanvas(doc, 1, 0.25);
        items.push({ id: nextId++, name, bytes, pages: doc.numPages, thumb: canvas.toDataURL("image/jpeg", 0.7) });
        render();
      } catch (e) {
        if (e.message !== "Password entry cancelled") toast(`${f.name}: ${e.message}`, "error", 6000);
      }
    }
  }

  function move(id, delta) {
    const i = items.findIndex((x) => x.id === id);
    const j = i + delta;
    if (j < 0 || j >= items.length) return;
    [items[i], items[j]] = [items[j], items[i]];
    render();
  }

  function render() {
    listEl.replaceChildren(
      ...items.map((it, i) => {
        const row = h("div.file-row", { draggable: true, "data-id": it.id },
          h("span.drag-handle", { title: "Drag to reorder" }, "⋮⋮"),
          h("img.thumb", { src: it.thumb, alt: "" }),
          h("div.grow", {}, h("div.name", {}, it.name), h("div.meta", {}, `${it.pages} page${it.pages === 1 ? "" : "s"} · ${fmtSize(it.bytes.length)}`)),
          h("button.iconbtn", { title: "Move up", "aria-label": `Move ${it.name} up`, disabled: i === 0, onclick: () => move(it.id, -1) }, "↑"),
          h("button.iconbtn", { title: "Move down", "aria-label": `Move ${it.name} down`, disabled: i === items.length - 1, onclick: () => move(it.id, 1) }, "↓"),
          h("button.iconbtn.danger", { title: "Remove", "aria-label": `Remove ${it.name}`, onclick: () => { items = items.filter((x) => x.id !== it.id); render(); } }, "✕"));
        row.addEventListener("dragstart", () => { dragId = it.id; row.classList.add("dragging"); });
        row.addEventListener("dragend", () => { dragId = null; row.classList.remove("dragging"); });
        row.addEventListener("dragover", (e) => e.preventDefault());
        row.addEventListener("drop", (e) => {
          e.preventDefault();
          if (dragId == null || dragId === it.id) return;
          const from = items.findIndex((x) => x.id === dragId);
          const [m] = items.splice(from, 1);
          items.splice(items.findIndex((x) => x.id === it.id), 0, m);
          render();
        });
        return row;
      })
    );
    const total = items.reduce((n, x) => n + x.pages, 0);
    summary.textContent = items.length ? `${items.length} files · ${total} pages total` : "";
    mergeBtn.disabled = items.length < 2;
  }

  async function merge() {
    const prog = progressBar();
    mergeBtn.disabled = true;
    result.replaceChildren(prog.el);
    prog.set(0.3, "Merging…");
    try {
      const out = await mergePdfs(items.map((x) => x.bytes));
      prog.set(1, "Done");
      const fname = (nameInput.value.trim() || "merged.pdf").replace(/(?<!\.pdf)$/i, ".pdf");
      result.replaceChildren(h("div.result-box", {}, h("strong", {}, `Merged ${items.length} files into ${fmtSize(out.length)}.`), h("button.btn.primary", { onclick: () => download(out, fname, "application/pdf") }, iconEl("down", 18), "Download again")));
      download(out, fname, "application/pdf");
    } catch (e) {
      result.replaceChildren();
      toast(`Merge failed: ${e.message}`, "error", 6000);
    } finally {
      mergeBtn.disabled = items.length < 2;
    }
  }

  const result = h("div");
  root.append(
    h("div.tool-page", {},
      h("h1", {}, "Merge PDFs"),
      h("p.sub", {}, "Combine multiple PDFs into one document. Drag files (or use the arrows) to set the order."),
      dropzone({ accept: "application/pdf,.pdf", multiple: true, label: "Drop PDFs here or click to add files", onFiles: add }),
      h("div", { style: { height: "16px" } }),
      listEl,
      h("div", { style: { height: "16px" } }),
      h("div.row", {}, h("label.field", {}, h("span", {}, "Output name"), nameInput), summary, h("span", { style: { flex: 1 } }), mergeBtn),
      h("div", { style: { height: "12px" } }),
      result)
  );
  render();
}
