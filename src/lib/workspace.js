// Shared UI pieces for tools built on PageEditor.
import { h } from "./util.js";
import { iconEl, modal } from "./ui.js";
import { FAMILIES, normalizeFamily } from "./fontsCore.js";
import { normalizeLink } from "./richtext.js";

export function toolButton(editor, { tool, icon, label, title }) {
  const b = h("button.tbtn", { title: title || label, "data-tool": tool, onclick: () => editor.setTool(editor.tool === tool && tool !== "select" ? "select" : tool) }, iconEl(icon, 18), h("span", {}, label));
  const sync = () => b.classList.toggle("active", editor.tool === tool);
  editor.on("tool", sync);
  sync();
  return b;
}

export function historyButtons(editor) {
  const undo = h("button.tbtn", { title: "Undo (Ctrl/⌘+Z)", onclick: () => editor.undo() }, iconEl("undo", 18));
  const redo = h("button.tbtn", { title: "Redo (Ctrl/⌘+Shift+Z)", onclick: () => editor.redo() }, iconEl("redo", 18));
  const sync = () => { undo.disabled = !editor.canUndo; redo.disabled = !editor.canRedo; };
  editor.on("history", sync);
  sync();
  return [undo, redo];
}

export function zoomControls(editor) {
  const label = h("span.zoomlabel", {}, `${Math.round(editor.zoom * 100)}%`);
  editor.on("zoom", (z) => (label.textContent = `${Math.round(z * 100)}%`));
  return [
    h("button.tbtn", { title: "Zoom out", "aria-label": "Zoom out", onclick: () => editor.setZoom(editor.zoom - 0.15) }, "−"),
    label,
    h("button.tbtn", { title: "Zoom in", "aria-label": "Zoom in", onclick: () => editor.setZoom(editor.zoom + 0.15) }, "+"),
    h("button.tbtn", { title: "Fit to width", onclick: () => editor.fitWidth() }, "Fit"),
  ];
}

export function pageIndicator(editor) {
  const el = h("span.hint", {}, `Page 1 / ${editor.doc.numPages}`);
  const upd = () => (el.textContent = `Page ${editor.currentPage() + 1} / ${editor.doc.numPages}`);
  editor.container.addEventListener("scroll", upd, { passive: true });
  return el;
}

/** Property panel for the currently selected object (or default styles). */
export function propertiesPanel(editor) {
  const root = h("div.col");
  let cleanup = [];
  const listen = (ev, fn) => { editor.on(ev, fn); cleanup.push(() => editor.off(ev, fn)); };

  const render = (o) => {
    cleanup.forEach((f) => f());
    cleanup = [];
    root.replaceChildren();
    const s = editor.style;
    const type = o?.type;
    root.append(h("h3", {}, o ? labelFor(o) : "Defaults for new objects"));
    if (type === "text") root.append(textPanel(editor, o, listen));
    else if (!o) root.append(defaultsPanel(editor, s));
    if (!o || (type === "rect" && o.subtype === "shape")) {
      const v = o || s;
      root.append(
        h("label.field", {}, h("span", {}, "Outline color"), h("input", { type: "color", value: v.stroke || s.stroke, oninput: (e) => (o ? editor.updateObject(o.id, { stroke: e.target.value }, { commit: false }) : (s.stroke = e.target.value)), onchange: () => o && editor.pushHistory() })),
        h("label.field", {}, h("span", {}, "Outline width"), h("input.num-input", { type: "number", min: 0.5, max: 20, step: 0.5, value: o ? o.strokeWidth : s.width, onchange: (e) => (o ? editor.updateObject(o.id, { strokeWidth: +e.target.value || 1 }) : (s.width = +e.target.value || 1)) }))
      );
    }
    if (type === "rect" && o.subtype === "highlight") root.append(h("label.field", {}, h("span", {}, "Highlight color"), h("input", { type: "color", value: o.fill, onchange: (e) => { s.fill = e.target.value; editor.updateObject(o.id, { fill: e.target.value }); } })));
    if (type === "ink") root.append(h("label.field", {}, h("span", {}, "Pen color"), h("input", { type: "color", value: o.color, onchange: (e) => editor.updateObject(o.id, { color: e.target.value }) })), h("label.field", {}, h("span", {}, "Pen width"), h("input.num-input", { type: "number", min: 0.5, max: 30, step: 0.5, value: o.width, onchange: (e) => editor.updateObject(o.id, { width: +e.target.value || 2 }) })));
    if (type === "image") root.append(h("label.field", {}, h("span", {}, "Opacity"), h("input", { type: "range", min: 0.1, max: 1, step: 0.05, value: o.opacity ?? 1, oninput: (e) => editor.updateObject(o.id, { opacity: +e.target.value }, { commit: false }), onchange: () => editor.pushHistory() })));
    if (o) {
      root.append(h("div.row", {}, h("button.btn.sm", { onmousedown: (e) => e.preventDefault(), onclick: () => editor.duplicateSelected() }, iconEl("copy", 16), "Duplicate"), h("button.btn.sm.danger", { onmousedown: (e) => e.preventDefault(), onclick: () => editor.removeObject(o.id) }, iconEl("trash", 16), "Delete")));
    } else {
      root.append(h("p.hint", {}, "Pick a tool above, then click or drag on the page. Click any text to edit it."));
    }
  };
  editor.on("select", render);
  render(null);
  return root;
}

