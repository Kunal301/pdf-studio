import { h, fmtSize } from "./util.js";

export function toast(message, kind = "info", ms = 4000) {
  let host = document.getElementById("toasts");
  if (!host) {
    host = h("div#toasts", { id: "toasts", role: "status", "aria-live": "polite" });
    document.body.append(host);
  }
  const t = h("div.toast." + kind, {}, message);
  host.append(t);
  setTimeout(() => t.remove(), ms);
}

export function modal({ title, body, actions = [], wide = false }) {
  return new Promise((resolve) => {
    const close = (v) => {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      resolve(v);
    };
    const onKey = (e) => e.key === "Escape" && close(null);
    const overlay = h(
      "div.modal-overlay",
      { onmousedown: (e) => e.target === overlay && close(null) },
      h(
        "div.modal" + (wide ? ".wide" : ""),
        { role: "dialog", "aria-modal": "true", "aria-label": title },
        h("h2", {}, title),
        h("div.modal-body", {}, body),
        h("div.modal-actions", {}, actions.map((a) => h("button" + (a.primary ? ".btn.primary" : ".btn"), { onclick: () => close(a.value) }, a.label)))
      )
    );
    document.addEventListener("keydown", onKey);
    document.body.append(overlay);
    overlay.querySelector("input,textarea,button.primary")?.focus();
    modal.close = close;
  });
}

export async function promptText(title, message, { password = false, placeholder = "" } = {}) {
  const input = h("input.text-input", { type: password ? "password" : "text", placeholder, autocomplete: "off" });
  const form = h("form", { onsubmit: (e) => { e.preventDefault(); modal.close(input.value); } }, h("p", {}, message), input);
  return modal({ title, body: form, actions: [{ label: "Cancel", value: null }, { label: "OK", value: "__ok__", primary: true }] }).then((v) => (v === "__ok__" ? input.value : v));
}

export function progressBar() {
  const bar = h("div.progress-bar");
  const label = h("div.progress-label", {}, "");
  const el = h("div.progress", { role: "progressbar" }, h("div.progress-track", {}, bar), label);
  return {
    el,
    set(fraction, text) {
      bar.style.width = `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
      if (text != null) label.textContent = text;
    },
  };
}

/**
 * Drag & drop + click-to-browse zone. onFiles receives File[].
 */
export function dropzone({ accept, multiple = false, label = "Drop files here or click to browse", onFiles }) {
  const input = h("input", { type: "file", accept, multiple, hidden: true });
  const zone = h(
    "div.dropzone",
    { tabIndex: 0, role: "button", "aria-label": label },
    h("div.dz-icon", { html: icon("upload") }),
    h("div.dz-label", {}, label),
    input
  );
  const handle = (files) => {
    const list = [...files];
    if (list.length) onFiles(multiple ? list : [list[0]]);
  };
  zone.addEventListener("click", () => input.click());
  zone.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), input.click()));
  input.addEventListener("change", () => { handle(input.files); input.value = ""; });
  zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("over"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("over"));
  zone.addEventListener("drop", (e) => { e.preventDefault(); zone.classList.remove("over"); handle(e.dataTransfer.files); });
  return zone;
}

export function fileChip(file, onRemove) {
  return h("div.chip", {}, h("span.chip-name", {}, file.name), h("span.chip-size", {}, fmtSize(file.size)), onRemove && h("button.chip-x", { "aria-label": "Remove", onclick: onRemove }, "×"));
}

const ICONS = {
  upload: '<path d="M12 16V4m0 0L7 9m5-5 5 5M4 20h16"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4"/>',
  convert: '<path d="M4 8h13l-3-3M20 16H7l3 3"/>',
  merge: '<rect x="3" y="7" width="10" height="13" rx="2"/><path d="M8 4h10a3 3 0 0 1 3 3v10"/>',
  split: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><path d="M8 7.5 20 17M8 16.5 20 7"/>',
  organize: '<rect x="4" y="3" width="10" height="13" rx="1.5"/><path d="M8 20h9a3 3 0 0 0 3-3V8"/>',
  ocr: '<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M8 12h8"/>',
  sign: '<path d="M3 18c3 0 4-8 6-8s0 6 2 6 2-4 4-4 1 3 3 3M3 21h18"/>',
  protect: '<path d="M12 3 5 6v5c0 5 3 8 7 10 4-2 7-5 7-10V6l-7-3z"/><path d="m9 12 2 2 4-4"/>',
  home: '<path d="M4 11 12 4l8 7v9h-5v-6H9v6H4z"/>',
  trash: '<path d="M5 7h14M10 11v6M14 11v6M7 7l1 13h8l1-13M9 7V4h6v3"/>',
  rotate: '<path d="M20 12a8 8 0 1 1-3-6.2M20 4v5h-5"/>',
  rotateL: '<path d="M4 12a8 8 0 1 0 3-6.2M4 4v5h5"/>',
  text: '<path d="M5 6V4h14v2M12 4v16M9 20h6"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m4 18 5-5 4 4 3-3 4 4"/>',
  rect: '<rect x="4" y="6" width="16" height="12" rx="1"/>',
  highlight: '<path d="m4 20 4-1 10-10-3-3L5 16l-1 4zM14 6l4 4"/>',
  pen: '<path d="M4 20c2-6 6-10 10-14l4 4c-4 4-8 8-14 10zM13 7l4 4"/>',
  cursor: '<path d="M6 3 18 12l-5 1 3 6-3 1-3-6-4 3z"/>',
  down: '<path d="M12 4v12m0 0 5-5m-5 5-5-5M4 20h16"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  undo: '<path d="M9 8H5v4M5 8a8 8 0 1 1-1 9"/>',
  redo: '<path d="M15 8h4v4M19 8a8 8 0 1 0 1 9"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  eraser: '<path d="m6 17 9-9 4 4-6 6H8zM4 20h16"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M4 16V6a2 2 0 0 1 2-2h10"/>',
  alignLeft: '<path d="M4 6h16M4 10h10M4 14h16M4 18h10"/>',
  alignCenter: '<path d="M4 6h16M7 10h10M4 14h16M7 18h10"/>',
  alignRight: '<path d="M4 6h16M10 10h10M4 14h16M10 18h10"/>',
  alignJustify: '<path d="M4 6h16M4 10h16M4 14h16M4 18h16"/>',
  listBullet: '<circle cx="5" cy="7" r="1.2"/><circle cx="5" cy="12" r="1.2"/><circle cx="5" cy="17" r="1.2"/><path d="M9 7h11M9 12h11M9 17h11"/>',
  listNumber: '<path d="M10 7h10M10 12h10M10 17h10M4 5.5 5.5 5v4M4 15.5c0-1.2 2.2-1.2 2.2 0S4 17 4 18.5h2.4"/>',
  indentMore: '<path d="M4 6h16M12 10h8M12 14h8M4 18h16M4 9l3 3-3 3"/>',
  indentLess: '<path d="M4 6h16M12 10h8M12 14h8M4 18h16M7 9l-3 3 3 3"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  unlink: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7M4 4l16 16"/>',
  trim: '<path d="M4 8h16M4 16h16M9 12h6M9 12l2-2M9 12l2 2M15 12l-2-2M15 12l-2 2"/>',
};
export function icon(name, size = 20) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ""}</svg>`;
}
export const iconEl = (name, size) => h("span.ico", { html: icon(name, size) });
