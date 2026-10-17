// Small local server: serves the built app and stores signature requests.
// Everything else (editing, merging, OCR, ...) runs in the browser and never touches this server.
import express from "express";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = process.env.DATA_DIR || join(root, "data", "requests");
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
await mkdir(DATA, { recursive: true });

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "80mb" }));
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

const metaPath = (id) => join(DATA, `${id}.json`);
const pdfPath = (id, kind) => join(DATA, `${id}.${kind}.pdf`);
const isId = (s) => /^[a-f0-9]{16}$/.test(s);
const isPdf = (buf) => buf.length > 8 && buf.subarray(0, 5).toString("latin1") === "%PDF-";

async function readMeta(id) {
  try { return JSON.parse(await readFile(metaPath(id), "utf8")); } catch { return null; }
}
async function findByToken(token) {
  if (!/^[a-f0-9]{48}$/.test(token)) return null;
  for (const f of await readdir(DATA)) {
    if (!f.endsWith(".json")) continue;
    const m = JSON.parse(await readFile(join(DATA, f), "utf8"));
    if (m.token === token) return m;
  }
  return null;
}

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.post("/api/requests", async (req, res) => {
  const { name, signerName, signerEmail = "", message = "", fields = [], pdfBase64 } = req.body || {};
  if (!name || !signerName || !pdfBase64) return res.status(400).json({ error: "name, signerName and pdfBase64 are required" });
  const buf = Buffer.from(pdfBase64, "base64");
  if (!isPdf(buf)) return res.status(400).json({ error: "File is not a PDF" });
  const id = randomBytes(8).toString("hex");
  const token = randomBytes(24).toString("hex");
  const meta = {
    id, token, name: String(name).slice(0, 200), signerName: String(signerName).slice(0, 120), signerEmail: String(signerEmail).slice(0, 200),
    message: String(message).slice(0, 2000), status: "pending", createdAt: new Date().toISOString(), size: buf.length,
    fields: (Array.isArray(fields) ? fields : []).slice(0, 200).map((f) => ({ page: +f.page | 0, x: +f.x, y: +f.y, w: +f.w, h: +f.h, label: String(f.label || "Sign here").slice(0, 60) })),
  };
  await writeFile(pdfPath(id, "original"), buf);
  await writeFile(metaPath(id), JSON.stringify(meta));
  res.status(201).json({ id, token });
});

app.get("/api/requests", async (_req, res) => {
  const out = [];
  for (const f of await readdir(DATA)) {
    if (!f.endsWith(".json")) continue;
    const { fields, message, ...m } = JSON.parse(await readFile(join(DATA, f), "utf8"));
    out.push(m);
  }
  out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json({ requests: out });
});

app.get("/api/requests/:id/file", async (req, res) => {
  const { id } = req.params;
  const kind = req.query.kind === "signed" ? "signed" : "original";
  if (!isId(id) || !(await readMeta(id)) || !existsSync(pdfPath(id, kind))) return res.status(404).json({ error: "Not found" });
  res.type("application/pdf").send(await readFile(pdfPath(id, kind)));
});

app.delete("/api/requests/:id", async (req, res) => {
  const { id } = req.params;
  if (!isId(id) || !(await readMeta(id))) return res.status(404).json({ error: "Not found" });
  await Promise.all([metaPath(id), pdfPath(id, "original"), pdfPath(id, "signed")].map((p) => rm(p, { force: true })));
  res.json({ ok: true });
});

app.get("/api/sign/:token", async (req, res) => {
  const m = await findByToken(req.params.token);
  if (!m) return res.status(404).json({ error: "Invalid link" });
  const pdf = m.status === "signed" ? null : (await readFile(pdfPath(m.id, "original"))).toString("base64");
  res.json({ name: m.name, signerName: m.signerName, message: m.message, status: m.status, fields: m.fields, pdfBase64: pdf });
});

app.post("/api/sign/:token", async (req, res) => {
  const m = await findByToken(req.params.token);
  if (!m) return res.status(404).json({ error: "Invalid link" });
  if (m.status === "signed") return res.status(409).json({ error: "Already signed" });
  const buf = Buffer.from(req.body?.signedPdfBase64 || "", "base64");
  if (!isPdf(buf)) return res.status(400).json({ error: "Signed file is not a PDF" });
  await writeFile(pdfPath(m.id, "signed"), buf);
  await writeFile(metaPath(m.id), JSON.stringify({ ...m, status: "signed", signedAt: new Date().toISOString() }));
  res.json({ ok: true });
});

app.use("/api", (_req, res) => res.status(404).json({ error: "Not found" }));

const dist = join(root, "dist");
if (existsSync(dist)) {
  app.use(express.static(dist, { maxAge: "1h" }));
} else {
  console.warn("dist/ not found — run `npm run build` (or use `npm start`).");
}

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.type === "entity.too.large" ? "File too large" : "Server error" });
});

app.listen(PORT, HOST, () => console.log(`PDF Studio running at http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`));
