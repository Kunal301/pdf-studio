export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Tiny hyperscript helper: h('div.card', {onclick}, 'text', child) */
export function h(tag, attrs = {}, ...children) {
  // "div#id.a.b" -> tag, id, classes. (document.createElement must only get the bare tag name:
  // Firefox and Safari throw on "main#main" even though Chrome tolerates it.)
  const m = /^([A-Za-z][\w-]*)?(?:#([\w-]+))?((?:\.[\w-]+)*)$/.exec(tag);
  if (!m) throw new Error(`Invalid element spec "${tag}"`);
  const el = document.createElement(m[1] || "div");
  if (m[2]) el.id = m[2];
  if (m[3]) el.className = m[3].slice(1).split(".").join(" ");
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k === "class") el.classList.add(...String(v).split(" "));
    else if (k === "html") el.innerHTML = v;
    else if (k in el && k !== "list") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function download(data, filename, type = "application/octet-stream") {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = h("a", { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export async function readBytes(file) {
  return new Uint8Array(await file.arrayBuffer());
}

export const baseName = (name) => name.replace(/\.[^.]+$/, "");

export function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

export function uid() {
  return Math.random().toString(36).slice(2, 10);
}

export function bytesToBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function base64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
export function dataUrlToBytes(url) {
  return base64ToBytes(url.split(",")[1]);
}

export async function zipFiles(files) {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  for (const f of files) zip.file(f.name, f.bytes);
  return zip.generateAsync({ type: "blob", compression: "DEFLATE" });
}

export function canvasToBlob(canvas, type = "image/png", quality = 0.92) {
  return new Promise((res) => canvas.toBlob(res, type, quality));
}

/** Convert any browser-decodable image (webp, gif, bmp...) to png/jpeg bytes. */
export async function imageFileToEmbeddable(file) {
  const bytes = await readBytes(file);
  if (file.type === "image/png") return { bytes, mime: "image/png" };
  if (file.type === "image/jpeg") return { bytes, mime: "image/jpeg" };
  const bmp = await createImageBitmap(file);
  const c = document.createElement("canvas");
  c.width = bmp.width;
  c.height = bmp.height;
  c.getContext("2d").drawImage(bmp, 0, 0);
  const blob = await canvasToBlob(c, "image/png");
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: "image/png" };
}
