// Public page opened by the person asked to sign: #/s/<token>
import { h, base64ToBytes, bytesToBase64 } from "../lib/util.js";
import { iconEl, toast } from "../lib/ui.js";
import { openDoc } from "../lib/pdf.js";
import { PageEditor } from "../lib/editor.js";
import { applyEditsWithFonts as applyEdits } from "../lib/fonts.js";
import { getSignature } from "../lib/signaturePad.js";
import { toolButton, historyButtons, zoomControls, pageIndicator, propertiesPanel } from "../lib/workspace.js";
import { signToolbarButtons } from "./sign.js";

export async function mount(app, token) {
  document.title = "Sign document · PDF Studio";
  app.replaceChildren(h("div.loading", {}, "Loading document…"));
  let info;
  try {
    const res = await fetch(`/api/sign/${encodeURIComponent(token)}`);
    if (!res.ok) throw new Error(res.status === 404 ? "This signing link is invalid or has been removed." : "Could not load the document.");
    info = await res.json();
  } catch (e) {
    app.replaceChildren(h("div.error-box", {}, e.message));
    return;
  }
  if (info.status === "signed") {
    app.replaceChildren(h("div.tool-page", {}, h("h1", {}, "Already signed"), h("p.sub", {}, `“${info.name}” has already been signed. Thank you!`)));
    return;
  }
  const bytes = base64ToBytes(info.pdfBase64);
  const doc = await openDoc(bytes);
  const scroll = h("div#editor-scroll");
  const editor = new PageEditor({ container: scroll, doc });
  const status = h("span.hint");

  // Clicking a placed "Sign here" field opens the signature dialog and fills it.
  editor.on("select", async (o) => {
    if (!o || o.type !== "field") return;
    const fieldId = o.id;
    editor.select(null);
    const sig = await getSignature("signature");
    if (!sig) return;
    const asset = editor.addAsset(sig.bytes, sig.mime);
    const scale = Math.min(o.w / sig.w, o.h / sig.h);
    const w = sig.w * scale, hh = sig.h * scale;
    editor.addObject(o.page, { type: "image", asset, x: o.x + (o.w - w) / 2, y: o.y + (o.h - hh) / 2, w, h: hh }, { select: false, commit: false });
    editor.removeObject(fieldId);
    updateStatus();
  });
  const remaining = () => editor.objects.filter((x) => x.type === "field").length;
  const updateStatus = () => { const n = remaining(); status.textContent = n ? `${n} field${n === 1 ? "" : "s"} still to sign — click a blue box` : "Ready to submit"; };
  editor.on("change", updateStatus);

  const submit = h("button.btn.primary", { onclick: send }, iconEl("sign", 18), "Finish & submit");
  async function send() {
    if (remaining()) return toast("Please sign all highlighted fields first.", "error");
    if (!editor.hasEdits) return toast("Add your signature first.", "error");
    submit.disabled = true;
    try {
      const { editsByPage, assets, fontData } = editor.exportEdits();
      const out = await applyEdits(bytes, editsByPage, assets, fontData);
      const res = await fetch(`/api/sign/${encodeURIComponent(token)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ signedPdfBase64: bytesToBase64(out) }) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Submit failed");
      app.replaceChildren(h("div.tool-page", {}, h("h1", {}, "Signed — thank you!"), h("p.sub", {}, "Your signed copy has been sent back to the requester."), h("p", {}, h("button.btn", { onclick: () => { const u = URL.createObjectURL(new Blob([out], { type: "application/pdf" })); const a = h("a", { href: u, download: "signed.pdf" }); a.click(); } }, "Download a copy"))));
      editor.destroy();
    } catch (e) {
      toast(e.message, "error", 8000);
      submit.disabled = false;
    }
  }

  const bar = h("div.signer-bar", {}, h("strong", {}, info.name), h("span.hint", {}, `Requested for ${info.signerName}`), info.message && h("span.hint", {}, `“${info.message}”`));
  const toolbar = h("div.toolbar", {}, toolButton(editor, { tool: "select", icon: "cursor", label: "Select" }), ...signToolbarButtons(editor), h("span.sep"), ...historyButtons(editor), h("span.sep"), ...zoomControls(editor), pageIndicator(editor), h("span", { style: { flex: 1 } }), status, submit);
  app.replaceChildren(bar, h("div.workspace", { style: { height: "calc(100vh - 49px)" } }, toolbar, scroll, h("aside.side", {}, propertiesPanel(editor))));
  await editor.init();
  editor.fitWidth();
  for (const f of info.fields || []) editor.addObject(f.page, { type: "field", x: f.x, y: f.y, w: f.w, h: f.h, label: f.label || "Sign here" }, { select: false, commit: false });
  editor.pushHistory(true);
  updateStatus();
  return () => editor.destroy();
}
