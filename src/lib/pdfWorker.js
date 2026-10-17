// PDF.js worker entry: install polyfills first, then load the real worker.
import "./polyfills.js";
import "pdfjs-dist/legacy/build/pdf.worker.min.mjs";
