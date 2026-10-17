import { h, download, baseName, bytesToBase64, fmtSize } from "../lib/util.js";
import { dropzone, iconEl, toast, modal } from "../lib/ui.js";
import { loadPdfFile } from "../lib/pdf.js";
import { PageEditor } from "../lib/editor.js";
import { applyEditsWithFonts as applyEdits } from "../lib/fonts.js";
import { getSignature } from "../lib/signaturePad.js";
import { toolButton, historyButtons, zoomControls, pageIndicator, propertiesPanel } from "../lib/workspace.js";

/** Add signature/initials/date/text/check controls shared by self-signing and the signer page. */
export function signToolbarButtons(editor) {
  const placeSignature = async (kind) => {
    const sig = await getSignature(kind);
    if (!sig) return;
    const asset = editor.addAsset(sig.bytes, sig.mime);
    const width = kind === "initial" ? 70 : 150;
    editor.pendingImage = { asset, w: width, h: (width / sig.w) * sig.h };
    editor.setTool("image");
    toast("Click on the page where it should go.");
  };
  const stampDate = () => {
    const i = editor.currentPage();
    const s = editor.style;
    const text = new Date().toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    editor.addObject(i, { type: "text", x: 60, y: 60, w: 110, h: 18, text, font: s.font, bold: false, italic: false, size: 12, color: "#111111", align: "left" });
  };
  const check = () => {
    const i = editor.currentPage();
    editor.addObject(i, { type: "ink", points: [[60, 80], [68, 92], [86, 64]], color: "#111111", width: 3 });
  };
  return [
    h("button.tbtn", { onclick: () => placeSignature("signature") }, iconEl("sign", 18), h("span", {}, "Signature")),
    h("button.tbtn", { onclick: () => placeSignature("initial") }, iconEl("text", 18), h("span", {}, "Initials")),
    h("button.tbtn", { onclick: stampDate }, iconEl("plus", 18), h("span", {}, "Date")),
    toolButton(editor, { tool: "text", icon: "text", label: "Text" }),
    h("button.tbtn", { onclick: check, title: "Add a check mark" }, "✓", h("span", {}, "Check")),
  ];
}

