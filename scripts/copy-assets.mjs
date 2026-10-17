// Copies the WASM/worker/language assets the app loads at runtime into public/vendor
// so that everything is served same-origin (works fully offline).
import { cpSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const nm = (...p) => join(root, "node_modules", ...p);
const out = (...p) => join(root, "public", "vendor", ...p);

mkdirSync(out("tesseract", "core"), { recursive: true });
mkdirSync(out("tessdata"), { recursive: true });
mkdirSync(out("qpdf"), { recursive: true });

cpSync(nm("tesseract.js", "dist", "worker.min.js"), out("tesseract", "worker.min.js"));
for (const f of readdirSync(nm("tesseract.js-core"))) {
  if (f.startsWith("tesseract-core") && (f.endsWith(".js") || f.endsWith(".wasm"))) {
    cpSync(nm("tesseract.js-core", f), out("tesseract", "core", f));
  }
}
const eng = nm("@tesseract.js-data", "eng", "4.0.0_best_int", "eng.traineddata.gz");
if (!existsSync(eng)) throw new Error("eng.traineddata.gz not found");
cpSync(eng, out("tessdata", "eng.traineddata.gz"));
cpSync(nm("@neslinesli93", "qpdf-wasm", "dist", "qpdf.wasm"), out("qpdf", "qpdf.wasm"));
console.log("vendor assets copied");

// Fonts for text editing (open-licensed). Copy latin, latin-ext, cyrillic, greek in 400/700 normal+italic.
mkdirSync(out("fonts"), { recursive: true });
let fontCount = 0;
for (const pkg of ["arimo", "tinos", "cousine", "carlito", "roboto", "open-sans", "lato", "noto-sans"]) {
  const dir = nm("@fontsource", pkg, "files");
  for (const f of readdirSync(dir)) {
    if (new RegExp(`^${pkg}-(latin|latin-ext|cyrillic|greek)-(400|700)-(normal|italic)\\.woff$`).test(f)) {
      cpSync(join(dir, f), out("fonts", f));
      fontCount++;
    }
  }
}
console.log(`${fontCount} font files copied`);