function defaultsPanel(editor, s) {
  const font = h("select", { "aria-label": "Font", onchange: (e) => (s.font = e.target.value) }, Object.entries(FAMILIES).map(([id, f]) => h("option", { value: id, selected: normalizeFamily(s.font) === id }, f.label)));
  return h("div.col", {},
    h("label.field", {}, h("span", {}, "Font"), font),
    h("div.row", {},
      h("label.field", {}, h("span", {}, "Size"), h("input.num-input", { type: "number", min: 4, max: 200, value: s.size, style: { width: "70px" }, oninput: (e) => (s.size = Math.max(4, +e.target.value || 12)) })),
      h("label.field", {}, h("span", {}, "Color"), h("input", { type: "color", value: s.color, oninput: (e) => (s.color = e.target.value) }))));
}

/** Word-style "Insert / Edit hyperlink" dialog (web page, email, or a page in this document). */
async function openLinkDialog(editor) {
  const ctx = editor.linkContext();
  if (!ctx) return;
  const startPage = ctx.url.startsWith("#page=");
  let kind = startPage ? "page" : "web";
  let error = "";
  let text = ctx.text;
  let addr = startPage ? "" : ctx.url;
  let pageNo = startPage ? ctx.url.slice(6) : "1";
  for (;;) {
    const textIn = h("input.text-input", { value: text, placeholder: "Text to display", "aria-label": "Text to display" });
    const addrIn = h("input.text-input", { value: addr, placeholder: "https://example.com   or   name@example.com", "aria-label": "Link address", disabled: kind === "page" });
    const pageIn = h("input.num-input", { type: "number", min: 1, max: ctx.pageCount, value: pageNo, "aria-label": "Target page", disabled: kind !== "page", style: { width: "90px" } });
    const radio = (value, label) => h("label.check", {}, h("input", { type: "radio", name: "linkkind", value, checked: kind === value, onchange: () => { kind = value; addrIn.disabled = value === "page"; pageIn.disabled = value !== "page"; (value === "page" ? pageIn : addrIn).focus(); } }), label);
    const form = h("form", { onsubmit: (e) => { e.preventDefault(); modal.close("ok"); } },
      h("div.col", {},
        h("label.field", {}, h("span", {}, "Text to display"), textIn),
        radio("web", "Web page or email address"),
        h("div", { style: { marginLeft: "24px" } }, addrIn),
        radio("page", "Place in this document (page number)"),
        h("div", { style: { marginLeft: "24px" } }, pageIn, h("span.hint", {}, `  of ${ctx.pageCount}`)),
        h("div.hint", { style: { color: "var(--danger)", minHeight: "1.3em" }, role: "alert" }, error)));
    const r = await modal({ title: ctx.url ? "Edit link" : "Insert link", body: form, actions: [{ label: "Cancel", value: null }, ...(ctx.url ? [{ label: "Remove link", value: "remove" }] : []), { label: "OK", value: "ok", primary: true }] });
    text = textIn.value; addr = addrIn.value; pageNo = pageIn.value;
    if (r === "remove") { editor.removeLink(); return; }
    if (r !== "ok") { editor.refocusEditing(); return; }
    const res = normalizeLink(kind === "page" ? `#page=${pageNo}` : addr, { pageCount: ctx.pageCount });
    if (res.error) { error = res.error; continue; }
    editor.applyLink({ text, url: res.url });
    return;
  }
}

