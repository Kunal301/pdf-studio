// Pure text-structure helpers (no DOM): visual lines, column segments and paragraph blocks.

export function groupLines(runs, tol = 0.5) {
  const sorted = [...runs].sort((p, q) => p.baseline - q.baseline || p.x - q.x);
  const lines = [];
  for (const r of sorted) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.baseline - r.baseline) <= Math.max(2, r.size * tol)) {
      last.runs.push(r);
      last.size = Math.max(last.size, r.size);
    } else {
      lines.push({ baseline: r.baseline, size: r.size, runs: [r] });
    }
  }
  for (const l of lines) l.runs.sort((p, q) => p.x - q.x);
  return lines;
}

export function joinRuns(runs) {
  let s = "";
  let prevEnd = null;
  for (const r of runs) {
    if (prevEnd != null && r.x - prevEnd > r.size * 0.15 && !s.endsWith(" ") && !r.str.startsWith(" ")) s += " ";
    s += r.str;
    prevEnd = r.x + r.w;
  }
  return s;
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

/** joinRuns, plus where each run's characters sit in the joined string (to recover per-run fonts). */
export function joinRunsWithSpans(runs) {
  let s = "";
  const spans = [];
  let prevEnd = null;
  for (const r of runs) {
    if (prevEnd != null && r.x - prevEnd > r.size * 0.15 && !s.endsWith(" ") && !r.str.startsWith(" ")) s += " ";
    spans.push({ start: s.length, end: s.length + r.str.length, font: r.font });
    s += r.str;
    prevEnd = r.x + r.w;
  }
  return { text: s, spans };
}

/** Split each visual line into segments wherever there is a column-sized gap. */
function toSegments(lines) {
  const segs = [];
  for (const line of lines) {
    let cur = [];
    const flush = () => {
      if (!cur.length) return;
      const last = cur[cur.length - 1];
      const size = Math.max(...cur.map((r) => r.size));
      const joined = joinRunsWithSpans(cur);
      segs.push({
        runs: cur,
        text: joined.text,
        spans: joined.spans,
        x: cur[0].x,
        right: last.x + last.w,
        baseline: cur.reduce((a, r) => (r.size >= a.size ? r : a), cur[0]).baseline,
        size,
        top: Math.min(...cur.map((r) => r.top)),
        font: cur.reduce((a, r) => (r.str.trim().length > (a.n || 0) ? { n: r.str.trim().length, f: r.font } : a), {}).f,
      });
      cur = [];
    };
    for (const r of line.runs) {
      const prev = cur[cur.length - 1];
      if (prev && r.x - (prev.x + prev.w) > Math.max(r.size * 1.2, 8)) flush();
      cur.push(r);
    }
    flush();
  }
  return segs.filter((s) => s.text.trim());
}

/**
 * Build editable text blocks: stacked, left-aligned segments of similar size form one block
 * (a paragraph or a short multi-line text), so a click edits the whole thing.
 */
export function buildBlocks(runs, { pageWidth = 0 } = {}) {
  const segs = toSegments(groupLines(runs, 0.28));
  const blocks = [];
  for (const s of segs) {
    let best = null;
    let bestDy = Infinity;
    for (const b of blocks) {
      const l = b.lines[b.lines.length - 1];
      const dy = s.baseline - l.baseline;
      if (dy < s.size * 0.8 || dy > s.size * 2.1) continue;
      if (Math.abs(s.size - l.size) > s.size * 0.12) continue;
      if (s.font !== l.font) continue; // e.g. a bold heading above regular body text stays its own block
      if (Math.abs(s.x - l.x) > s.size * 0.8) continue;
      if (dy < bestDy) { best = b; bestDy = dy; }
    }
    if (best) best.lines.push(s);
    else blocks.push({ lines: [s] });
  }
  for (const b of blocks) {
    const ls = b.lines;
    b.x = Math.min(...ls.map((l) => l.x));
    b.right = Math.max(...ls.map((l) => l.right));
    b.w = b.right - b.x;
    b.top = Math.min(...ls.map((l) => l.top));
    b.size = median(ls.map((l) => l.size));
    b.baseline1 = ls[0].baseline;
    b.bottom = ls[ls.length - 1].baseline + b.size * 0.3;
    b.h = b.bottom - b.top;
    b.font = ls[0].font;
    b.lineHeight = ls.length > 1 ? median(ls.slice(1).map((l, i) => l.baseline - ls[i].baseline)) : b.size * 1.2;
    // wrapped paragraph = every line except the last fills most of the block width
    b.paragraph = ls.length > 1 && ls.slice(0, -1).every((l) => l.right - b.x >= b.w * 0.85);
    b.text = ls.map((l) => l.text).join(b.paragraph ? " " : "\n");
    b.spans = [];
    let off = 0;
    for (const l of ls) {
      for (const sp of l.spans) b.spans.push({ start: off + sp.start, end: off + sp.end, font: sp.font });
      off += l.text.length + 1;
    }
    b.align = "left";
  }
  // right-aligned single lines (e.g. amounts): another line ends at the same x but starts elsewhere
  for (const b of blocks) {
    if (b.lines.length !== 1) continue;
    const l = b.lines[0];
    const twin = blocks.some((o) => o !== b && o.lines.some((m) => Math.abs(m.right - l.right) < 0.8 && Math.abs(m.x - l.x) > 2 && Math.abs(m.baseline - l.baseline) < l.size * 15));
    if (twin) b.align = "right";
    else if (pageWidth && Math.abs((l.x + l.right) / 2 - pageWidth / 2) < 2.5 && b.w < pageWidth * 0.8 && l.x > pageWidth * 0.08) b.align = "center";
  }
  blocks.sort((p, q) => p.top - q.top || p.x - q.x);
  return blocks;
}
