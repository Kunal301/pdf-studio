import "./styles.css";
import { h, $ } from "./lib/util.js";
import { icon, toast } from "./lib/ui.js";

// Tools are lazy-loaded so the home screen stays light.
const TOOLS = [
  { id: "edit", title: "Edit PDFs", desc: "Change text, images, fonts, and document layouts.", icon: "edit", load: () => import("./tools/edit.js") },
  { id: "convert", title: "Convert files", desc: "Convert PDFs to Word, Excel, PowerPoint, and image formats, and vice versa.", icon: "convert", load: () => import("./tools/convert.js") },
  { id: "merge", title: "Merge PDFs", desc: "Combine multiple PDFs into one document.", icon: "merge", load: () => import("./tools/merge.js") },
  { id: "split", title: "Split PDFs", desc: "Divide one large PDF into smaller files.", icon: "split", load: () => import("./tools/split.js") },
  { id: "organize", title: "Organize pages", desc: "Delete, rotate, insert, extract, and reorder pages.", icon: "organize", load: () => import("./tools/organize.js") },
  { id: "ocr", title: "OCR scanning", desc: "Turn scanned PDFs or images into searchable, editable text.", icon: "ocr", load: () => import("./tools/ocr.js") },
  { id: "sign", title: "Sign documents", desc: "Add electronic signatures and request signatures from others.", icon: "sign", load: () => import("./tools/sign.js") },
  { id: "protect", title: "Protect PDFs", desc: "Add passwords, restrict permissions, and permanently redact sensitive information.", icon: "protect", load: () => import("./tools/protect.js") },
];

const app = $("#app");
let cleanup = null;

async function route() {
  if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; }
  const hash = location.hash.replace(/^#\/?/, "");
  const [id, ...rest] = hash.split("/");

  // Public signing page (opened by the person asked to sign): no app chrome.
  if (id === "s" && rest[0]) {
    app.replaceChildren();
    const mod = await import("./tools/signer.js");
    cleanup = await mod.mount(app, rest[0]);
    return;
  }

  const tool = TOOLS.find((t) => t.id === id);
  app.replaceChildren(header(tool?.id));
  const main = h("main#main", { tabIndex: -1 });
  app.append(main);
  if (!tool) {
    document.title = "PDF Studio";
    main.append(home());
    return;
  }
  document.title = `${tool.title} · PDF Studio`;
  main.classList.add("tool-main");
  main.append(h("div.loading", {}, "Loading…"));
  try {
    const mod = await tool.load();
    main.replaceChildren();
    cleanup = (await mod.mount(main, { tool, toast })) || null;
  } catch (e) {
    console.error(e);
    main.replaceChildren(h("div.error-box", {}, `Could not load ${tool.title}: ${e.message}`));
  }
}

function header(activeId) {
  return h(
    "header.topbar",
    {},
    h("a.brand", { href: "#/", "aria-label": "PDF Studio home" }, h("span.logo", { html: icon("organize", 18) }), h("span", {}, "PDF Studio")),
    h("nav.tabs", { "aria-label": "Tools" }, TOOLS.map((t) => h("a.tab" + (t.id === activeId ? ".active" : ""), { href: `#/${t.id}`, "aria-current": t.id === activeId ? "page" : null }, t.title))),
    h("span.privacy", { title: "Files are processed in your browser and never uploaded (except signature requests you create)." }, h("span", { html: icon("lock", 14) }), "Private · runs locally")
  );
}

function home() {
  return h(
    "div.home",
    {},
    h("h1", {}, "Every PDF tool you need, in one place"),
    h("p.lead", {}, "Edit, convert, merge, split, organize, OCR, sign and protect PDFs. Your files stay on this computer."),
    h(
      "div.grid",
      {},
      TOOLS.map((t) =>
        h("a.card", { href: `#/${t.id}` }, h("span.card-ico", { html: icon(t.icon, 26) }), h("h2", {}, t.title), h("p", {}, t.desc))
      )
    )
  );
}

window.addEventListener("hashchange", route);
window.addEventListener("unhandledrejection", (e) => {
  if (e.reason?.message === "Password entry cancelled") return;
  console.error(e.reason);
  toast(e.reason?.message || "Something went wrong", "error", 6000);
});
route();