const noFocusSteal = (e) => e.preventDefault(); // keeps the text selection while clicking a toolbar button

function textPanel(editor, o, listen) {
  const box = h("div.col");
  const btn = (icon, title, fn, label) => {
    const b = h("button.fbtn", { type: "button", title, "aria-label": title, "aria-pressed": "false", onmousedown: noFocusSteal, onclick: fn }, icon ? iconEl(icon, 18) : label);
    return b;
  };
  const press = (b, on) => { b.classList.toggle("on", !!on); b.setAttribute("aria-pressed", String(!!on)); };

  if (o.origFont) box.append(h("p.hint", {}, `Original font: ${o.origFont}. Characters it contains keep that exact typeface.`));

  const font = h("select", { "aria-label": "Font", onchange: (e) => editor.updateObject(o.id, { font: e.target.value }, { refocus: true }) },
    Object.entries(FAMILIES).map(([id, f]) => h("option", { value: id, selected: normalizeFamily(o.font) === id }, f.label)));
  const size = h("input.num-input", { type: "number", min: 4, max: 200, step: 0.5, value: o.size, "aria-label": "Font size", style: { width: "74px" },
    oninput: (e) => { const v = +e.target.value; if (v >= 4 && v <= 200) editor.updateObject(o.id, { size: v }, { commit: false }); },
    onchange: (e) => { editor.updateObject(o.id, { size: Math.min(200, Math.max(4, +e.target.value || o.size)) }, { refocus: true }); } });
  const color = h("input", { type: "color", value: o.color, "aria-label": "Text color", oninput: (e) => editor.setColor(e.target.value, { refocus: false, commit: false }), onchange: () => { editor.pushHistory(); editor.refocusEditing(); } });

  const bBtn = btn(null, "Bold (Ctrl/⌘+B)", () => editor.toggleFormat("b"), h("b", {}, "B"));
  const iBtn = btn(null, "Italic (Ctrl/⌘+I)", () => editor.toggleFormat("i"), h("i", {}, "I"));
  const uBtn = btn(null, "Underline (Ctrl/⌘+U)", () => editor.toggleFormat("u"), h("u", {}, "U"));
  const clr = btn(null, "Clear formatting of the selection", () => editor.clearFormatting(), "Tx");
  const lnk = btn("link", "Insert link (Ctrl/⌘+K)", () => openLinkDialog(editor));
  const unl = btn("unlink", "Remove link", () => editor.removeLink());

  const aL = btn("alignLeft", "Align left", () => editor.setAlign("left"));
  const aC = btn("alignCenter", "Center", () => editor.setAlign("center"));
  const aR = btn("alignRight", "Align right", () => editor.setAlign("right"));
  const aJ = btn("alignJustify", "Justify", () => editor.setAlign("justify"));
  const lB = btn("listBullet", "Bulleted list", () => editor.toggleList("bullet"));
  const lN = btn("listNumber", "Numbered list", () => editor.toggleList("number"));
  const iM = btn("indentMore", "Increase indent (Tab)", () => editor.changeIndent(1));
  const iL = btn("indentLess", "Decrease indent (Shift+Tab)", () => editor.changeIndent(-1));

  const factor = (o.lineHeight || o.size * 1.2) / o.size;
  const lineSel = h("select", { "aria-label": "Line spacing", onchange: (e) => editor.updateObject(o.id, { lineHeight: +e.target.value * o.size }, { refocus: true }) },
    [1, 1.15, 1.2, 1.5, 2, 2.5].map((f) => h("option", { value: f, selected: Math.abs(f - factor) < 0.03 }, `${f.toFixed(2).replace(/0$/, "")}×`)).concat(
      [1, 1.15, 1.2, 1.5, 2, 2.5].some((f) => Math.abs(f - factor) < 0.03) ? [] : [h("option", { value: factor, selected: true }, `${factor.toFixed(2)}×`)]));
  const after = h("input.num-input", { type: "number", min: 0, max: 100, step: 1, value: o.paraSpace || 0, "aria-label": "Space after paragraph (pt)", style: { width: "70px" }, onchange: (e) => editor.updateObject(o.id, { paraSpace: Math.max(0, +e.target.value || 0) }, { refocus: true }) });
  const track = h("input.num-input", { type: "number", min: -2, max: 20, step: 0.1, value: o.tracking || 0, "aria-label": "Character spacing (pt)", style: { width: "70px" }, onchange: (e) => editor.updateObject(o.id, { tracking: +e.target.value || 0 }, { refocus: true }) });

  box.append(
    h("label.field", {}, h("span", {}, "Font"), font),
    h("div.row", {}, h("label.field", {}, h("span", {}, "Size"), size), h("label.field", {}, h("span", {}, "Color"), color)),
    h("div.fgroup", { role: "group", "aria-label": "Character formatting" }, bBtn, iBtn, uBtn, clr),
    h("div.fgroup", { role: "group", "aria-label": "Hyperlink" }, lnk, unl),
    h("div.fgroup", { role: "group", "aria-label": "Alignment" }, aL, aC, aR, aJ),
    h("div.fgroup", { role: "group", "aria-label": "Lists and indent" }, lB, lN, iL, iM),
    h("h3", {}, "Spacing"),
    h("div.row", {}, h("label.field", {}, h("span", {}, "Line"), lineSel), h("label.field", {}, h("span", {}, "After ¶ (pt)"), after), h("label.field", {}, h("span", {}, "Letters (pt)"), track)),
    h("button.btn.sm", { type: "button", onmousedown: noFocusSteal, onclick: () => editor.trimSpaces(), title: "Remove leading/trailing and repeated spaces" }, iconEl("trim", 16), "Trim extra spaces"),
    h("p.hint", {}, "Select text to format just that part (or just those lines, for alignment and lists); with nothing selected, formatting applies to the whole box. Shortcuts: Ctrl/⌘+B, I, U, K (link); Tab / Shift+Tab to indent.")
  );

  const refresh = () => {
    const st = editor.formatState();
    if (!st || st.o.id !== o.id) return;
    press(bBtn, st.b); press(iBtn, st.i); press(uBtn, st.u);
    for (const [b, k] of [[aL, "left"], [aC, "center"], [aR, "right"], [aJ, "justify"]]) press(b, st.para.align === k);
    press(lB, st.para.list === "bullet"); press(lN, st.para.list === "number");
    press(lnk, st.link); unl.disabled = !st.link;
    if (document.activeElement !== color && /^#[0-9a-f]{6}$/i.test(st.c)) color.value = st.c;
    const cur = st.o;
    if (document.activeElement !== size) size.value = cur.size;
  };
  listen("format", refresh);
  listen("link-request", () => openLinkDialog(editor));
  refresh();
  return box;
}

function labelFor(o) {
  return { text: "Text", image: "Image", ink: "Drawing", redact: "Redaction", field: "Signature field" }[o.type] || { shape: "Rectangle", highlight: "Highlight", whiteout: "Whiteout" }[o.subtype] || "Object";
}
