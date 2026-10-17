// Browser side of the font system: loads the bundled fonts so the on-screen preview and the exported PDF
// use exactly the same files.
import fontkit from "@pdf-lib/fontkit";
import { createProvider, variantFiles } from "./fontsCore.js";
import { applyEdits } from "./ops.js";

export const fonts = createProvider({
  fontkit,
  loadBytes: async (file) => {
    const res = await fetch(`/vendor/fonts/${file}`);
    if (!res.ok) throw new Error(`Font ${file} not found`);
    return new Uint8Array(await res.arrayBuffer());
  },
});

const registered = new Set();

/** CSS font-family stack for a variant; per-character fallback happens in list order. */
export function cssStack(family, bold, italic, text = "", originals = []) {
  const orig = originals.map((id) => `"ps-orig-${id}"`);
  return [...orig, ...variantFiles(family, bold, italic, text).map((f) => `"ps-${f.id}"`)].join(", ") + ", sans-serif";
}

const origRegistered = new Set();
/** Register a font program taken from the PDF itself so the preview can render with the original typeface. */
export async function registerOriginalFace(id, bytes) {
  if (origRegistered.has(id)) return;
  origRegistered.add(id);
  try {
    const ff = new FontFace(`ps-orig-${id}`, bytes.slice().buffer);
    await ff.load();
    document.fonts.add(ff);
  } catch (e) {
    origRegistered.delete(id);
    throw e;
  }
}

/** em-fraction ascent/descent of a font program, or null if it can't be parsed. */
export function programMetrics(bytes) {
  try {
    const fk = fontkit.create(bytes);
    const upm = fk.unitsPerEm || 1000;
    return { asc: fk.ascent / upm, desc: -fk.descent / upm };
  } catch {
    return null;
  }
}

/** Load the faces needed to render `text` and register them with the document. */
export async function ensureFonts(family, bold, italic, text = "") {
  const faces = await fonts.faces(family, bold, italic, text);
  await Promise.all(faces.map(async (f) => {
    if (registered.has(f.id)) return;
    registered.add(f.id);
    const ff = new FontFace(`ps-${f.id}`, f.bytes.slice().buffer);
    await ff.load();
    document.fonts.add(ff);
  }));
}

export const metricsFor = (family, bold, italic) => fonts.metrics(family, bold, italic);

/** applyEdits with the browser font provider. */
export const applyEditsWithFonts = (bytes, editsByPage, assets, fontData = {}) => applyEdits(bytes, editsByPage, assets, { fonts, fontData });
