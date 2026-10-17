import { h, download, baseName, readBytes } from "../lib/util.js";
import { dropzone, iconEl, toast, modal } from "../lib/ui.js";
import { loadPdfFile } from "../lib/pdf.js";
import { PageEditor } from "../lib/editor.js";
import { encryptPdf, decryptPdf } from "../lib/qpdf.js";
import { applyRedactions, findTextBoxes, PATTERNS } from "../lib/redact.js";
import { toolButton, historyButtons, zoomControls, pageIndicator } from "../lib/workspace.js";

export async function mount(root) {
  let cleanup = null;
  const tabs = [["password", "Add password"], ["unlock", "Remove password"], ["redact", "Redact"]];
  const body = h("div");
  const tabBar = h("div.tabs-inline", { role: "tablist" });
  let active = (location.hash.split("/")[2]) || "password";
  if (!tabs.some((t) => t[0] === active)) active = "password";

  function show(id) {
    cleanup?.();
    cleanup = null;
    active = id;
    tabBar.replaceChildren(...tabs.map(([t, l]) => h("button" + (t === id ? ".active" : ""), { role: "tab", "aria-selected": String(t === id), onclick: () => show(t) }, l)));
    wrap.className = id === "redact" ? "" : "tool-page";
    header.style.display = id === "redact" ? "none" : "";
    body.replaceChildren();
    cleanup = ({ password, unlock, redact })[id](body) || null;
  }

  const header = h("div", {}, h("h1", {}, "Protect PDFs"), h("p.sub", {}, "Add a password and restrict permissions (AES-256), remove a password you know, or permanently redact sensitive information."));
  const wrap = h("div.tool-page", {}, header, tabBar, body);
  root.append(wrap);
  // tabs must also show above the redact workspace
  show(active);
  return () => cleanup?.();

  // ---------------- password ----------------
  function password(box) {
    let file = null;
    const pw1 = h("input.text-input", { type: "password", autocomplete: "new-password", "aria-label": "Password" });
    const pw2 = h("input.text-input", { type: "password", autocomplete: "new-password", "aria-label": "Confirm password" });
    const owner = h("input.text-input", { type: "password", autocomplete: "new-password", placeholder: "Optional — defaults to a random value", "aria-label": "Permissions password" });
    const print = h("select", { "aria-label": "Printing" }, [["full", "Allowed"], ["low", "Low resolution only"], ["none", "Not allowed"]].map(([v, l]) => h("option", { value: v }, l)));
    const modify = h("select", { "aria-label": "Editing" }, [["all", "Allowed"], ["annotate", "Comments and forms only"], ["assembly", "Page assembly only"], ["none", "Not allowed"]].map(([v, l]) => h("option", { value: v }, l)));
    const extract = h("input", { type: "checkbox", checked: true });
    const info = h("div.hint", {}, "No file selected");
    const btn = h("button.btn.primary", { type: "button", disabled: true, onclick: run }, iconEl("lock", 18), "Protect & download");
    const zone = dropzone({ accept: "application/pdf,.pdf", label: "Drop a PDF here or click to browse", onFiles: async ([f]) => { file = { name: f.name, bytes: await readBytes(f) }; info.textContent = `${f.name}`; btn.disabled = false; } });

    async function run() {
      if (!pw1.value) return toast("Enter a password first.", "error");
      if (pw1.value !== pw2.value) return toast("The passwords do not match.", "error");
      btn.disabled = true;
      try {
        let bytes = file.bytes;
        const out = await encryptPdf(bytes, { userPassword: pw1.value, ownerPassword: owner.value || undefined, permissions: { print: print.value, modify: modify.value, extract: extract.checked } });
        download(out, `${baseName(file.name)}-protected.pdf`, "application/pdf");
        toast("Protected PDF saved. Keep the password safe — it cannot be recovered.", "success", 7000);
      } catch (e) {
        console.error(e);
        toast(/password/i.test(e.message) ? "This PDF is already encrypted. Remove its password first." : `Could not protect the PDF: ${e.message}`, "error", 8000);
      } finally {
        btn.disabled = false;
      }
    }
    box.append(zone, h("div", { style: { height: "12px" } }), info, h("div", { style: { height: "12px" } }),
      h("form.panel", { onsubmit: (e) => { e.preventDefault(); run(); } },
        h("div.row", {}, h("label.field", { style: { flex: 1, minWidth: "200px" } }, h("span", {}, "Password to open"), pw1), h("label.field", { style: { flex: 1, minWidth: "200px" } }, h("span", {}, "Confirm password"), pw2)),
        h("div", { style: { height: "14px" } }),
        h("h3", {}, "Permissions"),
        h("div.row", {}, h("label.field", {}, h("span", {}, "Printing"), print), h("label.field", {}, h("span", {}, "Editing"), modify), h("label.check", { style: { alignSelf: "flex-end", paddingBottom: "8px" } }, extract, "Allow copying text")),
        h("div", { style: { height: "10px" } }),
        h("label.field", {}, h("span", {}, "Permissions password (optional)"), owner),
        h("p.hint", {}, "Encrypted with AES-256. Viewers enforce the permission limits; the open-password is what truly protects the content."),
        btn));
  }

  // ---------------- unlock ----------------
  function unlock(box) {
    let file = null;
    const pw = h("input.text-input", { type: "password", placeholder: "Leave empty if the file only has permission limits", "aria-label": "Password" });
    const info = h("div.hint", {}, "No file selected");
    const btn = h("button.btn.primary", { type: "button", disabled: true, onclick: run }, iconEl("lock", 18), "Remove protection & download");
    const zone = dropzone({ accept: "application/pdf,.pdf", label: "Drop a protected PDF here or click to browse", onFiles: async ([f]) => { file = { name: f.name, bytes: await readBytes(f) }; info.textContent = f.name; btn.disabled = false; } });
    async function run() {
      btn.disabled = true;
      try {
        const out = await decryptPdf(file.bytes, pw.value);
        download(out, `${baseName(file.name)}-unlocked.pdf`, "application/pdf");
        toast("Unlocked PDF saved.", "success");
      } catch (e) {
        toast(e.wrongPassword || /password/i.test(e.message) ? "That password is incorrect." : `Could not unlock: ${e.message}`, "error", 6000);
      } finally { btn.disabled = false; }
    }
    box.append(zone, h("div", { style: { height: "12px" } }), info, h("div", { style: { height: "12px" } }),
      h("form.panel", { onsubmit: (e) => { e.preventDefault(); run(); } }, h("label.field", {}, h("span", {}, "Password"), pw), h("p.hint", {}, "You must know the password. This tool cannot recover or bypass unknown passwords."), btn));
  }

  // ---------------- redact ----------------
  function redact(box) {
    let editor = null;
    const picker = dropzone({ accept: "application/pdf,.pdf", label: "Drop a PDF to redact or click to browse", onFiles: ([f]) => open(f) });
    box.append(picker);
    async function open(file) {
      let loaded;
      try { loaded = await loadPdfFile(file); } catch (e) { if (e.message !== "Password entry cancelled") toast(e.message, "error", 6000); return; }
      const { bytes, doc, name } = loaded;
      const scroll = h("div#editor-scroll");
      editor = new PageEditor({ container: scroll, doc });
      const query = h("input.text-input", { placeholder: "Text to find…", "aria-label": "Text to redact" });
      const checks = Object.fromEntries(Object.entries(PATTERNS).map(([k, p]) => [k, h("input", { type: "checkbox" })]));
      const count = h("div.hint");
      const strip = h("input", { type: "checkbox", checked: true });
      const updateCount = () => { const n = editor.objects.filter((o) => o.type === "redact").length; count.textContent = n ? `${n} area${n === 1 ? "" : "s"} marked for redaction` : "Nothing marked yet"; };
      editor.on("change", updateCount);
      const find = async () => {
        const patterns = Object.entries(checks).filter(([, c]) => c.checked).map(([k]) => k);
        if (!query.value && !patterns.length) return toast("Enter text or tick a pattern.");
        const hits = await findTextBoxes(doc, { query: query.value, patterns });
        hits.forEach((x) => editor.addObject(x.page, { type: "redact", x: x.x, y: x.y, w: x.w, h: x.h }, { select: false, commit: false }));
        editor.pushHistory();
        toast(hits.length ? `Marked ${hits.length} match${hits.length === 1 ? "" : "es"}. Review them, then apply.` : "No matches found.", hits.length ? "success" : "info");
      };
      const apply = async () => {
        const marks = editor.objects.filter((o) => o.type === "redact");
        if (!marks.length) return toast("Mark at least one area first.");
        const ok = await modal({ title: "Permanently redact?", body: h("p", {}, `This removes the content under ${marks.length} marked area${marks.length === 1 ? "" : "s"}. Affected pages are converted to images, so their text is no longer selectable or searchable. This cannot be undone in the saved file.`), actions: [{ label: "Cancel", value: false }, { label: "Redact & download", value: true, primary: true }] });
        if (!ok) return;
        try {
          const byPage = {};
          for (const m of marks) (byPage[m.page] ||= []).push({ x: m.x, y: m.y, w: m.w, h: m.h });
          const out = await applyRedactions(bytes, doc, byPage, { stripMeta: strip.checked });
          download(out, `${baseName(name)}-redacted.pdf`, "application/pdf");
          toast("Redacted PDF saved.", "success");
        } catch (e) { console.error(e); toast(`Redaction failed: ${e.message}`, "error", 8000); }
      };
      const side = h("aside.side", {},
        h("h3", {}, "Find & mark"), query,
        h("div.col", {}, Object.entries(PATTERNS).map(([k, p]) => h("label.check", {}, checks[k], p.label))),
        h("button.btn.sm", { onclick: find }, "Find & mark all"),
        h("h3", {}, "Marked areas"), count,
        h("label.check", {}, strip, "Remove document metadata"),
        h("button.btn.primary", { onclick: apply }, iconEl("protect", 18), "Apply redactions"),
        h("p.hint", {}, "Draw boxes with the Redact tool or use Find. Click a box to move or delete it."));
      const toolbar = h("div.toolbar", {},
        h("button.tbtn", { onclick: () => { editor.destroy(); box.replaceChildren(picker); wrap.className = "tool-page"; header.style.display = ""; } }, "← Open another"),
        h("span.sep"), toolButton(editor, { tool: "select", icon: "cursor", label: "Select" }), toolButton(editor, { tool: "redact", icon: "eraser", label: "Redact area" }),
        h("span.sep"), ...historyButtons(editor), h("span.sep"), ...zoomControls(editor));
      box.replaceChildren(h("div.workspace", { style: { height: "calc(100vh - 56px - 49px)" } }, toolbar, scroll, side));
      wrap.className = "";
      await editor.init();
      editor.fitWidth();
      editor.setTool("redact");
      updateCount();
      void pageIndicator;
    }
    return () => editor?.destroy();
  }
}
