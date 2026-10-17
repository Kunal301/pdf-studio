# PDF Studio

A local, privacy-first PDF toolkit. Everything (except signature requests) runs in your browser — files are never uploaded.

| Tool | What it does |
|---|---|
| **Edit PDFs** | **Click any text in the PDF and edit it in place** — whole paragraphs/lines/columns are detected, the box keeps the original size, line spacing, colour, alignment (left/right/centre) and position, and is typeset **in the PDF's own embedded font** for every character that font contains. Characters the embedded (subset) font lacks fall back to the closest bundled font (Arial→Arimo, Times→Tinos, Courier→Cousine, Calibri→Carlito, Roboto, Open Sans, Lato, Noto Sans; ₹, accents, Cyrillic and Greek work). Click puts the caret where you clicked; double-click selects a word; drag selects a range; the ✥ grip moves the box. Word-style formatting in the side panel: **bold / italic / underline / colour on the selected text** (or the whole box when nothing is selected; Ctrl/⌘+B/I/U), alignment (left, centre, right, justify), bullets, numbering, indent (Tab / Shift+Tab), line / paragraph / letter spacing, *Trim extra spaces*, and **hyperlinks** (Ctrl/⌘+K or the link button: web address, email, or a page in the document; saved as real clickable PDF links; Ctrl/⌘+click a link in the editor to follow it; only http, https, mailto and tel targets are accepted). Bold labels inside a line (e.g. **Skills:** …) are recovered and keep the PDF's own bold font. Also add text, images, shapes, drawings, highlights and whiteout; move/resize/duplicate/delete; undo/redo. |
| **Convert files** | PDF → Word, Excel, PowerPoint, PNG/JPEG. Word, Excel, PowerPoint, CSV, text and images → PDF. |
| **Merge PDFs** | Combine files, reorder by drag or arrows. |
| **Split PDFs** | By custom ranges (`1-3, 5, 8-`), every N pages, or one file per page (ZIP when several). |
| **Organize pages** | Drag to reorder, rotate, delete, duplicate, insert blank pages or pages from another PDF, extract a selection. |
| **OCR scanning** | Scanned PDFs/images → searchable PDF and plain text (Tesseract, English bundled, works offline). |
| **Sign documents** | Draw/type/upload a signature, initials, date, text, check mark. **Request signatures**: create a private signing link, the signer fills "Sign here" fields, you download the signed copy. |
| **Protect PDFs** | Password-protect with AES-256 and permission limits, remove a known password, and **permanently redact** (find text/patterns or draw boxes). |

## Run it

```bash
npm install
npm start          # builds, then serves http://127.0.0.1:8787
npm test           # unit tests + 26 end-to-end browser tests (needs Microsoft Edge or set BROWSER_PATH)
```

Node 22+ is required. `npm run dev` is not provided; use `npx vite` (port 5173, proxies `/api` to 8787) together with `npm run serve` if you want hot reload.

### Signature requests across devices
The server binds to `127.0.0.1`, so a signing link only works on this computer. To let others sign, run it behind a tunnel or on a reachable host (`HOST=0.0.0.0 npm start`) — and put authentication/HTTPS in front of it first: the sender-side API (`/api/requests`) has no login. Signing links are unguessable (192-bit tokens) but anyone holding one can sign. Requests are stored in `data/requests/`.

## How it is built

- **Vite** front end, vanilla JS modules, lazy-loaded per tool.
- **pdf.js** renders pages and extracts text positions · **pdf-lib** writes PDFs (merge, split, edits, signatures).
- **qpdf (WASM)** for real AES-256 encryption/decryption.
- **Tesseract.js** for OCR; **docx**, **ExcelJS**, **PptxGenJS**, **mammoth**, **JSZip** for Office formats.
- **Express** (`server/index.js`) serves the app and stores signature requests.

## Known limitations (be aware before relying on it)

- **Editing existing text** works at the text-block level. Characters are drawn with the PDF's own font program whenever it contains the glyph; PDFs usually embed only the letters they use (a "subset"), so a letter that never appeared in the original comes from the closest bundled font instead (near-identical for Arial/Times/Courier/Calibri, visibly different for unusual typefaces). Fonts that are not embedded (e.g. plain Helvetica) always use the bundled match. Changing the font, bold or italic from the panel switches to bundled fonts. The original text is removed from the page content when it is safe to do so without shifting neighbouring text; otherwise (or for text inside form XObjects) it stays hidden under a cover and remains findable/copyable — use **Protect → Redact** when something must be permanently gone. Complex scripts that need shaping (e.g. Devanagari, Arabic) are not supported.
- **Redaction** rasterizes affected pages (text on those pages is no longer selectable/searchable). Run OCR afterwards if you need text back.
- **PDF → Word/Excel/PowerPoint** is reconstructed from the text layer; tables, columns and images are simplified. Use the "Exact look (page images)" mode for visual fidelity. Scanned PDFs need OCR first.
- **Word/Excel/PowerPoint → PDF** uses a built-in renderer (text, headings, lists, tables, PNG/JPEG pictures). Fonts, colors, charts and exact layout are not reproduced. Legacy `.doc/.xls/.ppt` are not supported.
- Signatures are **image-based electronic signatures**, not cryptographic/certificate-based digital signatures, and carry no audit trail or identity verification.
- OCR bundles English only; add languages by copying `<lang>.traineddata.gz` into `public/vendor/tessdata` and listing it in `src/tools/ocr.js`.
- Pages with a `/Rotate` entry are edited in their original (unrotated) frame.

## Deploy as a free static website (Cloudflare Pages)

Everything except *Request signatures* runs in the browser, so `dist/` can be hosted for free on any static host.
The signature-request tabs hide themselves automatically when there is no server.

- **Build command:** `npm run build`  ·  **Output directory:** `dist`  ·  Node 22 (`.node-version` is included)
- **Git route:** push this folder to GitHub, then Cloudflare dashboard → Workers & Pages → Create → Pages → Connect to Git.
- **No-Git route:** `npm run build`, then dashboard → Pages → Upload assets → drag the `dist` folder
  (or `npx wrangler pages deploy dist --project-name pdf-studio`).
