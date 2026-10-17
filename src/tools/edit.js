import { h, download, baseName, imageFileToEmbeddable } from "../lib/util.js";
import { dropzone, iconEl, toast, progressBar } from "../lib/ui.js";
import { loadPdfFile } from "../lib/pdf.js";
import { PageEditor } from "../lib/editor.js";
import { applyEditsWithFonts as applyEdits } from "../lib/fonts.js";
import { toolButton, historyButtons, zoomControls, pageIndicator, propertiesPanel } from "../lib/workspace.js";

export async function mount(root) {
  let editor = null;
  const showPicker = () => {
    root.replaceChildren(
      h("div.tool-page", {},
        h("h1", {}, "Edit PDFs"),
        h("p.sub", {}, "Click any text in your PDF to edit it in place — it keeps the original size, spacing and colour and picks the closest font. You can also add text, images and shapes. Everything happens in your browser."),
        dropzone({ accept: "application/pdf,.pdf", label: "Drop a PDF here or click to browse", onFiles: ([f]) => open(f) }))
    );
  };

  async function open(file) {
    try {
      const { bytes, doc, name } = await loadPdfFile(file);
      editor?.destroy();
      const scroll = h("div#editor-scroll");
      editor = new PageEditor({ container: scroll, doc });
      scroll.__editor = editor; // handy for tests and debugging
      const side = h("aside.side", {}, propertiesPanel(editor));
      const fileInput = h("input", { type: "file", accept: "image/*", hidden: true });
      fileInput.addEventListener("change", async () => {
        const f = fileInput.files[0];
        fileInput.value = "";
        if (!f) return;
        const { bytes: ib, mime } = await imageFileToEmbeddable(f);
        const bmp = await createImageBitmap(new Blob([ib], { type: mime }));
        const asset = editor.addAsset(ib, mime);
        editor.pendingImage = { asset, w: bmp.width * 0.75, h: bmp.height * 0.75 };
        editor.setTool("image");
        toast("Click on the page where the image should go.");
      });
      const saveBtn = h("button.btn.primary", { onclick: save }, iconEl("down", 18), "Download PDF");
      const toolbar = h("div.toolbar", {},
        h("button.tbtn", { onclick: () => { if (!editor.hasEdits || confirm("Discard changes and open another file?")) { editor.destroy(); showPicker(); } } }, "← Open another"),
        h("span.sep"),
        toolButton(editor, { tool: "select", icon: "cursor", label: "Select" }),
        toolButton(editor, { tool: "edit-text", icon: "edit", label: "Edit text", title: "Click existing text to change it" }),
        toolButton(editor, { tool: "text", icon: "text", label: "Add text" }),
        h("button.tbtn", { title: "Add an image", onclick: () => fileInput.click() }, iconEl("image", 18), h("span", {}, "Image")),
        toolButton(editor, { tool: "draw", icon: "pen", label: "Draw" }),
        toolButton(editor, { tool: "rect", icon: "rect", label: "Shape" }),
        toolButton(editor, { tool: "highlight", icon: "highlight", label: "Highlight" }),
        toolButton(editor, { tool: "whiteout", icon: "eraser", label: "Whiteout", title: "Cover text or images with a white box" }),
        h("span.sep"), ...historyButtons(editor), h("span.sep"), ...zoomControls(editor), pageIndicator(editor),
        h("span", { style: { flex: 1 } }), fileInput, saveBtn);
      const note = doc.numPages > 0 ? null : null;
      root.replaceChildren(h("div.workspace", {}, toolbar, scroll, side));
      await editor.init();
      editor.fitWidth();
      editor.setTool("edit-text");
      scroll.setAttribute("aria-label", `${name} pages`);
      editor.name = name;
      editor.bytes = bytes;
      void note;
    } catch (e) {
      if (e.message !== "Password entry cancelled") toast(e.message || "Could not open PDF", "error", 6000);
    }
  }

  async function save() {
    if (!editor.hasEdits) return toast("No changes to save yet.");
    try {
      const { editsByPage, assets, fontData } = editor.exportEdits();
      const out = await applyEdits(editor.bytes, editsByPage, assets, fontData);
      download(out, `${baseName(editor.name)}-edited.pdf`, "application/pdf");
      toast("Saved edited PDF.", "success");
    } catch (e) {
      console.error(e);
      toast(`Could not save: ${e.message}`, "error", 6000);
    }
  }

  void progressBar;
  showPicker();
  return () => editor?.destroy();
}
