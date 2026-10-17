import { h, dataUrlToBytes, canvasToBlob } from "./util.js";
import { modal, toast } from "./ui.js";

const KEY = (kind) => `pdfstudio.${kind}s`;
const FONTS = ["'Snell Roundhand', 'Apple Chancery', cursive", "'Brush Script MT', 'Segoe Script', cursive", "'Lucida Handwriting', 'Bradley Hand', cursive", "'Zapfino', 'Papyrus', cursive"];

function loadSaved(kind) {
  try { return JSON.parse(localStorage.getItem(KEY(kind)) || "[]"); } catch { return []; }
}
function saveSaved(kind, list) {
  try { localStorage.setItem(KEY(kind), JSON.stringify(list.slice(0, 6))); } catch { /* storage unavailable */ }
}

function trim(canvas) {
  const ctx = canvas.getContext("2d");
  const { width, height } = canvas;
  const d = ctx.getImageData(0, 0, width, height).data;
  let x0 = width, y0 = height, x1 = 0, y1 = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (d[(y * width + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < x0) return null;
  const pad = 6;
  const out = document.createElement("canvas");
  out.width = x1 - x0 + 1 + pad * 2;
  out.height = y1 - y0 + 1 + pad * 2;
  out.getContext("2d").drawImage(canvas, x0, y0, x1 - x0 + 1, y1 - y0 + 1, pad, pad, x1 - x0 + 1, y1 - y0 + 1);
  return out;
}

async function toResult(canvas) {
  const t = trim(canvas);
  if (!t) return null;
  const blob = await canvasToBlob(t, "image/png");
  const dataUrl = t.toDataURL("image/png");
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: "image/png", w: t.width, h: t.height, dataUrl };
}

/** Opens the signature dialog. Resolves to {bytes,mime,w,h} or null. kind: 'signature' | 'initial' */
export async function getSignature(kind = "signature") {
  let mode = "draw";
  let current = null; // canvas or dataURL for the chosen option
  const saved = loadSaved(kind);
  const save = h("input", { type: "checkbox", checked: true });
  const panel = h("div");
  const tabs = h("div.sig-tabs");
  let picked = null;

  const savedRow = saved.length ? h("div", {}, h("div.hint", { style: { marginBottom: "6px" } }, "Saved on this device"), h("div.sig-saved", {}, saved.map((url) => h("button", { title: "Use this", onclick: async () => { picked = url; modal.close("saved"); } }, h("img", { src: url, alt: "Saved signature" }))))) : null;

  function showTab(m) {
    mode = m;
    tabs.replaceChildren(...[["draw", "Draw"], ["type", "Type"], ["upload", "Upload"]].map(([k, l]) => h("button.btn.sm" + (k === m ? ".active" : ""), { onclick: () => showTab(k) }, l)));
    panel.replaceChildren();
    current = null;
    if (m === "draw") {
      const c = h("canvas.sig-canvas", { width: 800, height: 280 });
      const ctx = c.getContext("2d");
      ctx.lineWidth = 5; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = "#111";
      let drawing = false, last = null;
      const pos = (e) => { const r = c.getBoundingClientRect(); return [(e.clientX - r.left) * (c.width / r.width), (e.clientY - r.top) * (c.height / r.height)]; };
      c.addEventListener("pointerdown", (e) => { drawing = true; last = pos(e); c.setPointerCapture(e.pointerId); ctx.beginPath(); ctx.moveTo(...last); ctx.lineTo(last[0] + 0.1, last[1] + 0.1); ctx.stroke(); current = c; });
      c.addEventListener("pointermove", (e) => { if (!drawing) return; const p = pos(e); ctx.beginPath(); ctx.moveTo(...last); ctx.lineTo(...p); ctx.stroke(); last = p; });
      const end = () => (drawing = false);
      c.addEventListener("pointerup", end); c.addEventListener("pointercancel", end);
      panel.append(c, h("div.row", { style: { marginTop: "8px" } }, h("button.btn.sm", { onclick: () => { ctx.clearRect(0, 0, c.width, c.height); current = null; } }, "Clear"), h("span.hint", {}, "Sign with your mouse, finger or stylus.")));
    } else if (m === "type") {
      const input = h("input.text-input", { placeholder: kind === "initial" ? "Your initials" : "Type your name", "aria-label": "Name to sign" });
      let font = FONTS[0];
      const preview = h("div.type-preview", { style: { fontFamily: font } }, "");
      const render = () => {
        preview.textContent = input.value;
        preview.style.fontFamily = font;
        if (!input.value.trim()) { current = null; return; }
        const c = document.createElement("canvas");
        const ctx = c.getContext("2d");
        ctx.font = `110px ${font}`;
        const w = Math.ceil(ctx.measureText(input.value).width) + 60;
        c.width = w; c.height = 220;
        const ctx2 = c.getContext("2d");
        ctx2.font = `110px ${font}`; ctx2.fillStyle = "#111"; ctx2.textBaseline = "middle";
        ctx2.fillText(input.value, 30, 110);
        current = c;
      };
      input.addEventListener("input", render);
      const fontRow = h("div.row", { style: { marginTop: "8px" } }, FONTS.map((f, i) => h("button.btn.sm", { style: { fontFamily: f, fontSize: "18px" }, onclick: () => { font = f; render(); } }, "Aa" + (i + 1))));
      panel.append(input, preview, fontRow);
    } else {
      const input = h("input", { type: "file", accept: "image/*" });
      const white = h("input", { type: "checkbox", checked: true });
      const prev = h("div.type-preview", {}, h("span.hint", {}, "Pick a photo or scan of your signature"));
      input.addEventListener("change", async () => {
        const f = input.files[0];
        if (!f) return;
        const bmp = await createImageBitmap(f);
        const s = Math.min(1, 900 / bmp.width);
        const c = document.createElement("canvas");
        c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
        const ctx = c.getContext("2d");
        ctx.drawImage(bmp, 0, 0, c.width, c.height);
        if (white.checked) {
          const id = ctx.getImageData(0, 0, c.width, c.height);
          for (let i = 0; i < id.data.length; i += 4) {
            const lum = (id.data[i] + id.data[i + 1] + id.data[i + 2]) / 3;
            if (lum > 215) id.data[i + 3] = 0;
            else if (lum > 150) id.data[i + 3] = Math.round(255 * (215 - lum) / 65);
          }
          ctx.putImageData(id, 0, 0);
        }
        current = c;
        prev.replaceChildren(h("img", { src: c.toDataURL(), style: { maxHeight: "120px", maxWidth: "100%", background: "repeating-conic-gradient(#ddd 0 25%, #fff 0 50%) 0 0/12px 12px" } }));
      });
      panel.append(input, h("label.check", { style: { marginTop: "8px" } }, white, "Make white background transparent"), prev);
    }
  }
  showTab("draw");

  const body = h("div", {}, savedRow, savedRow && h("hr", { style: { border: 0, borderTop: "1px solid var(--line)", margin: "12px 0" } }), tabs, panel, h("label.check", { style: { marginTop: "12px" } }, save, "Save on this device for next time"));
  const r = await modal({ title: kind === "initial" ? "Create your initials" : "Create your signature", body, wide: true, actions: [{ label: "Cancel", value: null }, { label: "Use", value: "use", primary: true }] });
  if (r === "saved" && picked) {
    const bmp = await createImageBitmap(new Blob([dataUrlToBytes(picked)], { type: "image/png" }));
    return { bytes: dataUrlToBytes(picked), mime: "image/png", w: bmp.width, h: bmp.height };
  }
  if (r !== "use") return null;
  if (!current) { toast("Draw, type or upload a signature first.", "error"); return null; }
  const res = await toResult(current);
  if (!res) { toast("The signature is empty.", "error"); return null; }
  if (save.checked) saveSaved(kind, [res.dataUrl, ...loadSaved(kind).filter((u) => u !== res.dataUrl)]);
  return res;
}
