import { h, download, baseName, zipFiles, fmtSize } from "../lib/util.js";
import { dropzone, iconEl, toast } from "../lib/ui.js";
import { loadPdfFile, pageCanvas } from "../lib/pdf.js";
import { parseRanges, chunkIndices, splitGroups } from "../lib/ops.js";

export async function mount(root) {
  const page = h("div.tool-page", {}, h("h1", {}, "Split PDFs"), h("p.sub", {}, "Divide one large PDF into smaller files by page ranges, fixed-size chunks, or one file per page."));
  root.append(page);
  const zone = dropzone({ accept: "application/pdf,.pdf", label: "Drop a PDF here or click to browse", onFiles: ([f]) => open(f) });
  page.append(zone);

  async function open(file) {
    let loaded;
    try {
      loaded = await loadPdfFile(file);
    } catch (e) {
      if (e.message !== "Password entry cancelled") toast(e.message, "error", 6000);
      return;
    }
    const { bytes, doc, name } = loaded;
    const total = doc.numPages;
    const thumb = (await pageCanvas(doc, 1, 0.3)).toDataURL("image/jpeg", 0.7);
    let mode = "ranges";
    const rangesInput = h("input.text-input", { value: total > 1 ? `1-${Math.ceil(total / 2)}, ${Math.ceil(total / 2) + 1}-${total}` : "1", "aria-label": "Page ranges", oninput: refresh });
    const nInput = h("input.num-input", { type: "number", min: 1, max: total, value: Math.min(total, 5), "aria-label": "Pages per file", style: { width: "90px" }, oninput: refresh });
    const preview = h("div.hint");
    const btn = h("button.btn.primary", { onclick: run }, iconEl("split", 18), "Split PDF");

    const radio = (value, label, extra) => h("label.check", {}, h("input", { type: "radio", name: "mode", value, checked: value === mode, onchange: () => { mode = value; refresh(); } }), label, extra);

    function groups() {
      if (mode === "ranges") return parseRanges(rangesInput.value, total);
      if (mode === "every") return chunkIndices(total, Math.max(1, Math.min(total, +nInput.value || 1)));
      return chunkIndices(total, 1);
    }
    const label = (g) => (g.length === 1 ? `page ${g[0] + 1}` : `pages ${g[0] + 1}–${g[g.length - 1] + 1}`);
    function refresh() {
      try {
        const g = groups();
        preview.textContent = `Will create ${g.length} file${g.length === 1 ? "" : "s"}: ${g.slice(0, 6).map(label).join(", ")}${g.length > 6 ? ", …" : ""}`;
        preview.style.color = "";
        btn.disabled = false;
      } catch (e) {
        preview.textContent = e.message;
        preview.style.color = "var(--danger)";
        btn.disabled = true;
      }
    }
    async function run() {
      try {
        const g = groups();
        btn.disabled = true;
        const parts = await splitGroups(bytes, g);
        const base = baseName(name);
        const files = parts.map((p, i) => ({ name: `${base}-${String(i + 1).padStart(String(parts.length).length, "0")}_${label(p.indices).replace(/[– ]/g, "-")}.pdf`, bytes: p.bytes }));
        if (files.length === 1) download(files[0].bytes, files[0].name, "application/pdf");
        else download(await zipFiles(files), `${base}-split.zip`, "application/zip");
        toast(`Created ${files.length} file${files.length === 1 ? "" : "s"} (${fmtSize(files.reduce((n, f) => n + f.bytes.length, 0))}).`, "success");
      } catch (e) {
        toast(e.message, "error", 6000);
      } finally {
        btn.disabled = false;
      }
    }

    zone.replaceWith(
      h("div.panel", {},
        h("div.row", {}, h("img.thumb", { src: thumb, alt: "", style: { height: "64px", border: "1px solid var(--line)", borderRadius: "4px", background: "#fff" } }), h("div", {}, h("strong", {}, name), h("div.hint", {}, `${total} page${total === 1 ? "" : "s"} · ${fmtSize(bytes.length)}`))),
        h("div", { style: { height: "14px" } }),
        h("div.col", {},
          radio("ranges", "Custom ranges", null),
          h("div", { style: { marginLeft: "24px" } }, rangesInput, h("div.hint", { style: { marginTop: "4px" } }, "Each comma-separated range becomes its own file, e.g. 1-3, 5, 8-")),
          radio("every", "Every N pages", nInput),
          radio("single", "One file per page", null)),
        h("div", { style: { height: "12px" } }), preview, h("div", { style: { height: "12px" } }),
        h("div.row", {}, btn, h("button.btn", { onclick: () => location.reload() }, "Choose another file")))
    );
    refresh();
  }
}