const api = async (path, opts) => {
  let res;
  try {
    res = await fetch(path, opts);
  } catch {
    throw new Error("Can't reach the PDF Studio server. Start it with “npm start” to use signature requests.");
  }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Server error ${res.status}`);
  return res;
};

/** True only when the PDF Studio server is really there (a static host may answer /api/* with index.html). */
async function hasServer() {
  try {
    const res = await fetch("/api/health", { cache: "no-store" });
    return res.ok && (await res.json()).ok === true;
  } catch {
    return false;
  }
}

export async function mount(root) {
  let cleanup = null;
  const allTabs = [["self", "Sign it yourself"], ["request", "Request signatures"], ["sent", "Sent requests"]];
  let tabs = [allTabs[0]]; // signature requests need the Node server; offered only when it answers (see below)
  const body = h("div");
  const tabBar = h("div.tabs-inline", { role: "tablist" });
  const header = h("div", {}, h("h1", {}, "Sign documents"), h("p.sub", {}, "Add your signature, initials, the date or text — or send a document to someone else to sign."));
  const wrap = h("div.tool-page", {}, header, tabBar, body);
  root.append(wrap);

  let active = "self";
  const renderTabBar = (id) => tabBar.replaceChildren(...tabs.map(([t, l]) => h("button" + (t === id ? ".active" : ""), { role: "tab", "aria-selected": String(t === id), onclick: () => show(t) }, l)));
  function show(id) {
    active = id;
    cleanup?.();
    cleanup = null;
    renderTabBar(id);
    body.replaceChildren();
    const full = id === "self" || id === "request";
    wrap.className = "tool-page";
    cleanup = ({ self, request, sent })[id](body) || null;
    void full;
  }
  show("self");
  // Static hosting (e.g. Cloudflare Pages) has no API: only offer the server-backed tabs when /api/health answers.
  hasServer().then((ok) => { if (ok) { tabs = allTabs; renderTabBar(active); } });
  return () => cleanup?.();

  // ---- sign it yourself ----
  function self(box) {
    let editor = null;
    const picker = dropzone({ accept: "application/pdf,.pdf", label: "Drop a PDF to sign or click to browse", onFiles: ([f]) => open(f) });
    box.append(picker);
    async function open(file) {
      let loaded;
      try { loaded = await loadPdfFile(file); } catch (e) { if (e.message !== "Password entry cancelled") toast(e.message, "error", 6000); return; }
      const { bytes, doc, name } = loaded;
      const scroll = h("div#editor-scroll");
      editor = new PageEditor({ container: scroll, doc });
      const toolbar = h("div.toolbar", {},
        h("button.tbtn", { onclick: () => { editor.destroy(); box.replaceChildren(picker); wrap.className = "tool-page"; header.style.display = ""; tabBar.style.display = ""; } }, "← Open another"),
        h("span.sep"), toolButton(editor, { tool: "select", icon: "cursor", label: "Select" }), ...signToolbarButtons(editor),
        h("span.sep"), ...historyButtons(editor), h("span.sep"), ...zoomControls(editor), pageIndicator(editor), h("span", { style: { flex: 1 } }),
        h("button.btn.primary", { onclick: save }, iconEl("down", 18), "Download signed PDF"));
      header.style.display = "none"; tabBar.style.display = "none";
      wrap.className = "";
      box.replaceChildren(h("div.workspace", {}, toolbar, scroll, h("aside.side", {}, propertiesPanel(editor))));
      await editor.init();
      editor.fitWidth();
      async function save() {
        if (!editor.hasEdits) return toast("Add a signature or text first.");
        try {
          const { editsByPage, assets, fontData } = editor.exportEdits();
          download(await applyEdits(bytes, editsByPage, assets, fontData), `${baseName(name)}-signed.pdf`, "application/pdf");
          toast("Signed PDF saved.", "success");
        } catch (e) { toast(`Could not save: ${e.message}`, "error", 6000); }
      }
    }
    return () => { editor?.destroy(); header.style.display = ""; tabBar.style.display = ""; };
  }

  // ---- request signatures ----
  function request(box) {
    let editor = null;
    const picker = dropzone({ accept: "application/pdf,.pdf", label: "Drop the PDF that needs signing, or click to browse", onFiles: ([f]) => open(f) });
    box.append(picker, h("p.hint", { style: { marginTop: "12px" } }, "You'll get a private signing link to send to the signer. Their signed copy appears under “Sent requests”. Links work for people who can reach this server (see README to share beyond this computer)."));
    async function open(file) {
      let loaded;
      try { loaded = await loadPdfFile(file); } catch (e) { if (e.message !== "Password entry cancelled") toast(e.message, "error", 6000); return; }
      const { bytes, doc, name } = loaded;
      const scroll = h("div#editor-scroll");
      editor = new PageEditor({ container: scroll, doc });
      const signer = h("input.text-input", { placeholder: "Signer name", "aria-label": "Signer name" });
      const email = h("input.text-input", { type: "email", placeholder: "Signer email (optional)", "aria-label": "Signer email" });
      const msg = h("textarea.text-input", { rows: 3, placeholder: "Message to the signer (optional)", "aria-label": "Message" });
      const count = h("div.hint");
      const upd = () => { const n = editor.objects.filter((o) => o.type === "field").length; count.textContent = n ? `${n} signature field${n === 1 ? "" : "s"} placed` : "No fields placed — the signer can sign anywhere."; };
      editor.on("change", upd);
      const create = h("button.btn.primary", { onclick: send }, iconEl("sign", 18), "Create signing link");
      async function send() {
        if (!signer.value.trim()) return toast("Enter the signer's name.", "error");
        create.disabled = true;
        try {
          const fields = editor.objects.filter((o) => o.type === "field").map((o) => ({ page: o.page, x: o.x, y: o.y, w: o.w, h: o.h, label: o.label }));
          const res = await api("/api/requests", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, signerName: signer.value.trim(), signerEmail: email.value.trim(), message: msg.value, fields, pdfBase64: bytesToBase64(bytes) }) });
          const { token } = await res.json();
          const link = `${location.origin}/#/s/${token}`;
          const mail = `mailto:${encodeURIComponent(email.value.trim())}?subject=${encodeURIComponent(`Please sign: ${name}`)}&body=${encodeURIComponent(`${msg.value ? msg.value + "\n\n" : ""}Sign here: ${link}`)}`;
          modal({ title: "Signing link ready", wide: true, body: h("div.col", {}, h("p", {}, `Send this link to ${signer.value.trim()}. Anyone with the link can sign this document.`), h("div.link-box", { "data-testid": "sign-link" }, link), h("div.row", {}, h("button.btn.primary", { onclick: () => navigator.clipboard?.writeText(link).then(() => toast("Link copied.", "success")) }, iconEl("copy", 16), "Copy link"), email.value.trim() && h("a.btn", { href: mail }, "Open email draft"))), actions: [{ label: "Done", value: true, primary: true }] }).then(() => show("sent"));
        } catch (e) { toast(e.message, "error", 8000); } finally { create.disabled = false; }
      }
      const toolbar = h("div.toolbar", {},
        h("button.tbtn", { onclick: () => { editor.destroy(); box.replaceChildren(picker); wrap.className = "tool-page"; header.style.display = ""; tabBar.style.display = ""; } }, "← Open another"),
        h("span.sep"), toolButton(editor, { tool: "select", icon: "cursor", label: "Select" }), toolButton(editor, { tool: "field", icon: "sign", label: "Place signature field" }),
        h("span.sep"), ...historyButtons(editor), h("span.sep"), ...zoomControls(editor), pageIndicator(editor));
      const side = h("aside.side", {}, h("h3", {}, "Signer"), signer, email, msg, h("h3", {}, "Fields"), count, h("p.hint", {}, "Draw boxes where the signer should sign."), create);
      header.style.display = "none"; tabBar.style.display = "none";
      wrap.className = "";
      box.replaceChildren(h("div.workspace", {}, toolbar, scroll, side));
      await editor.init();
      editor.fitWidth();
      editor.setTool("field");
      upd();
    }
    return () => { editor?.destroy(); header.style.display = ""; tabBar.style.display = ""; };
  }

  // ---- sent requests ----
  function sent(box) {
    const table = h("div", {}, h("div.hint", {}, "Loading…"));
    box.append(table);
    load();
    async function load() {
      try {
        const { requests } = await (await api("/api/requests")).json();
        if (!requests.length) { table.replaceChildren(h("div.panel", {}, "No signature requests yet.")); return; }
        table.replaceChildren(h("div.panel", {}, h("table.simple", {}, h("thead", {}, h("tr", {}, ["Document", "Signer", "Sent", "Status", ""].map((x) => h("th", {}, x)))),
          h("tbody", {}, requests.map((r) => h("tr", { "data-testid": "request-row" },
            h("td", {}, h("strong", {}, r.name), h("div.hint", {}, fmtSize(r.size || 0))),
            h("td", {}, r.signerName, r.signerEmail && h("div.hint", {}, r.signerEmail)),
            h("td", {}, new Date(r.createdAt).toLocaleString()),
            h("td", {}, h("span.badge" + (r.status === "signed" ? ".ok" : ""), {}, r.status === "signed" ? "Signed" : "Waiting")),
            h("td", {}, h("div.row", {},
              r.status === "signed" ? h("a.btn.sm.primary", { href: `/api/requests/${r.id}/file?kind=signed`, download: `${baseName(r.name)}-signed.pdf` }, "Download signed") : h("button.btn.sm", { onclick: () => navigator.clipboard?.writeText(`${location.origin}/#/s/${r.token}`).then(() => toast("Link copied.", "success")) }, "Copy link"),
              h("button.btn.sm.danger", { onclick: async () => { if (confirm("Delete this request and its files?")) { await api(`/api/requests/${r.id}`, { method: "DELETE" }); load(); } } }, "Delete"))))))))); 
      } catch (e) {
        table.replaceChildren(h("div.error-box", {}, e.message));
      }
    }
  }
}
