// Font matching + glyph-aware font chains shared by the browser and Node tests.
// Fonts are open, metric-compatible substitutes (Arimo≈Arial/Helvetica, Tinos≈Times, Cousine≈Courier,
// Carlito≈Calibri) plus Roboto/Open Sans/Lato/Noto Sans. Noto Sans is the glyph fallback (₹, accents, ...).

export const FAMILIES = {
  arimo: { label: "Sans · Arial / Helvetica look", pkg: "arimo" },
  tinos: { label: "Serif · Times look", pkg: "tinos" },
  cousine: { label: "Mono · Courier look", pkg: "cousine" },
  carlito: { label: "Sans · Calibri look", pkg: "carlito" },
  roboto: { label: "Roboto", pkg: "roboto" },
  "open-sans": { label: "Open Sans", pkg: "open-sans" },
  lato: { label: "Lato", pkg: "lato" },
  "noto-sans": { label: "Noto Sans (wide coverage)", pkg: "noto-sans" },
};
export const FALLBACK_FAMILY = "noto-sans";
export const DEFAULT_FAMILY = "arimo";
const LEGACY = { Helvetica: "arimo", Times: "tinos", Courier: "cousine" };
export const normalizeFamily = (f) => (FAMILIES[f] ? f : LEGACY[f] || DEFAULT_FAMILY);

const NO_LATIN_EXT_ONLY = new Set(["lato"]); // lato ships only latin + latin-ext

function subsetsFor(family, text = "") {
  const s = ["latin", "latin-ext"];
  if (!NO_LATIN_EXT_ONLY.has(family)) {
    if (/[Ѐ-ԯ]/.test(text)) s.push("cyrillic");
    if (/[Ͱ-Ͽἀ-῿]/.test(text)) s.push("greek");
  }
  return s;
}

/** Ordered list of font files that together cover `text` for a family/variant. */
export function variantFiles(family, bold, italic, text = "") {
  family = normalizeFamily(family);
  const w = bold ? 700 : 400;
  const st = italic ? "italic" : "normal";
  const out = [];
  const add = (fam) => {
    for (const sub of subsetsFor(fam, text)) {
      const id = `${FAMILIES[fam].pkg}-${sub}-${w}-${st}`;
      if (!out.some((f) => f.id === id)) out.push({ id, file: `${id}.woff`, family: fam });
    }
  };
  add(family);
  if (family !== FALLBACK_FAMILY) add(FALLBACK_FAMILY);
  return out;
}

/** Map a PDF's own font name (e.g. "ABCDEE+Arial-BoldMT") to the closest bundled family and style. */
export function matchFont(pdfFontName = "", hints = {}) {
  const n = String(pdfFontName).replace(/^[A-Z]{6}\+/, "").toLowerCase().replace(/[\s_-]/g, "");
  let family = DEFAULT_FAMILY;
  let matched = true;
  if (/courier|consolas|menlo|monaco|mono|typewriter/.test(n)) family = "cousine";
  else if (/times|georgia|garamond|palatino|cambria|bookman|century|serif(?!sans)|minion|tinos/.test(n) && !/sans/.test(n)) family = "tinos";
  else if (/calibri|carlito|candara|segoe/.test(n)) family = "carlito";
  else if (/roboto/.test(n)) family = "roboto";
  else if (/opensans/.test(n)) family = "open-sans";
  else if (/lato/.test(n)) family = "lato";
  else if (/noto/.test(n)) family = "noto-sans";
  else matched = false;
  // unknown name: fall back to the PDF's own serif/monospace flags
  if (!matched) family = hints.mono ? "cousine" : hints.serif ? "tinos" : DEFAULT_FAMILY;
  const bold = /bold|black|heavy|semibold|demi|extrabold/.test(n);
  const italic = /italic|oblique|slanted|kursiv/.test(n);
  return { family, bold, italic };
}

/**
 * Provider that loads font bytes with `loadBytes(file)` and parses them with fontkit.
 * faces(...) -> [{id, bytes, fk}], metrics(...) -> {asc, desc} as em fractions of the primary face.
 */
export function createProvider({ fontkit, loadBytes }) {
  const cache = new Map();
  const getFace = async (spec) => {
    if (!cache.has(spec.id)) {
      cache.set(spec.id, (async () => {
        const bytes = await loadBytes(spec.file);
        return { id: spec.id, file: spec.file, bytes, fk: fontkit.create(bytes) };
      })());
    }
    return cache.get(spec.id);
  };
  return {
    fontkit,
    async faces(family, bold, italic, text = "") {
      return Promise.all(variantFiles(family, bold, italic, text).map(getFace));
    },
    async metrics(family, bold, italic) {
      const [primary] = await this.faces(family, bold, italic, "");
      const upm = primary.fk.unitsPerEm || 1000;
      return { asc: primary.fk.ascent / upm, desc: -primary.fk.descent / upm };
    },
  };
}

export const hasGlyph = (face, ch) => face.fk.hasGlyphForCodePoint(ch.codePointAt(0));
