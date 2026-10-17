// Interactive page editor: renders PDF pages with pdf.js and manages an overlay of editable objects.
// Object coordinates are PDF points from the top-left of the page's crop box (see ops.applyEdits).
import { h, uid } from "./util.js";
import { renderToCanvas, pageBox, getTextRuns } from "./pdf.js";
import { buildBlocks } from "./textBlocks.js";
import { cssStack, ensureFonts, metricsFor, registerOriginalFace, programMetrics } from "./fonts.js";
import { matchFont } from "./fontsCore.js";
import { baselineOffset } from "./ops.js";
import { renderRich, parseRich, selectionOffsets, setSelectionOffsets, applyFmt, allHave, styleAt, baseStyle, paraAttrs, parasInRange, trimModel, compressStyles, charStyles, linkRange, replaceRange, LINK_COLOR } from "./richtext.js";

function hexA(hex, a) {
  const n = parseInt((hex || "#000000").slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export class PageEditor {
  /**
   * @param {object} o
   * @param {HTMLElement} o.container  scroll container
   * @param {PDFDocumentProxy} o.doc
   */
  constructor({ container, doc }) {
    this.container = container;
    this.doc = doc;
    this.listeners = {};
    this.zoom = 1.25;
    this.tool = "select";
    this.objects = [];
    this.assets = {};
    this.selected = null;
    this.pages = [];
    this.blocks = new Map();
    this.hitToken = 0;
    this.fontKeys = new Set();
    this.fontData = {};
    this.editing = null;
    this.forceRender = new Set();
    this.history = [];
    this.future = [];
    this.style = { font: "arimo", size: 14, bold: false, italic: false, color: "#000000", align: "left", fill: "#ffe14d", stroke: "#e11d48", width: 2.5 };
    this.pendingImage = null;
    this._onKey = (e) => this.onKey(e);
  }

  on(event, fn) {
    (this.listeners[event] ||= []).push(fn);
    return this;
  }

  off(event, fn) {
    this.listeners[event] = (this.listeners[event] || []).filter((f) => f !== fn);
  }

  emit(event, payload) {
    for (const fn of this.listeners[event] || []) fn(payload);
  }

  async init() {
    this.container.classList.add("editor-scroll");
    this.container.replaceChildren();
    this.pages = [];
    const observer = new IntersectionObserver((entries) => {
      for (const en of entries) if (en.isIntersecting) this.renderPage(en.target._pg);
    }, { root: this.container, rootMargin: "600px 0px" });
    this.observer = observer;
    for (let i = 0; i < this.doc.numPages; i++) {
      const page = await this.doc.getPage(i + 1);
      const box = pageBox(page);
      const canvas = h("canvas");
      const hits = h("div.hits");
      const overlay = h("div.overlay");
      const wrap = h("div.page-wrap", { "data-page": i }, canvas, hits, overlay, h("div.page-num", {}, `${i + 1}`));
      const pg = { index: i, page, box, canvas, hits, overlay, wrap, rendered: false, scale: 0 };
      wrap._pg = pg;
      this.pages.push(pg);
      this.container.append(wrap);
      this.sizePage(pg);
      overlay.addEventListener("pointerdown", (e) => this.onOverlayDown(e, pg));
      observer.observe(wrap);
    }
    document.addEventListener("keydown", this._onKey);
    // clicking empty space (page margin, gap, workspace background) deselects, which also drops untouched text boxes
    this.container.addEventListener("pointerdown", (e) => {
      if (!e.defaultPrevented && !e.target.closest(".obj, .block-hit, .handle")) this.select(null);
    });
    this.pushHistory(true);
    this.setTool(this.tool);
  }

  destroy() {
    document.removeEventListener("keydown", this._onKey);
    this.observer?.disconnect();
  }

  sizePage(pg) {
    pg.wrap.style.width = `${pg.box.w * this.zoom}px`;
    pg.wrap.style.height = `${pg.box.h * this.zoom}px`;
  }

  async renderPage(pg) {
    const scale = this.zoom * Math.min(window.devicePixelRatio || 1, 2.5);
    if (pg.rendered && Math.abs(pg.scale - scale) < 0.01) return;
    pg.rendered = true;
    pg.scale = scale;
    const tmp = document.createElement("canvas");
    await renderToCanvas(pg.page, tmp, scale, { rotation: 0 });
    pg.canvas.width = tmp.width;
    pg.canvas.height = tmp.height;
    pg.canvas.getContext("2d").drawImage(tmp, 0, 0);
    pg.canvas.style.width = "100%";
    pg.canvas.style.height = "100%";
  }

  async renderAllNow() {
    for (const pg of this.pages) await this.renderPage(pg);
  }

  setZoom(z) {
    this.endEdit();
    this.zoom = Math.min(4, Math.max(0.4, z));
    for (const pg of this.pages) {
      this.sizePage(pg);
      pg.rendered = false;
      if (pg.wrap.getBoundingClientRect().height) this.renderPage(pg);
    }
    this.layoutAll();
    this.rebuildHits();
    this.emit("zoom", this.zoom);
  }

  fitWidth() {
    const avail = this.container.clientWidth - 48;
    const widest = Math.max(...this.pages.map((p) => p.box.w));
    this.setZoom(Math.min(avail / widest, 1.6));
  }

  scrollToPage(i) {
    this.pages[i]?.wrap.scrollIntoView({ block: "start", behavior: "smooth" });
  }

  currentPage() {
    const top = this.container.getBoundingClientRect().top;
    let best = 0;
    for (const pg of this.pages) {
      if (pg.wrap.getBoundingClientRect().top - top < this.container.clientHeight / 2) best = pg.index;
    }
    return best;
  }

  // ---------- tools ----------
  setTool(tool) {
    this.tool = tool;
    this.container.dataset.tool = tool;
    if (tool !== "select") this.select(null);
    this.rebuildHits();
    this.emit("tool", tool);
  }

  async rebuildHits() {
    for (const pg of this.pages) pg.hits.replaceChildren();
    if (this.tool !== "edit-text") return;
    const token = ++this.hitToken;
    const z = this.zoom;
    for (const pg of this.pages) {
      if (!this.blocks.has(pg.index)) this.blocks.set(pg.index, buildBlocks(await getTextRuns(pg.page), { pageWidth: pg.box.w }));
      if (token !== this.hitToken) return;
      this.blocks.get(pg.index).forEach((b, bi) => {
        const el = h("div.block-hit", {
          title: "Click to edit this text",
          "aria-label": `Edit text: ${b.text.replace(/\s+/g, " ").slice(0, 70)}`,
          style: { left: `${(b.x - 2) * z}px`, top: `${(b.top - 1) * z}px`, width: `${(b.w + 4) * z}px`, height: `${(b.h + 2) * z}px` },
        });
        el.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); this.activateBlock(pg, b, `${pg.index}:${bi}`, { x: e.clientX, y: e.clientY }); });
        pg.hits.append(el);
      });
    }
  }

  // ---------- object model ----------
  addAsset(bytes, mime) {
    const id = uid();
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    this.assets[id] = { bytes, mime, url };
    return id;
  }

  addObject(pageIndex, obj, { select = true, commit = true } = {}) {
    const o = { id: uid(), page: pageIndex, ...obj };
    this.objects.push(o);
    this.mount(o);
    if (select) this.select(o.id);
    if (commit) this.pushHistory();
    this.emit("change");
    return o;
  }

  get(id) {
    return this.objects.find((o) => o.id === id);
  }

  updateObject(id, patch, { commit = true, refocus = false } = {}) {
    const o = this.get(id);
    if (!o) return;
    const ed = this.editing?.id === id ? this.editing : null;
    if (ed) {
      this.syncFromDom(o);
      const live = this.liveSelection(ed);
      if (live) ed.lastSel = live;
    }
    const keepSel = ed?.lastSel ? { ...ed.lastSel } : null;
    const isText = o.type === "text";
    const offsetOf_ = () => baselineOffset(o.size, o.lineHeight || o.size * 1.2, o.asc ?? 0.905, o.desc ?? 0.212);
    const before = isText && o.srcBlock ? offsetOf_() : null;
    const fontChange = isText && ("font" in patch || "bold" in patch || "italic" in patch);
    Object.assign(o, patch);
    if (isText) {
      // a whole-box change overrides any per-selection override of the same property
      const strip = [["bold", "b"], ["italic", "i"], ["color", "c"]].filter(([k]) => k in patch).map(([, f]) => f);
      if (strip.length) o.fmt = (o.fmt || []).map((r) => { const c = { ...r }; strip.forEach((f) => delete c[f]); return c; }).filter((r) => ["b", "i", "u", "c"].some((f) => r[f] !== undefined));
      if ("font" in patch && o.useOrig) o.useOrig = false; // another family: the PDF's own faces no longer apply
    }
    if (before != null) {
      if (fontChange) {
        // new family/style: fetch its metrics, then restore the first baseline
        metricsFor(o.font, o.bold, o.italic).then((m) => {
          const keep = o.y + before;
          o.asc = m.asc; o.desc = m.desc;
          o.y = keep - offsetOf_();
          this.forceRender.add(o.id);
          this.layout(o);
          this.emit("change");
        });
      } else if ("size" in patch || "lineHeight" in patch) {
        o.y = o.y + before - offsetOf_();
      }
    }
    if (isText) this.forceRender.add(o.id);
    this.layout(o);
    if (commit) this.pushHistory();
    this.emit("change");
    if (isText) this.emit("format");
    if (ed && this.editing === ed) {
      if (refocus || document.activeElement === ed.content) {
        ed.content.focus();
        if (keepSel) setSelectionOffsets(ed.content, keepSel.s, keepSel.e);
      }
      ed.lastSel = keepSel;
    }
  }

  removeObject(id, commit = true) {
    if (this.editing?.id === id) { clearTimeout(this.editing.timer); this.editing.ac.abort(); this.editing = null; }
    const i = this.objects.findIndex((o) => o.id === id);
    if (i < 0) return;
    this.objects.splice(i, 1);
    this.els?.get(id)?.remove();
    this.els?.delete(id);
    if (this.selected === id) this.selected = null;
    if (commit) this.pushHistory();
    this.emit("select", null);
    this.emit("change");
  }

  duplicateSelected() {
    const o = this.get(this.selected);
    if (!o) return;
    const copy = JSON.parse(JSON.stringify(o));
    delete copy.id;
    if (copy.points) copy.points = copy.points.map(([x, y]) => [x + 12, y + 12]);
    copy.x = (copy.x || 0) + 12;
    copy.y = (copy.y || 0) + 12;
    this.addObject(o.page, copy);
  }

  // ---------- history ----------
  snapshot() {
    return JSON.stringify(this.objects);
  }
  pushHistory(reset = false) {
    if (reset) this.history = [];
    this.history.push(this.snapshot());
    if (this.history.length > 100) this.history.shift();
    this.future = [];
    this.emit("history");
  }
  restore(json) {
    if (this.editing) { clearTimeout(this.editing.timer); this.editing.ac.abort(); this.editing = null; }
    this.objects = JSON.parse(json);
    this.selected = null;
    this.remountAll();
    this.emit("select", null);
    this.emit("change");
    this.emit("history");
  }
  undo() {
    if (this.history.length < 2) return;
    this.future.push(this.history.pop());
    this.restore(this.history[this.history.length - 1]);
  }
  redo() {
    if (!this.future.length) return;
    const s = this.future.pop();
    this.history.push(s);
    this.restore(s);
  }
  get canUndo() { return this.history.length > 1; }
  get canRedo() { return this.future.length > 0; }

  // ---------- DOM for objects ----------
  remountAll() {
    for (const pg of this.pages) pg.overlay.replaceChildren();
    this.els = new Map();
    for (const o of this.objects) this.mount(o);
  }

  bbox(o) {
    if (o.type === "ink") {
      const xs = o.points.map((p) => p[0]);
      const ys = o.points.map((p) => p[1]);
      const pad = (o.width || 2) / 2 + 2;
      return { x: Math.min(...xs) - pad, y: Math.min(...ys) - pad, w: Math.max(...xs) - Math.min(...xs) + pad * 2, h: Math.max(...ys) - Math.min(...ys) + pad * 2 };
    }
    return { x: o.x, y: o.y, w: o.w, h: o.h };
  }

  mount(o) {
    this.els ||= new Map();
    const pg = this.pages[o.page];
    const el = h("div.obj." + o.type, { "data-id": o.id, tabIndex: -1 });
    const content = h("div.content");
    el.append(content);
    this.els.set(o.id, el);
    pg.overlay.append(el);
    el.addEventListener("pointerdown", (e) => this.onObjDown(e, o.id));
    if (o.coverFor) el.dataset.cover = "1";
    this.layout(o);
    if (this.selected === o.id) this.decorate(o.id);
  }

  layout(o) {
    const el = this.els?.get(o.id);
    if (!el) return;
    const z = this.zoom;
    const content = el.querySelector(".content");
    const b = this.bbox(o);
    el.style.left = `${b.x * z}px`;
    el.style.top = `${b.y * z}px`;
    el.style.width = `${b.w * z}px`;
    if (o.type === "text") {
      el.style.height = "auto";
      const L = o.lineHeight || o.size * 1.2;
      Object.assign(content.style, {
        fontFamily: cssStack(o.font, !!o.bold, !!o.italic, o.text, this.origFor(o, !!o.bold, !!o.italic)),
        fontSize: `${o.size * z}px`,
        lineHeight: `${L * z}px`,
        // bold/italic come from the chosen face files, so never ask the browser to synthesize them
        fontWeight: "400",
        fontStyle: "normal",
        whiteSpace: o.wrap === false ? "pre" : "pre-wrap",
        color: o.color,
        letterSpacing: o.tracking ? `${o.tracking * z}px` : "",
      });
      content.style.setProperty("--gap", `${(o.paraSpace || 0) * z}px`);
      const ed = this.editing?.id === o.id ? this.editing : null;
      if (!ed || this.forceRender.has(o.id)) {
        this.forceRender.delete(o.id);
        renderRich(content, o, z, (sp, st) => this.styleSpan(sp, st, o));
      }
      o.h = Math.max(el.offsetHeight / z, L);
      this.ensureObjectFonts(o);
    } else if (o.type === "image") {
      el.style.height = `${b.h * z}px`;
      let img = content.firstChild;
      if (!img) {
        img = h("img", { draggable: false });
        content.append(img);
      }
      img.src = this.assets[o.asset]?.url || "";
      img.style.opacity = o.opacity ?? 1;
    } else if (o.type === "rect" || o.type === "redact" || o.type === "field") {
      el.style.height = `${b.h * z}px`;
      if (o.type === "redact") {
        content.style.background = "rgba(220,38,38,.28)";
        content.style.border = "2px dashed #dc2626";
      } else if (o.type === "field") {
        content.style.background = "rgba(37,99,235,.08)";
        content.style.border = "2px dashed #2563eb";
        content.dataset.label = o.label || "Sign here";
      } else {
        content.style.background = o.fill ? hexA(o.fill, o.opacity ?? 1) : "transparent";
        content.style.border = o.stroke ? `${(o.strokeWidth || 1) * z}px solid ${o.stroke}` : "none";
        content.style.mixBlendMode = o.blend || "normal";
      }
    } else if (o.type === "ink") {
      el.style.height = `${b.h * z}px`;
      const d = o.points.map((p, i) => `${i ? "L" : "M"}${(p[0] - b.x) * z},${(p[1] - b.y) * z}`).join(" ");
      content.innerHTML = `<svg width="${b.w * z}" height="${b.h * z}" style="overflow:visible"><path d="${d}" fill="none" stroke="${o.color}" stroke-width="${(o.width || 2) * z}" stroke-linecap="round" stroke-linejoin="round" pointer-events="stroke"/></svg>`;
    }
  }

  layoutAll() {
    for (const o of this.objects) this.layout(o);
  }

  // ---------- selection ----------
  select(id) {
    if (this.editing && this.editing.id !== id) this.endEdit();
    if (this.selected && this.selected !== id) {
      const prev = this.selected;
      this.undecorate(prev);
      this.revertIfUntouched(prev);
    }
    this.selected = id;
    if (id) this.decorate(id);
    this.emit("select", id ? this.get(id) : null);
  }

  decorate(id) {
    const el = this.els?.get(id);
    const o = this.get(id);
    if (!el || !o) return;
    el.classList.add("selected");
    el.querySelectorAll(".handle, .grip").forEach((n) => n.remove());
    if (o.type === "ink") return;
    if (o.type === "text") {
      const grip = h("div.grip", { title: "Drag to move", "aria-label": "Move text box", html: "✥" });
      grip.addEventListener("pointerdown", (e) => { e.stopPropagation(); e.preventDefault(); this.startMove(e, o); });
      el.append(grip);
    }
    for (const dir of ["nw", "ne", "sw", "se"]) {
      const hd = h("div.handle." + dir, { "data-dir": dir });
      hd.addEventListener("pointerdown", (e) => this.onHandleDown(e, id, dir));
      el.append(hd);
    }
  }

  undecorate(id) {
    const el = this.els?.get(id);
    if (!el) return;
    el.classList.remove("selected");
    el.querySelectorAll(".handle, .grip").forEach((n) => n.remove());
  }

  // ---------- pointer interactions ----------
  pt(e, pg) {
    const r = pg.overlay.getBoundingClientRect();
    return { x: (e.clientX - r.left) / this.zoom, y: (e.clientY - r.top) / this.zoom };
  }

  onOverlayDown(e, pg) {
    if (e.target !== pg.overlay) return;
    const p = this.pt(e, pg);
    const tool = this.tool;
    if (tool === "select") {
      this.select(null);
      return;
    }
    e.preventDefault();
    if (tool === "text") {
      const s = this.style;
      const o = this.addObject(pg.index, { type: "text", x: p.x, y: p.y, w: 180, h: s.size * 1.2, text: "Text", font: s.font, bold: s.bold, italic: s.italic, size: s.size, color: s.color, align: s.align }, { commit: false });
      this.beginTextEdit(o.id, { selectAll: true });
      this.emit("tool-done");
    } else if (tool === "image" && this.pendingImage) {
      const { asset, w, h: ih } = this.pendingImage;
      const width = Math.min(220, w);
      const height = (width / w) * ih;
      this.addObject(pg.index, { type: "image", asset, x: p.x - width / 2, y: p.y - height / 2, w: width, h: height });
      this.pendingImage = null;
      this.setTool("select");
      this.emit("tool-done");
    } else if (["rect", "highlight", "whiteout", "redact", "field"].includes(tool)) {
      this.beginDrag(e, pg, p, tool);
    } else if (tool === "draw") {
      this.beginInk(e, pg, p);
    }
  }

  beginDrag(e, pg, start, tool) {
    const s = this.style;
    const base =
      tool === "highlight" ? { type: "rect", fill: "#ffe14d", opacity: 1, blend: "multiply", subtype: "highlight" }
      : tool === "whiteout" ? { type: "rect", fill: "#ffffff", opacity: 1, subtype: "whiteout" }
      : tool === "redact" ? { type: "redact" }
      : tool === "field" ? { type: "field", label: "Sign here" }
      : { type: "rect", fill: null, stroke: s.stroke, strokeWidth: s.width, subtype: "shape" };
    if (tool === "highlight") base.fill = s.fill;
    const o = this.addObject(pg.index, { ...base, x: start.x, y: start.y, w: 1, h: 1 }, { select: false, commit: false });
    const move = (ev) => {
      const q = this.pt(ev, pg);
      this.updateObject(o.id, { x: Math.min(start.x, q.x), y: Math.min(start.y, q.y), w: Math.max(1, Math.abs(q.x - start.x)), h: Math.max(1, Math.abs(q.y - start.y)) }, { commit: false });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const cur = this.get(o.id);
      if (cur && (cur.w < 4 || cur.h < 4)) this.removeObject(o.id, false);
      else this.pushHistory();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  beginInk(e, pg, start) {
    const s = this.style;
    const o = this.addObject(pg.index, { type: "ink", points: [[start.x, start.y], [start.x + 0.01, start.y + 0.01]], color: s.stroke === "#e11d48" ? "#111827" : s.stroke, width: s.width }, { select: false, commit: false });
    const move = (ev) => {
      const q = this.pt(ev, pg);
      o.points.push([q.x, q.y]);
      this.layout(o);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      this.pushHistory();
      this.emit("change");
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  onObjDown(e, id) {
    if (e.target.classList.contains("handle") || e.target.closest(".grip")) return;
    const o = this.get(id);
    if (!o) return;
    if (o.type === "text") {
      // inside a box that is being edited the browser handles caret placement and text selection
      if (this.editing?.id === id) return;
      e.preventDefault();
      e.stopPropagation();
      if (this.tool !== "select" && this.tool !== "edit-text") this.setTool("select");
      this.beginTextEdit(id, { point: { x: e.clientX, y: e.clientY } });
      return;
    }
    e.stopPropagation();
    if (this.tool !== "select") this.setTool("select");
    this.select(id);
    this.startMove(e, o);
  }

  startMove(e, o) {
    const pg = this.pages[o.page];
    const start = this.pt(e, pg);
    const orig = o.type === "ink" ? o.points.map((p) => [...p]) : { x: o.x, y: o.y };
    let moved = false;
    const move = (ev) => {
      const q = this.pt(ev, pg);
      const dx = q.x - start.x;
      const dy = q.y - start.y;
      if (!moved && Math.hypot(dx, dy) * this.zoom < 3) return;
      moved = true;
      if (o.type === "ink") o.points = orig.map(([x, y]) => [x + dx, y + dy]);
      else {
        o.x = orig.x + dx;
        o.y = orig.y + dy;
      }
      this.layout(o);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (moved) {
        this.pushHistory();
        this.emit("change");
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  onHandleDown(e, id, dir) {
    e.stopPropagation();
    e.preventDefault();
    const o = this.get(id);
    const pg = this.pages[o.page];
    const start = this.pt(e, pg);
    const orig = { x: o.x, y: o.y, w: o.w, h: o.h };
    const keepAspect = o.type === "image" && !e.shiftKey;
    const ratio = orig.w / orig.h;
    const move = (ev) => {
      const q = this.pt(ev, pg);
      let dx = q.x - start.x;
      let dy = q.y - start.y;
      let { x, y, w, h: hh } = orig;
      if (dir.includes("e")) w = Math.max(8, orig.w + dx);
      if (dir.includes("w")) { w = Math.max(8, orig.w - dx); x = orig.x + orig.w - w; }
      if (dir.includes("s")) hh = Math.max(8, orig.h + dy);
      if (dir.includes("n")) { hh = Math.max(8, orig.h - dy); y = orig.y + orig.h - hh; }
      if (keepAspect) {
        hh = w / ratio;
        if (dir.includes("n")) y = orig.y + orig.h - hh;
      }
      if (o.type === "text") { hh = o.h; y = orig.y; }
      Object.assign(o, { x, y, w, h: hh });
      this.layout(o);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      this.pushHistory();
      this.emit("change");
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  // ---------- text editing ----------
  /** The PDF's own font faces, only when the requested style is the one the original text used. */
  origFor(o, b, i) {
    if (!o.useOrig) return [];
    if (o.origV) return o.origV[`${+b}${+i}`] || [];
    if (!o.origFaces?.length) return [];
    return b === (o.ob ?? !!o.bold) && i === (o.oi ?? !!o.italic) ? o.origFaces : [];
  }

  /** Every embedded font id a text object may use. */
  origIdsOf(o) {
    return [...new Set([...(o.origFaces || []), ...Object.values(o.origV || {}).flat()])];
  }

  styleSpan(sp, st, o) {
    const b = st.b ?? !!o.bold;
    const i = st.i ?? !!o.italic;
    sp.style.fontFamily = cssStack(o.font, b, i, o.text, this.origFor(o, b, i));
    if (st.c) sp.style.color = st.c;
    if (st.u) sp.style.textDecoration = "underline";
    if (st.l) {
      sp.title = st.l.startsWith("#page=") ? `Page ${st.l.slice(6)} (Ctrl/⌘+click to go)` : `${st.l} (Ctrl/⌘+click to open)`;
      sp.style.cursor = "pointer";
    }
  }

  /** Every (bold, italic) combination a text object uses. */
  variantsOf(o) {
    const base = baseStyle(o);
    const set = new Map([[`${+base.b}${+base.i}`, [base.b, base.i]]]);
    for (const r of o.fmt || []) {
      const b = r.b ?? base.b, i = r.i ?? base.i;
      set.set(`${+b}${+i}`, [b, i]);
    }
    return [...set.values()];
  }

  ensureObjectFonts(o) {
    const variants = this.variantsOf(o);
    const key = `${o.font}|${variants.map((v) => v.map(Number).join("")).join(",")}|${/[Ͱ-ԯἀ-῿]/.test(o.text || "") ? "x" : ""}|${o.useOrig ? this.origIdsOf(o).join(",") : ""}`;
    if (this.fontKeys.has(key)) return;
    this.fontKeys.add(key);
    const jobs = variants.map(([b, i]) => ensureFonts(o.font, b, i, o.text || ""));
    if (o.useOrig) for (const id of this.origIdsOf(o)) if (this.fontData[id]) jobs.push(registerOriginalFace(id, this.fontData[id]).catch(() => {}));
    Promise.all(jobs).then(() => this.layout(o)).catch((e) => { this.fontKeys.delete(key); console.warn("font load failed", e); });
  }

  /**
   * Font programs embedded in the PDF that belong to the same typeface and style as `fontId`
   * (subsets of ArialMT on one page are merged so more characters are covered). Own font first.
   */
  originalFaces(pg, fontId) {
    const info = (id) => this.pdfFontInfo(pg, id);
    const norm = (n) => n.replace(/^[A-Z]{6}\+/, "").replace(/-\d+$/, "").toLowerCase();
    const own = info(fontId);
    if (!own.name) return [];
    const ids = new Set([fontId]);
    for (const b of this.blocks.get(pg.index) || []) for (const l of b.lines) for (const r of l.runs) if (r.font && !ids.has(r.font) && norm(info(r.font).name) === norm(own.name)) ids.add(r.font);
    const out = [];
    for (const id of ids) {
      try {
        const data = pg.page.commonObjs.get(id)?.data;
        if (data && data.length > 100) {
          if (!this.fontData[id]) this.fontData[id] = new Uint8Array(data); // private copy
          out.push(id);
        }
      } catch { /* not available */ }
    }
    return out;
  }

  /** Place the caret where the user clicked (viewport coordinates), if that point is inside `content`. */
  caretAtPoint(content, point) {
    let node = null, offset = 0;
    if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(point.x, point.y);
      if (p) { node = p.offsetNode; offset = p.offset; }
    } else if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(point.x, point.y);
      if (r) { node = r.startContainer; offset = r.startOffset; }
    }
    if (!node || !content.contains(node)) return false;
    const r = document.createRange();
    r.setStart(node, offset);
    r.collapse(true);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    return true;
  }

  stateKey(o) {
    const defaultPara = (p) => !p || (!p.list && !p.indent && (!p.align || p.align === (o.align || "left")));
    const paras = (o.paras || []).every(defaultPara) ? [] : o.paras;
    return JSON.stringify([o.text, o.font, !!o.bold, !!o.italic, o.size, o.color, o.align || "left", o.fmt || [], paras, o.lineHeight, o.tracking || 0, o.paraSpace || 0, !!o.useOrig]);
  }

  /** Read the live DOM of the box being edited back into the model. */
  syncFromDom(o) {
    const ed = this.editing;
    if (!ed || ed.id !== o.id || !ed.content.isConnected) return;
    const r = parseRich(ed.content, o);
    o.text = r.text;
    o.fmt = r.fmt;
    o.paras = r.paras;
    const el = this.els.get(o.id);
    o.h = Math.max(el.offsetHeight / this.zoom, o.lineHeight || o.size * 1.2);
  }

  beginTextEdit(id, { point = null, selectAll = false } = {}) {
    const o = this.get(id);
    const el = this.els?.get(id);
    if (!o || !el) return;
    if (this.editing?.id === id) return;
    this.select(id);
    const content = el.querySelector(".content");
    const ac = new AbortController();
    const ed = { id, content, ac, start: this.stateKey(o), lastSel: null, timer: null };
    this.editing = ed;
    el.classList.add("editing");
    content.dataset.editing = "1";
    content.contentEditable = "true";
    content.spellcheck = false;
    this.forceRender.add(id);
    this.layout(o);
    content.focus();
    if (selectAll) {
      const r = document.createRange();
      r.selectNodeContents(content);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    } else if (!(point && this.caretAtPoint(content, point))) {
      const r = document.createRange();
      r.selectNodeContents(content);
      r.collapse(false);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    }
    ed.lastSel = selectionOffsets(content);
    const opt = { signal: ac.signal };
    content.addEventListener("input", () => {
      this.syncFromDom(o);
      content.querySelectorAll(":scope > div").forEach((d) => { if (!d.className) d.className = "p"; });
      clearTimeout(ed.timer);
      ed.timer = setTimeout(() => { if (this.editing === ed) { this.syncFromDom(o); this.pushHistory(); } }, 700);
      this.emit("change");
      this.emit("format");
    }, opt);
    content.addEventListener("click", (e) => {
      const el = e.target.closest?.("[data-l]");
      if (el && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.openLink(el.dataset.l); }
    }, opt);
    content.addEventListener("paste", (e) => {
      e.preventDefault();
      document.execCommand("insertText", false, (e.clipboardData?.getData("text/plain") || "").replace(/\r\n?/g, "\n"));
    }, opt);
    content.addEventListener("keydown", (e) => {
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (e.key === "Escape" || (mod && e.key === "Enter")) { this.endEdit(); }
      else if (mod && !e.shiftKey && (k === "b" || k === "i" || k === "u")) { e.preventDefault(); this.toggleFormat(k); }
      else if (mod && !e.shiftKey && k === "k") { e.preventDefault(); this.emit("link-request"); }
      else if (e.key === "Tab") { e.preventDefault(); this.changeIndent(e.shiftKey ? -1 : 1); }
      else if (mod && k === "a") { /* native select-all inside the box */ }
      e.stopPropagation();
    }, opt);
    document.addEventListener("selectionchange", () => {
      const live = this.liveSelection(ed);
      if (live) { ed.lastSel = live; this.emit("format"); }
    }, opt);
    this.emit("format");
  }

  /** Finish editing: save the box's content into the model (or delete the box if it is empty). */
  endEdit() {
    const ed = this.editing;
    if (!ed) return;
    clearTimeout(ed.timer);
    ed.ac.abort();
    const o = this.get(ed.id);
    const el = this.els?.get(ed.id);
    if (o && ed.content.isConnected) {
      this.syncFromDom(o);
      this.editing = null;
      ed.content.removeAttribute("contenteditable");
      delete ed.content.dataset.editing;
      el?.classList.remove("editing");
      if (!(o.text || "").trim()) { this.removeObject(o.id); return; }
      if (o.wrap === false) {
        const need = ed.content.scrollWidth / this.zoom;
        if (need > o.w + 0.5) {
          const a = o.paras?.[0]?.align || o.align;
          if (a === "right") o.x -= need - o.w;
          else if (a === "center") o.x -= (need - o.w) / 2;
          o.w = need;
        }
      }
      this.layout(o);
      if (this.stateKey(o) !== ed.start) {
        this.pushHistory();
        this.emit("change");
      }
      this.emit("select", o);
    }
    this.editing = null;
    this.emit("format");
  }

  // ---------- formatting commands (Word-style) ----------
  /** Selection inside the box being edited — only trusted while the box has focus (re-renders collapse it otherwise). */
  liveSelection(ed) {
    return document.activeElement === ed.content ? selectionOffsets(ed.content) : null;
  }

  /** Text object a command applies to + the current selection range when editing. */
  fmtTarget() {
    const ed = this.editing;
    const o = ed ? this.get(ed.id) : this.get(this.selected);
    if (!o || o.type !== "text") return null;
    if (ed) {
      this.syncFromDom(o);
      const live = this.liveSelection(ed);
      if (live) ed.lastSel = live;
    }
    return { o, ed, sel: ed?.lastSel || null };
  }

  afterFormat(o, ed, { refocus = true, commit = true } = {}) {
    const keep = ed?.lastSel ? { ...ed.lastSel } : null;
    this.forceRender.add(o.id);
    this.layout(o);
    if (ed && this.editing === ed) {
      // re-rendering collapses the DOM selection: restore it whenever the box has (or should get) focus
      if (refocus || document.activeElement === ed.content) {
        ed.content.focus();
        if (keep) setSelectionOffsets(ed.content, keep.s, keep.e);
      }
      ed.lastSel = keep;
    }
    if (commit) this.pushHistory();
    this.emit("change");
    this.emit("format");
  }

  /** Current formatting at the selection/caret (for the toolbar's active states). */
  formatState() {
    const t = this.fmtTarget();
    if (!t) return null;
    const { o, sel } = t;
    const base = baseStyle(o);
    const s = sel ? sel.s : 0;
    const e = sel ? sel.e : 0;
    let b = base.b, i = base.i, u = false, c = base.c;
    if (sel && e > s) {
      b = allHave(o, s, e, "b"); i = allHave(o, s, e, "i"); u = allHave(o, s, e, "u");
      c = styleAt(o, s).c;
    } else if (sel) {
      const st = styleAt(o, Math.max(0, s - (o.text[s - 1] && o.text[s - 1] !== "\n" ? 1 : 0)));
      ({ b, i, u, c } = st);
    } else {
      const n = (o.text || "").length;
      u = allHave(o, 0, n, "u");
    }
    const idx = parasInRange(o.text, s, e)[0] ?? 0;
    const lk = linkRange(o, sel ? s : 0);
    return { o, hasSelection: !!sel && e > s, b, i, u, c, para: paraAttrs(o, idx), editing: !!t.ed, link: !!lk && (!sel || (s >= lk.s && s <= lk.e)) };
  }

  toggleFormat(key) {
    const t = this.fmtTarget();
    if (!t) return;
    const { o, ed, sel } = t;
    if (sel && sel.e > sel.s) {
      applyFmt(o, sel.s, sel.e, { [key]: !allHave(o, sel.s, sel.e, key) });
      return this.afterFormat(o, ed);
    }
    if (key === "u") {
      const n = (o.text || "").length;
      applyFmt(o, 0, n, { u: !allHave(o, 0, n, "u") });
      return this.afterFormat(o, ed);
    }
    // no selection: format the whole box
    this.updateObject(o.id, key === "b" ? { bold: !o.bold } : { italic: !o.italic }, { refocus: true });
  }

  setColor(color, { refocus = true, commit = true } = {}) {
    const t = this.fmtTarget();
    if (!t) { this.style.color = color; return; }
    const { o, ed, sel } = t;
    if (sel && sel.e > sel.s) {
      applyFmt(o, sel.s, sel.e, { c: color });
      return this.afterFormat(o, ed, { refocus, commit });
    }
    this.updateObject(o.id, { color }, { refocus, commit });
  }

  /** Give the keyboard focus (and selection) back to the box being edited, e.g. after a colour picker closes. */
  refocusEditing() {
    const ed = this.editing;
    if (!ed) return;
    ed.content.focus();
    if (ed.lastSel) setSelectionOffsets(ed.content, ed.lastSel.s, ed.lastSel.e);
  }

  /** Paragraph indices a paragraph command applies to. */
  targetParas(o, sel) {
    const n = String(o.text || "").split("\n").length;
    // a real selection → just the paragraphs it touches; a bare caret → the whole box (same rule as bold/italic)
    if (sel && sel.e > sel.s) return parasInRange(o.text, sel.s, sel.e);
    return Array.from({ length: n }, (_, i) => i);
  }

  setParaAttr(patchFn) {
    const t = this.fmtTarget();
    if (!t) return;
    const { o, ed, sel } = t;
    const n = String(o.text || "").split("\n").length;
    o.paras = Array.from({ length: n }, (_, i) => ({ ...(o.paras?.[i] || { align: o.align || "left" }) }));
    for (const i of this.targetParas(o, sel)) patchFn(o.paras[i], i);
    this.afterFormat(o, ed);
  }

  setAlign(align) {
    this.setParaAttr((p) => { p.align = align; });
    const o = this.get(this.editing?.id ?? this.selected);
    if (o && !this.editing) o.align = align;
  }

  toggleList(kind) {
    const t = this.fmtTarget();
    if (!t) return;
    const idxs = this.targetParas(t.o, t.sel);
    const all = idxs.every((i) => t.o.paras?.[i]?.list === kind);
    this.setParaAttr((p) => { p.list = all ? null : kind; });
  }

  changeIndent(delta) {
    this.setParaAttr((p) => { p.indent = Math.max(0, Math.min(8, (p.indent || 0) + delta)); });
  }

  trimSpaces() {
    const t = this.fmtTarget();
    if (!t) return;
    const changed = trimModel(t.o);
    if (!changed) return this.emit("toast", "No extra spaces found.");
    if (t.ed) t.ed.lastSel = null;
    this.afterFormat(t.o, t.ed);
  }

  /** Follow a link: external addresses open in a new tab, "#page=N" scrolls to that page. */
  openLink(url) {
    const pg = /^#page=(\d+)$/.exec(url || "");
    if (pg) return this.scrollToPage(+pg[1] - 1);
    if (/^(https?:|mailto:|tel:)/i.test(url || "")) window.open(url, "_blank", "noopener,noreferrer");
  }

  /** What the Insert-link dialog needs: the text being linked, an existing address (if any), and the range. */
  linkContext() {
    const t = this.fmtTarget();
    if (!t) return null;
    const { o, ed, sel } = t;
    const len = (o.text || "").length;
    let range = { s: 0, e: len };
    let url = "";
    if (sel && sel.e > sel.s) {
      range = { s: sel.s, e: sel.e };
      const lr = linkRange(o, sel.s);
      if (lr && lr.s <= sel.s && lr.e >= sel.e) { url = lr.url; range = { s: lr.s, e: lr.e }; }
    } else if (sel) {
      const lr = linkRange(o, sel.s);
      range = lr ? { s: lr.s, e: lr.e } : { s: sel.s, e: sel.s };
      url = lr?.url || "";
    }
    return { o, ed, range, text: o.text.slice(range.s, range.e), url, pageCount: this.doc.numPages };
  }

  applyLink({ text, url }) {
    const ctx = this.linkContext();
    if (!ctx) return;
    const { o, ed, range } = ctx;
    const typed = String(text ?? "").replace(/\n/g, " ");
    const label = typed.trim() ? typed : url.startsWith("#page=") ? `Page ${url.slice(6)}` : url;
    const r = replaceRange(o, range.s, range.e, label, { l: url, u: true, c: LINK_COLOR });
    if (ed) ed.lastSel = { s: r.e, e: r.e };
    this.afterFormat(o, ed);
  }

  removeLink() {
    const ctx = this.linkContext();
    if (!ctx || !ctx.url) return;
    const { o, ed, range } = ctx;
    const arr = charStyles(o);
    for (let k = range.s; k < range.e; k++) {
      const st = { ...(arr[k] || {}) };
      delete st.l; delete st.u;
      if (st.c && st.c.toLowerCase() === LINK_COLOR) delete st.c;
      arr[k] = st;
    }
    o.fmt = compressStyles(arr, o);
    this.afterFormat(o, ed);
  }

  clearFormatting() {
    const t = this.fmtTarget();
    if (!t) return;
    const { o, ed, sel } = t;
    if (sel && sel.e > sel.s) {
      const arr = charStyles(o);
      for (let k = sel.s; k < sel.e; k++) arr[k] = null;
      o.fmt = compressStyles(arr, o);
    } else {
      o.fmt = [];
    }
    this.afterFormat(o, ed);
  }

  pdfFontInfo(pg, id) {
    try {
      if (id && pg.page.commonObjs.has(id)) {
        const f = pg.page.commonObjs.get(id);
        return { name: f.name || "", serif: !!f.isSerifFont, mono: !!f.isMonospace };
      }
    } catch { /* font object not resolved */ }
    return { name: "", serif: false, mono: false };
  }

  /** Dominant background colour and ink colour inside a box (points, top-left origin). */
  sampleColors(pg, box) {
    const fallback = { bg: "#ffffff", fg: "#000000" };
    try {
      const c = pg.canvas;
      const k = c.width / pg.box.w;
      const x = Math.max(0, Math.floor(box.x * k)), y = Math.max(0, Math.floor(box.y * k));
      const w = Math.min(c.width - x, Math.ceil(box.w * k)), hh = Math.min(c.height - y, Math.ceil(box.h * k));
      if (w < 2 || hh < 2 || w * hh > 2_000_000) return fallback;
      const d = c.getContext("2d").getImageData(x, y, w, hh).data;
      const hist = new Map();
      for (let i = 0; i < d.length; i += 4) {
        const key = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
        hist.set(key, (hist.get(key) || 0) + 1);
      }
      const bgKey = [...hist.entries()].sort((a, b) => b[1] - a[1])[0][0];
      let br = 0, bgc = 0, bb = 0, bn = 0;
      for (let i = 0; i < d.length; i += 4) {
        const key = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
        if (key === bgKey) { br += d[i]; bgc += d[i + 1]; bb += d[i + 2]; bn++; }
      }
      const bg = [br / bn, bgc / bn, bb / bn];
      let max = 0;
      const dist = (i) => Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]);
      for (let i = 0; i < d.length; i += 4) max = Math.max(max, dist(i));
      const hex = (v) => Math.round(v).toString(16).padStart(2, "0");
      const bgHex = "#" + bg.map(hex).join("");
      if (max < 60) return { bg: bgHex, fg: (bg[0] + bg[1] + bg[2]) / 3 > 128 ? "#000000" : "#ffffff" };
      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) if (dist(i) >= max * 0.85) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
      return { bg: bgHex, fg: "#" + [r / n, g / n, b / n].map(hex).join("") };
    } catch {
      return fallback;
    }
  }

  /**
   * Click on PDF text: cover the original, and put an editable text box in its place with the matching
   * font, size, line spacing, colour and position. Untouched boxes are removed again when you click away.
   */
  async activateBlock(pg, block, key, point = null) {
    const existing = this.objects.find((o) => o.srcBlock === key && o.type === "text");
    if (existing) {
      this.beginTextEdit(existing.id, { point });
      return;
    }
    if (this.activating) return;
    this.activating = true;
    try {
      await this.renderPage(pg);
      const info = this.pdfFontInfo(pg, block.font);
      const fontName = info.name;
      const m = matchFont(fontName, info);
      const vk = (b, i) => `${+b}${+i}`;
      // all embedded font programs the block uses, grouped by their bold/italic variant
      const origV = {};
      const fontIds = [block.font, ...new Set(block.spans.map((sp) => sp.font).filter((f) => f && f !== block.font))];
      for (const fid of fontIds) {
        const inf = this.pdfFontInfo(pg, fid);
        const mm = matchFont(inf.name, inf);
        for (const id of this.originalFaces(pg, fid)) {
          const list = (origV[vk(mm.bold, mm.italic)] ||= []);
          if (!list.includes(id)) list.push(id);
        }
      }
      const registered = new Set();
      for (const list of Object.values(origV)) {
        for (const id of [...list]) {
          if (registered.has(id)) continue;
          registered.add(id);
          try { await registerOriginalFace(id, this.fontData[id]); } catch { for (const l of Object.values(origV)) { const k = l.indexOf(id); if (k >= 0) l.splice(k, 1); } }
        }
      }
      const baseKey = vk(m.bold, m.italic);
      const origOk = origV[baseKey] || [];
      const origMetrics = origOk.length ? programMetrics(this.fontData[origOk[0]]) : null;
      const useOrig = Object.values(origV).some((l) => l.length) && (!!origMetrics || !origOk.length);
      const [bundled] = await Promise.all([metricsFor(m.family, m.bold, m.italic), ensureFonts(m.family, m.bold, m.italic, block.text)]);
      const metrics = origMetrics || bundled;
      // per-run bold/italic (e.g. a bold label followed by regular text) becomes character formatting
      const spanStyles = new Array(block.text.length).fill(null);
      for (const sp of block.spans) {
        const inf = this.pdfFontInfo(pg, sp.font);
        const mm = matchFont(inf.name, inf);
        if (mm.bold !== m.bold || mm.italic !== m.italic) for (let k = sp.start; k < Math.min(sp.end, spanStyles.length); k++) spanStyles[k] = { b: mm.bold, i: mm.italic };
      }
      const { bg, fg } = this.sampleColors(pg, { x: block.x, y: block.top, w: block.w, h: block.h });
      const size = Math.round(block.size * 10) / 10;
      const L = Math.round(block.lineHeight * 100) / 100;
      const y = block.baseline1 - baselineOffset(size, L, metrics.asc, metrics.desc);
      this.select(null);
      this.addObject(pg.index, { type: "rect", subtype: "whiteout", coverFor: key, strip: { x: block.x - 1.5, y: block.top, w: block.w + 3, h: block.h }, fill: bg, opacity: 1, x: block.x - 2, y: block.top - 1.5, w: block.w + 4, h: block.h + 3 }, { select: false, commit: false });
      const single = block.lines.length === 1;
      const o = this.addObject(pg.index, {
        type: "text", srcBlock: key, x: block.x, y, w: block.paragraph ? block.w * 1.03 + 0.5 : block.w + 1,
        h: L, text: block.text, font: m.family, bold: m.bold, italic: m.italic, size, lineHeight: L,
        asc: metrics.asc, desc: metrics.desc, color: fg, align: single ? block.align : "left", wrap: block.paragraph ? true : false,
        origFont: fontName.replace(/^[A-Z]{6}\+/, ""),
        useOrig, origV: useOrig ? origV : undefined, origFaces: useOrig ? origOk : [], ob: m.bold, oi: m.italic,
      }, { commit: false });
      o.fmt = compressStyles(spanStyles, o);
      o.origKey = this.stateKey(o);
      o.tentative = true;
      this.beginTextEdit(o.id, { point });
    } finally {
      this.activating = false;
    }
  }

  isTouched(o) {
    return !o.origKey || this.stateKey(o) !== o.origKey;
  }

  /** Remove an auto-created text box (and its cover) if the user never changed anything. */
  revertIfUntouched(id) {
    const o = this.get(id);
    if (!o || !o.tentative) return;
    if (this.isTouched(o)) { o.tentative = false; return; }
    const cover = this.objects.find((c) => c.coverFor === o.srcBlock);
    this.removeObject(o.id, false);
    if (cover) this.removeObject(cover.id, false);
    this.emit("change");
  }

  // ---------- keyboard ----------
  onKey(e) {
    const tag = document.activeElement?.tagName;
    const editing = document.activeElement?.isContentEditable || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !editing) {
      e.preventDefault();
      e.shiftKey ? this.redo() : this.undo();
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "y" && !editing) {
      e.preventDefault();
      this.redo();
    } else if (!editing && this.selected) {
      const o = this.get(this.selected);
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        this.removeObject(this.selected);
      } else if (e.key.startsWith("Arrow") && o) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        if (o.type === "ink") o.points = o.points.map(([x, y]) => [x + dx, y + dy]);
        else { o.x += dx; o.y += dy; }
        this.layout(o);
        this.pushHistory();
        this.emit("change");
      } else if (e.key === "Escape") {
        this.select(null);
      }
    }
  }

  // ---------- export ----------
  /** Objects that should be written into the PDF (placeholders and redactions excluded). */
  exportEdits() {
    const byPage = {};
    for (const o of this.objects) {
      if (o.type === "field" || o.type === "redact") continue;
      (byPage[o.page] ||= []).push(o);
    }
    const assets = {};
    for (const [id, a] of Object.entries(this.assets)) assets[id] = { bytes: a.bytes, mime: a.mime };
    const fontData = {};
    for (const o of this.objects) if (o.type === "text" && o.useOrig) for (const id of this.origIdsOf(o)) if (this.fontData[id]) fontData[id] = this.fontData[id];
    return { editsByPage: byPage, assets, fontData };
  }

  get hasEdits() {
    return this.objects.some((o) => o.type !== "field" && o.type !== "redact");
  }
}
