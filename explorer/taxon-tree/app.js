import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm";

const API = "https://api.inaturalist.org/v1";
const OPEN_TREE_TNRS = "https://api.opentreeoflife.org/v3/tnrs/match_names";
const TIMETREE_MRCA = "https://timetree.org/api/mrca/id";
/** Public CORS relay (used only if the browser cannot read TimeTree directly). */
const ALL_ORIGINS_RAW = "https://api.allorigins.win/raw?url=";

const TAXA_FETCH_CHUNK = 40;
const TNRS_CHUNK = 80;
const TIMETREE_REQUEST_GAP_MS = 110;

const M = { top: 36, right: 40, bottom: 36, left: 36 };
/** Base horizontal spacing between sibling columns (d3 tree “breadth”); separation scales this up from label width. */
const NODE_BREADTH = 52;
/** Base vertical spacing between parent and child rows (d3 tree “depth”). */
const NODE_DEPTH = 74;
/** Horizontal gap from node dot outer edge to start of label text (px). */
const LABEL_GAP_FROM_DOT = 3;
/** Extra vertical slack for collision boxes vs measured text. */
const LABEL_VPAD = 3;

/**
 * @param {import("d3").HierarchyPointNode<{ taxonId: number }>} d
 */
function nodeDotRadius(d) {
  return d.children || d._children ? 5 : 4;
}

/**
 * Distance from node center (0,0) to where label text begins (px, before labelDx).
 * @param {import("d3").HierarchyPointNode<{ taxonId: number }>} d
 */
function labelPadX(d) {
  return nodeDotRadius(d) + 1 + LABEL_GAP_FROM_DOT;
}
/** Approximate average character width (px) for label width estimates at ~11px. */
const LABEL_CHAR_PX = 6.85;
/** Match CSS font sizes for vertical alignment math. */
const LABEL_FONT_MAIN = 11;
const LABEL_FONT_RANK = 9.5;
const LABEL_LINE_GAP = 3;
/** Minimum horizontal padding beyond the deepest node before label collision pass expands width. */
const LABEL_SLOT_MIN = 280;

/**
 * @param {string} pathAndQuery
 */
function inatFetch(pathAndQuery) {
  const trimmed = pathAndQuery.replace(/^\//, "");
  const u = new URL(trimmed, `${API}/`);
  u.searchParams.set("_cb", `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`);
  return fetch(u.href, { cache: "no-store" });
}

/** Incremented on each full D3 remount to drop stale async divergence fetches. */
let d3MountGeneration = 0;

/**
 * @param {string} url
 * @returns {Promise<object>}
 */
async function fetchJsonCorsAny(url) {
  const fetchOpts = { mode: "cors", cache: "no-store" };
  try {
    const res = await fetch(url, fetchOpts);
    if (res.ok) return await res.json();
  } catch {
    /* fall through to relay */
  }
  const proxied = `${ALL_ORIGINS_RAW}${encodeURIComponent(url)}`;
  const res2 = await fetch(proxied, fetchOpts);
  if (!res2.ok) throw new Error(`Relay fetch failed (${res2.status})`);
  return await res2.json();
}

/**
 * @param {object} taxon
 * @returns {number | null}
 */
function extractNcbiFromOpenTreeTaxon(taxon) {
  const sources = taxon?.tax_sources;
  if (!Array.isArray(sources)) return null;
  for (const s of sources) {
    const m = String(s).match(/^ncbi:(\d+)$/i);
    if (m) {
      const n = Number(m[1]);
      return Number.isFinite(n) && n > 0 ? n : null;
    }
  }
  return null;
}

/**
 * Map scientific names (as returned by iNaturalist `taxon.name`) to NCBI taxonomy ids via Open Tree TNRS.
 * @param {Iterable<string>} names
 * @returns {Promise<Map<string, number>>} lowercase name → ncbi id
 */
async function tnrsScientificNamesToNcbi(names) {
  /** @type {Map<string, number>} */
  const out = new Map();
  const uniq = [];
  const seen = new Set();
  for (const raw of names) {
    const n = String(raw || "").trim();
    if (!n) continue;
    const k = n.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(n);
  }
  for (let i = 0; i < uniq.length; i += TNRS_CHUNK) {
    const chunk = uniq.slice(i, i + TNRS_CHUNK);
    const res = await fetch(OPEN_TREE_TNRS, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ names: chunk, context_name: "All life" }),
      mode: "cors",
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`Open Tree TNRS failed (${res.status})`);
    const data = await res.json();
    for (const block of data.results || []) {
      const nm = block?.name;
      const matches = block?.matches;
      if (!nm || !Array.isArray(matches) || !matches.length) continue;
      const tax = matches[0]?.taxon;
      const ncbi = extractNcbiFromOpenTreeTaxon(tax);
      if (ncbi) out.set(String(nm).toLowerCase(), ncbi);
    }
  }
  return out;
}

/**
 * @param {import("d3").HierarchyPointNode<{ taxonId: number }>} node
 * @param {Map<number, object>} taxonById
 * @param {Map<string, number>} nameToNcbi
 * @returns {number | null}
 */
function ncbiForSubtreeLeaves(node, taxonById, nameToNcbi) {
  for (const leaf of node.leaves()) {
    const tid = leaf.data?.taxonId;
    if (!Number.isFinite(tid) || tid <= 0) continue;
    const t = taxonById.get(tid);
    const nm = t && typeof t.name === "string" ? t.name.trim() : "";
    if (!nm) continue;
    const ncbi = nameToNcbi.get(nm.toLowerCase());
    if (Number.isFinite(ncbi) && ncbi > 0) return ncbi;
  }
  return null;
}

/**
 * @param {number} a
 * @param {number} b
 */
function timetreeMrcaUrl(a, b) {
  const x = Math.min(a, b);
  const y = Math.max(a, b);
  return `${TIMETREE_MRCA}/${x}+${y}/json`;
}

/**
 * @param {object} j
 */
function parseTimeTreeMrca(j) {
  const age = Number(j?.precomputed_age);
  const low = Number(j?.precomputed_ci_low);
  const high = Number(j?.precomputed_ci_high);
  return {
    age: Number.isFinite(age) ? age : NaN,
    low: Number.isFinite(low) ? low : NaN,
    high: Number.isFinite(high) ? high : NaN,
  };
}

function formatDivergenceMa(age, low, high) {
  if (!Number.isFinite(age)) return "";
  const a = Math.round(age);
  if (Number.isFinite(low) && Number.isFinite(high)) {
    return `~${a} Ma (${Math.round(low)}–${Math.round(high)})`;
  }
  return `~${a} Ma`;
}

/**
 * @param {SVGSVGElement} svgEl
 * @param {import("d3").HierarchyPointNode<{ taxonId: number }>} hRoot
 * @param {Map<number, object>} taxonById
 * @param {number} mountGen
 */
async function applyDivergenceLabels(svgEl, hRoot, taxonById, mountGen) {
  const inner = svgEl.querySelector(".tree-zoom-inner");
  if (!inner) return;

  const names = [];
  for (const leaf of hRoot.leaves()) {
    const tid = leaf.data?.taxonId;
    if (!Number.isFinite(tid) || tid <= 0) continue;
    const t = taxonById.get(tid);
    const nm = t && typeof t.name === "string" ? t.name.trim() : "";
    if (nm) names.push(nm);
  }
  if (!names.length) return;

  let nameToNcbi;
  try {
    nameToNcbi = await tnrsScientificNamesToNcbi(names);
  } catch {
    return;
  }
  if (mountGen !== d3MountGeneration) return;

  /** @type {{ link: import("d3").HierarchyPointLink<{ taxonId: number }>, n1: number, n2: number }[]} */
  const tasks = [];
  for (const link of hRoot.links()) {
    const source = link.source;
    const target = link.target;
    const kids = source.children;
    if (!kids || kids.length < 2) continue;
    const siblings = kids.filter((c) => c !== target);
    if (!siblings.length) continue;
    const n1 = ncbiForSubtreeLeaves(target, taxonById, nameToNcbi);
    const n2 = ncbiForSubtreeLeaves(siblings[0], taxonById, nameToNcbi);
    if (!n1 || !n2 || n1 === n2) continue;
    tasks.push({ link, n1, n2 });
  }
  if (!tasks.length) return;

  const layer = d3.select(inner).append("g").attr("class", "tree-divergence-layer");

  for (const task of tasks) {
    if (mountGen !== d3MountGeneration) return;

    const s = task.link.source;
    const t = task.link.target;
    const sx = s.px;
    const sy = s.py;
    const tx = t.px;
    const ty = t.py;
    const mid = (sy + ty) / 2;
    const cx = (sx + tx) / 2;
    const cy = mid - 10;

    const te = layer
      .append("text")
      .attr("class", "tree-link-age")
      .attr("text-anchor", "middle")
      .attr("x", cx)
      .attr("y", cy)
      .attr("fill", "#4a3f6a")
      .text("…");

    let parsed;
    try {
      const url = timetreeMrcaUrl(task.n1, task.n2);
      const j = await fetchJsonCorsAny(url);
      parsed = parseTimeTreeMrca(j);
    } catch {
      parsed = { age: NaN, low: NaN, high: NaN };
    }
    await new Promise((r) => setTimeout(r, TIMETREE_REQUEST_GAP_MS));
    if (mountGen !== d3MountGeneration) return;

    const label = formatDivergenceMa(parsed.age, parsed.low, parsed.high);
    if (label) te.text(label);
    else te.remove();
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function truncateLabel(s, max) {
  const t = String(s).trim();
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * @param {import("d3").HierarchyPointNode<{ label: string; rank?: string }>} d
 */
function labelDisplayMain(d) {
  return truncateLabel(d.data.label, 34);
}

/**
 * @param {import("d3").HierarchyPointNode<{ label: string; rank?: string }>} d
 */
function labelDisplayRank(d) {
  return d.data.rank ? truncateLabel(String(d.data.rank), 22) : "";
}

/**
 * True height of the drawn label block (px), matching mountD3Tree text y positions.
 * @param {import("d3").HierarchyPointNode<{ label: string; rank?: string }>} d
 */
function labelBlockHeightPx(d) {
  if (labelDisplayRank(d)) {
    return LABEL_FONT_MAIN + LABEL_LINE_GAP + LABEL_FONT_RANK;
  }
  return LABEL_FONT_MAIN;
}

/**
 * Local y positions for `dominant-baseline="hanging"` so stacked lines match font metrics
 * and the block stays vertically centered on the label origin (node row + optional labelDy).
 * @param {import("d3").HierarchyPointNode<{ label: string; rank?: string }>} d
 * @returns {{ yMain: number, yRank: number | null }}
 */
function labelHangLineYs(d) {
  const total = labelBlockHeightPx(d);
  const yTop = -total / 2;
  if (!labelDisplayRank(d)) {
    return { yMain: yTop, yRank: null };
  }
  const yMain = yTop;
  const yRank = yTop + LABEL_FONT_MAIN + LABEL_LINE_GAP;
  return { yMain, yRank };
}

/**
 * @param {import("d3").HierarchyPointNode<{ label: string; rank?: string }>} d
 */
function estimateLabelWidthPx(d) {
  const main = labelDisplayMain(d);
  const rank = labelDisplayRank(d);
  const wChars = Math.max(main.length, rank ? rank.length : 0);
  return Math.min(wChars * LABEL_CHAR_PX + 18, 300);
}

/**
 * @param {import("d3").HierarchyPointNode<{ label: string; rank?: string }>} d
 */
function estimateLabelHeightPx(d) {
  return labelBlockHeightPx(d) + LABEL_VPAD * 2;
}

/**
 * Widest label (px) in each subtree — drives sibling separation so columns leave room for text.
 * @param {import("d3").HierarchyNode<{ label: string; rank?: string }>} root
 */
function subtreeMaxLabelWidth(root) {
  /** @type {Map<import("d3").HierarchyNode<{ label: string; rank?: string }>, number>} */
  const map = new Map();
  root.eachAfter((n) => {
    let m = estimateLabelWidthPx(n);
    const ch = n.children;
    if (ch) {
      for (const c of ch) m = Math.max(m, map.get(c) ?? 0);
    }
    map.set(n, m);
  });
  return map;
}

/**
 * @param {{ x0: number, x1: number, y0: number, y1: number }} a
 * @param {{ x0: number, x1: number, y0: number, y1: number }} b
 */
function rectsOverlap2d(a, b) {
  return !(a.y1 < b.y0 - 0.5 || a.y0 > b.y1 + 0.5 || a.x1 < b.x0 - 0.5 || a.x0 > b.x1 + 0.5);
}

/** Hit circle around another node’s dot (global px); labels must not intrude here. */
const NODE_OCCLUSION_R = 15;

/**
 * @param {number} rx0
 * @param {number} ry0
 * @param {number} rx1
 * @param {number} ry1
 * @param {number} cx
 * @param {number} cy
 * @param {number} r
 */
function rectCircleOverlap(rx0, ry0, rx1, ry1, cx, cy, r) {
  const px = Math.max(rx0, Math.min(cx, rx1));
  const py = Math.max(ry0, Math.min(cy, ry1));
  const dx = cx - px;
  const dy = cy - py;
  return dx * dx + dy * dy < r * r;
}

/**
 * Assign `d.labelDx` / `d.labelDy` so label boxes avoid each other and other nodes’ dots.
 * @param {import("d3").HierarchyPointNode<{ label: string; rank?: string }>} hRoot
 */
function assignLabelOffsets(hRoot) {
  const allNodes = hRoot.descendants();
  for (const n of allNodes) {
    n.labelDx = 0;
    n.labelDy = 0;
  }

  /** @type {{ y0: number, y1: number, x0: number, x1: number }[]} */
  const placed = [];
  const items = allNodes.map((d) => {
    const h = estimateLabelHeightPx(d);
    const w = estimateLabelWidthPx(d);
    const baseX = d.px + labelPadX(d);
    return { d, h, w, baseX };
  });
  items.sort((a, b) => a.d.py - b.d.py || a.baseX - b.baseX);

  /** Prefer horizontal nudges so labels stay on the node’s row and read as that node’s caption. */
  const dySteps = [0, 11, -11, 22, -22, 34, -34];
  const maxDx = 420;
  const dxStep = 9;

  for (const it of items) {
    for (let i = placed.length - 1; i >= 0; i -= 1) {
      if (placed[i].y1 < it.d.py - 72) placed.splice(i, 1);
    }

    let bestDx = 0;
    let bestDy = 0;
    let found = false;

    outer: for (const dy of dySteps) {
      for (let dx = 0; dx <= maxDx; dx += dxStep) {
        const y0 = it.d.py + dy - it.h / 2;
        const y1 = it.d.py + dy + it.h / 2;
        const x0 = it.baseX + dx;
        const x1 = x0 + it.w;
        const cand = { x0, x1, y0, y1 };

        let clash = false;
        for (const o of placed) {
          if (rectsOverlap2d(cand, o)) {
            clash = true;
            break;
          }
        }
        if (!clash) {
          for (const other of allNodes) {
            if (other === it.d) continue;
            if (rectCircleOverlap(cand.x0, cand.y0, cand.x1, cand.y1, other.px, other.py, NODE_OCCLUSION_R)) {
              clash = true;
              break;
            }
          }
        }
        if (!clash) {
          bestDx = dx;
          bestDy = dy;
          found = true;
          break outer;
        }
      }
    }

    if (!found) {
      bestDx = maxDx;
      bestDy = 0;
    }

    it.d.labelDx = bestDx;
    it.d.labelDy = bestDy;

    const y0 = it.d.py + bestDy - it.h / 2;
    const y1 = it.d.py + bestDy + it.h / 2;
    const x0 = it.baseX + bestDx;
    placed.push({ y0, y1, x0, x1: x0 + it.w });
  }
}

/**
 * Fold large subtrees on first render: collapse internal nodes that contain more than `maxSpecies`
 * **selected species** (descendant leaves), not counting internal taxa.
 * @param {import("d3").HierarchyNode<unknown>} root
 * @param {number} maxSpecies
 */
function collapseWideSubtreesByDefault(root, maxSpecies) {
  /** @type {Map<import("d3").HierarchyNode<unknown>, number>} */
  const counts = new Map();
  root.each((d) => {
    counts.set(d, d.leaves().length);
  });
  root.eachAfter((d) => {
    if (d === root) return;
    if (!d.children || !d.children.length) return;
    const n = counts.get(d) ?? 0;
    if (n > maxSpecies) {
      d._children = d.children;
      d.children = null;
    }
  });
}

/** @param {object} taxon */
function taxonDisplayName(taxon) {
  if (!taxon || typeof taxon !== "object") return "";
  const cn = typeof taxon.preferred_common_name === "string" ? taxon.preferred_common_name.trim() : "";
  const nm = typeof taxon.name === "string" ? taxon.name.trim() : "";
  if (cn && nm && cn.toLowerCase() !== nm.toLowerCase()) return `${cn} (${nm})`;
  return cn || nm || `Taxon ${taxon.id ?? ""}`;
}

/** @param {object | null} taxon */
function taxonHref(taxon) {
  if (!taxon || taxon.id == null) return "https://www.inaturalist.org/";
  const id = String(taxon.id).trim();
  if (!id) return "https://www.inaturalist.org/";
  return `https://www.inaturalist.org/taxa/${id}`;
}

/**
 * @param {Map<number, object>} taxonById
 * @param {Iterable<number>} ids
 */
async function fetchTaxaByIds(taxonById, ids) {
  const need = [...new Set(ids)].filter((id) => Number.isFinite(id) && id > 0 && !taxonById.has(id));
  for (let i = 0; i < need.length; i += TAXA_FETCH_CHUNK) {
    const chunk = need.slice(i, i + TAXA_FETCH_CHUNK);
    const res = await inatFetch(`taxa?id=${chunk.join(",")}`);
    if (!res.ok) throw new Error(`Taxon lookup failed (${res.status})`);
    const data = await res.json();
    for (const t of data.results || []) {
      if (t && t.id != null) taxonById.set(Number(t.id), t);
    }
  }
}

/**
 * @param {{ taxonId: number, children: Map<number, { taxonId: number, children: Map<number, unknown> }> }} root
 * @param {number[]} pathIds root-to-tip inclusive
 */
function insertPath(root, pathIds) {
  let node = root;
  for (const id of pathIds) {
    if (!node.children.has(id)) {
      node.children.set(id, { taxonId: id, children: new Map() });
    }
    const next = node.children.get(id);
    if (!next) break;
    node = next;
  }
}

/**
 * @param {object} taxon
 * @returns {number[]}
 */
function pathIdsForTaxon(taxon) {
  const selfId = taxon.id != null ? Number(taxon.id) : NaN;
  if (!Number.isFinite(selfId)) return [];
  const anc = Array.isArray(taxon.ancestor_ids)
    ? taxon.ancestor_ids.map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0)
    : [];
  return [...anc, selfId];
}

/**
 * @param {Map<number, object>} taxonById
 * @param {Set<number>} tipIds
 */
function collectMissingIds(taxonById, tipIds) {
  const out = new Set();
  for (const tid of tipIds) {
    const t = taxonById.get(tid);
    if (!t) {
      out.add(tid);
      continue;
    }
    for (const id of pathIdsForTaxon(t)) {
      if (!taxonById.has(id)) out.add(id);
    }
  }
  return out;
}

/**
 * @param {Map<number, object>} taxonById
 * @param {{ taxonId: number, children: Map<number, unknown> }} a
 * @param {{ taxonId: number, children: Map<number, unknown> }} b
 */
function compareTrieChildren(taxonById, a, b) {
  const ta = taxonById.get(a.taxonId);
  const tb = taxonById.get(b.taxonId);
  const ra = ta && ta.rank_level != null ? Number(ta.rank_level) : 0;
  const rb = tb && tb.rank_level != null ? Number(tb.rank_level) : 0;
  if (ra !== rb) return ra - rb;
  const na = ta ? taxonDisplayName(ta) : "";
  const nb = tb ? taxonDisplayName(tb) : "";
  return na.localeCompare(nb);
}

/**
 * @param {{ taxonId: number, children: Map<number, unknown> }} node
 * @param {Map<number, object>} taxonById
 */
function trieNodeToData(node, taxonById) {
  const tid = node.taxonId;
  const t = tid >= 0 ? taxonById.get(tid) : null;
  const kids = [...node.children.values()].sort((a, b) => compareTrieChildren(taxonById, a, b));
  const label =
    tid < 0 ? "Shared ancestry" : t ? taxonDisplayName(t) : `Taxon ${tid}`;
  const rank = tid < 0 ? "" : t && t.rank ? String(t.rank) : "";
  const href = tid < 0 ? "" : t ? taxonHref(t) : `https://www.inaturalist.org/taxa/${tid}`;
  return {
    taxonId: tid,
    label,
    rank,
    href,
    children: kids.length ? kids.map((k) => trieNodeToData(k, taxonById)) : undefined,
  };
}

/**
 * @param {{ taxonId: number, children: Map<number, unknown> }} trieRoot
 * @param {Map<number, object>} taxonById
 */
function compressVirtualRoot(trieRoot) {
  let r = trieRoot;
  while (r.taxonId === -1 && r.children.size === 1) {
    r = r.children.values().next().value;
  }
  return r;
}

function parseTaxaQuery(q) {
  const raw = q.get("taxa") || q.get("ids") || "";
  const parts = String(raw)
    .split(/[,+\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const ids = [];
  for (const p of parts) {
    const n = parseInt(p, 10);
    if (Number.isFinite(n) && n > 0) ids.push(n);
  }
  return [...new Set(ids)];
}

// ── App state ─────────────────────────────────────────────────────────────

const el = {
  search: document.getElementById("tree-taxon-search"),
  suggestions: document.getElementById("tree-taxon-suggestions"),
  userLogin: document.getElementById("tree-user-login"),
  btnBulk: document.getElementById("btn-add-my-species"),
  btnClear: document.getElementById("btn-clear-tree"),
  bulkStatus: document.getElementById("tree-bulk-status"),
  chips: document.getElementById("tree-selected-chips"),
  viz: document.getElementById("tree-viz-root"),
  err: document.getElementById("tree-error"),
};

/** @type {Map<number, object>} */
const taxonById = new Map();
/** Selected leaf taxa (typically species) */
const tipIds = new Set();

let searchDebounce = null;
let suggestHighlight = -1;
let urlWriteTimer = null;

function showError(msg) {
  if (!el.err) return;
  if (!msg) {
    el.err.hidden = true;
    el.err.textContent = "";
    return;
  }
  el.err.hidden = false;
  el.err.textContent = msg;
}

function syncUrlSoon() {
  if (urlWriteTimer) clearTimeout(urlWriteTimer);
  urlWriteTimer = setTimeout(() => {
    urlWriteTimer = null;
    const ids = [...tipIds].sort((a, b) => a - b);
    const u = new URL(window.location.href);
    if (ids.length) u.searchParams.set("taxa", ids.join(","));
    else u.searchParams.delete("taxa");
    history.replaceState(null, "", `${u.pathname}${u.search}`);
  }, 200);
}

function renderChips() {
  if (!el.chips) return;
  el.chips.innerHTML = "";
  const sorted = [...tipIds].sort((a, b) => a - b);
  for (const id of sorted) {
    const t = taxonById.get(id);
    const label = t ? taxonDisplayName(t) : `Taxon ${id}`;
    const chip = document.createElement("div");
    chip.className = "tree-chip";
    chip.innerHTML = `<span class="tree-chip-name" title="${escapeHtml(label)}">${escapeHtml(label)}</span><button type="button" aria-label="Remove">×</button>`;
    chip.querySelector("button")?.addEventListener("click", () => {
      tipIds.delete(id);
      renderChips();
      void refreshTree();
      syncUrlSoon();
    });
    el.chips.appendChild(chip);
  }
}

/**
 * Expand every collapsed node under `d` (d3 hierarchy node).
 * @param {import("d3").HierarchyNode<{ taxonId: number }>} d
 */
function expandAllUnder(d) {
  if (d._children) {
    d.children = d._children;
    d._children = null;
  }
  if (d.children) for (const c of d.children) expandAllUnder(c);
}

/**
 * @param {import("d3").HierarchyNode<{ taxonId: number }>} d
 */
function toggleCollapse(d) {
  if (d.children && d.children.length) {
    d._children = d.children;
    d.children = null;
  } else if (d._children && d._children.length) {
    d.children = d._children;
    d._children = null;
  }
}

/**
 * @param {SVGSVGElement} svgEl
 * @param {d3.ZoomBehavior<SVGSVGElement, unknown>} zoom
 * @param {import("d3").HierarchyNode<{ taxonId: number }>} d
 */
function zoomToFitSubtree(svgEl, zoom, d) {
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  d.each((dd) => {
    if (dd.px == null || dd.py == null) return;
    const padX = 14;
    const halfH = estimateLabelHeightPx(dd) / 2 + 3;
    const lw = estimateLabelWidthPx(dd);
    const dx = dd.labelDx || 0;
    const dy = dd.labelDy || 0;
    const lpad = labelPadX(dd);
    x0 = Math.min(x0, dd.px - padX);
    x1 = Math.max(x1, dd.px + lpad + dx + lw + 10);
    y0 = Math.min(y0, dd.py + dy - halfH);
    y1 = Math.max(y1, dd.py + dy + halfH);
  });
  if (!Number.isFinite(x0)) return;
  const fullW = x1 - x0;
  const fullH = y1 - y0;
  const rect = svgEl.getBoundingClientRect();
  const vw = rect.width || 600;
  const vh = rect.height || 480;
  const scale = Math.min(vw / fullW, vh / fullH, 3.2) * 0.92;
  const tx = vw / 2 - scale * ((x0 + x1) / 2);
  const ty = vh / 2 - scale * ((y0 + y1) / 2);
  const t = d3.zoomIdentity.translate(tx, ty).scale(scale);
  d3.select(svgEl).transition().duration(380).call(zoom.transform, t);
}

/**
 * @param {HTMLElement} host
 * @param {import("d3").HierarchyNode<{ taxonId: number; label: string; rank: string; href: string }>} hRoot
 * @param {Map<number, object>} taxonById
 * @param {{ preserveZoom?: boolean }} [opts]
 */
function mountD3Tree(host, hRoot, taxonById, opts) {
  const mountGen = ++d3MountGeneration;
  const preserveZoom = Boolean(opts?.preserveZoom);
  const oldSvg = preserveZoom ? host.querySelector("svg.tree-viz-svg") : null;
  const prevZoom = oldSvg ? d3.zoomTransform(/** @type {SVGSVGElement} */ (oldSvg)) : null;

  host.innerHTML = "";

  const toolbar = document.createElement("div");
  toolbar.className = "tree-viz-toolbar";
  toolbar.innerHTML = `<button type="button" class="btn secondary btn--sm" id="btn-zoom-reset">Reset zoom</button>
    <button type="button" class="btn secondary btn--sm" id="btn-expand-all">Expand all</button>`;

  const wrap = document.createElement("div");
  wrap.className = "tree-svg-wrap";

  const labelSpan = subtreeMaxLabelWidth(hRoot);
  const sep = (/** @type {import("d3").HierarchyNode<{ label: string; rank?: string }>} */ a, b) => {
    const wa = labelSpan.get(a) ?? 120;
    const wb = labelSpan.get(b) ?? 120;
    if (a.parent === b.parent) {
      return 1.08 + Math.min(1.85, (Math.max(wa, wb) / 165) * 1.02);
    }
    return 1.15 + Math.min(1.5, (wa + wb) / 400);
  };

  const tree = d3.tree().nodeSize([NODE_BREADTH, NODE_DEPTH]).separation(sep);
  tree(hRoot);

  let xMin = Infinity;
  let yMin = Infinity;
  hRoot.each((d) => {
    xMin = Math.min(xMin, d.x);
    yMin = Math.min(yMin, d.y);
  });

  hRoot.each((d) => {
    d.px = M.left + (d.x - xMin);
    d.py = M.top + (d.y - yMin);
  });

  assignLabelOffsets(hRoot);

  let minLblY = Infinity;
  let maxLblY = -Infinity;
  hRoot.each((d) => {
    const half = estimateLabelHeightPx(d) / 2;
    const dy = d.labelDy || 0;
    minLblY = Math.min(minLblY, d.py + dy - half);
    maxLblY = Math.max(maxLblY, d.py + dy + half);
  });
  const viewY = Number.isFinite(minLblY) ? Math.min(0, minLblY - 8) : 0;
  const maxPy = hRoot
    .descendants()
    .reduce((m, d) => Math.max(m, d.py), 0);

  let maxPx = 0;
  let labelRight = 0;
  hRoot.each((d) => {
    maxPx = Math.max(maxPx, d.px);
    const w = estimateLabelWidthPx(d);
    labelRight = Math.max(labelRight, d.px + labelPadX(d) + (d.labelDx || 0) + w);
  });

  const contentW = Math.max(maxPx + LABEL_SLOT_MIN, labelRight) + M.right;
  const contentH = Math.max(maxLblY + M.bottom + 28, maxPy + M.bottom + 24) - viewY;

  const svg = d3
    .create("svg")
    .attr("class", "tree-viz-svg")
    .attr("viewBox", `0 ${viewY} ${contentW} ${contentH}`)
    .attr("width", "100%")
    .attr("height", Math.min(780, Math.max(380, contentH)))
    .attr("role", "img")
    .attr("aria-label", "Taxonomic tree diagram");

  const innerG = svg.append("g").attr("class", "tree-zoom-inner");

  const zoom = d3
    .zoom()
    .scaleExtent([0.08, 14])
    .on("zoom", (ev) => {
      innerG.attr("transform", ev.transform);
    });

  svg.call(zoom);
  svg.on("dblclick.zoom", null);

  const svgEl = /** @type {SVGSVGElement} */ (svg.node());
  if (
    preserveZoom &&
    prevZoom &&
    (prevZoom.k !== 1 || Math.abs(prevZoom.x) > 0.5 || Math.abs(prevZoom.y) > 0.5)
  ) {
    innerG.attr("transform", String(prevZoom));
    d3.select(svgEl).call(zoom.transform, prevZoom);
  }

  const linkPath = (/** @type {import("d3").HierarchyPointLink<{ taxonId: number }>} */ l) => {
    const s = l.source;
    const t = l.target;
    const sx = s.px;
    const sy = s.py;
    const tx = t.px;
    const ty = t.py;
    const mid = (sy + ty) / 2;
    return `M${sx},${sy}C${sx},${mid} ${tx},${mid} ${tx},${ty}`;
  };

  innerG
    .append("g")
    .attr("class", "tree-links")
    .attr("fill", "none")
    .selectAll("path")
    .data(hRoot.links())
    .join("path")
    .attr("class", "tree-link")
    .attr("d", linkPath);

  const nodeG = innerG.append("g").attr("class", "tree-nodes");

  const nodes = nodeG
    .selectAll("g")
    .data(hRoot.descendants(), (/** @type {import("d3").HierarchyPointNode<{ taxonId: number }>} */ d) => `${d.depth}-${d.data.taxonId}`)
    .join("g")
    .attr("class", "tree-node")
    .attr("transform", (d) => `translate(${d.px},${d.py})`);

  nodes
    .append("circle")
    .attr("class", "tree-node-hit")
    .attr("r", 11)
    .attr("fill", "transparent")
    .attr("pointer-events", "all")
    .style("cursor", (d) => (d.children || d._children ? "pointer" : "default"))
    .on("click", (ev, d) => {
      ev.stopPropagation();
      if (!d.children && !d._children) return;
      toggleCollapse(d);
      mountD3Tree(host, hRoot, taxonById, { preserveZoom: true });
    });

  nodes
    .append("circle")
    .attr("class", "tree-node-dot")
    .attr("r", (d) => (d.children || d._children ? 5 : 4))
    .attr("fill", (d) => ((d.children || d._children) ? "#2d6a4f" : "#40916c"))
    .attr("stroke", "#fff")
    .attr("stroke-width", 1.2)
    .style("pointer-events", "none");

  nodes.each(function (d) {
    const g = d3.select(this);
    const hasHref = d.data.href && String(d.data.href).length > 1;
    const fullLine = d.data.rank ? `${d.data.label} · ${d.data.rank}` : d.data.label;
    g.append("title").text(fullLine);
    const main = labelDisplayMain(d);
    const rank = labelDisplayRank(d);
    const pad = labelPadX(d) + (d.labelDx || 0);
    const lidy = d.labelDy || 0;

    const linkParent = hasHref
      ? g
          .append("a")
          .attr("href", d.data.href)
          .attr("target", "_blank")
          .attr("rel", "noopener noreferrer")
      : g;

    const labelG = linkParent.append("g").attr("class", "tree-node-label-wrap").attr("transform", `translate(${pad},${lidy})`);

    if (rank) {
      const { yMain, yRank: yR } = labelHangLineYs(d);
      labelG
        .append("text")
        .attr("class", "tree-node-label")
        .attr("fill", "#1a2e1a")
        .attr("x", 0)
        .attr("y", yMain)
        .attr("text-anchor", "start")
        .attr("dominant-baseline", "hanging")
        .text(main);
      labelG
        .append("text")
        .attr("class", "tree-node-rank")
        .attr("x", 0)
        .attr("y", /** @type {number} */ (yR))
        .attr("text-anchor", "start")
        .attr("dominant-baseline", "hanging")
        .text(rank);
    } else {
      const { yMain } = labelHangLineYs(d);
      labelG
        .append("text")
        .attr("class", "tree-node-label")
        .attr("fill", "#1a2e1a")
        .attr("x", 0)
        .attr("y", yMain)
        .attr("text-anchor", "start")
        .attr("dominant-baseline", "hanging")
        .text(main);
    }
  });

  nodes.on("dblclick", (ev, d) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (!(d.children || d._children)) return;
    zoomToFitSubtree(svg.node(), zoom, d);
  });

  wrap.append(svg.node());
  host.appendChild(toolbar);
  host.appendChild(wrap);

  toolbar.querySelector("#btn-zoom-reset")?.addEventListener("click", () => {
    d3.select(svgEl).transition().duration(280).call(zoom.transform, d3.zoomIdentity);
  });
  toolbar.querySelector("#btn-expand-all")?.addEventListener("click", () => {
    expandAllUnder(hRoot);
    mountD3Tree(host, hRoot, taxonById);
  });

  void applyDivergenceLabels(svgEl, hRoot, taxonById, mountGen);
}

async function refreshTree() {
  showError("");
  if (!el.viz) return;
  if (!tipIds.size) {
    el.viz.innerHTML = `<p class="tree-empty">Add one or more species to see a merged taxonomic tree.</p>`;
    return;
  }
  try {
    const missing = collectMissingIds(taxonById, tipIds);
    await fetchTaxaByIds(taxonById, missing);
    for (const tid of tipIds) {
      if (!taxonById.has(tid)) {
        showError(`Could not load taxon ${tid}.`);
        el.viz.innerHTML = "";
        return;
      }
    }
    const missing2 = collectMissingIds(taxonById, tipIds);
    await fetchTaxaByIds(taxonById, missing2);

    const trieRoot = { taxonId: -1, children: new Map() };
    for (const tid of tipIds) {
      const t = taxonById.get(tid);
      if (!t) continue;
      const path = pathIdsForTaxon(t);
      if (path.length) insertPath(trieRoot, path);
    }

    const compressed = compressVirtualRoot(trieRoot);
    const data = trieNodeToData(compressed, taxonById);
    const hRoot = d3.hierarchy(data, (d) => d.children);
    collapseWideSubtreesByDefault(hRoot, 5);

    mountD3Tree(el.viz, hRoot, taxonById);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Something went wrong.";
    showError(msg);
    el.viz.innerHTML = "";
  }
}

/**
 * @param {object} taxon
 */
function addTipTaxon(taxon) {
  if (!taxon || taxon.id == null) return;
  const id = Number(taxon.id);
  if (!Number.isFinite(id) || id <= 0) return;
  taxonById.set(id, taxon);
  tipIds.add(id);
  renderChips();
  void refreshTree();
  syncUrlSoon();
}

function hideSuggestions() {
  if (!el.suggestions) return;
  el.suggestions.hidden = true;
  el.suggestions.innerHTML = "";
  suggestHighlight = -1;
  if (el.search) el.search.setAttribute("aria-expanded", "false");
}

function renderSuggestions(results) {
  if (!el.suggestions || !el.search) return;
  el.suggestions.innerHTML = "";
  suggestHighlight = -1;
  for (const t of results) {
    const li = document.createElement("li");
    li.setAttribute("role", "option");
    li.setAttribute("aria-selected", "false");
    const nm = taxonDisplayName(t);
    const rk = t.rank ? String(t.rank) : "";
    li.innerHTML = `<span><span class="sug-name">${escapeHtml(nm)}</span></span><span class="sug-meta">${escapeHtml(rk)} · id ${t.id}</span>`;
    li.addEventListener("mousedown", (ev) => {
      ev.preventDefault();
      addTipTaxon(t);
      el.search.value = "";
      hideSuggestions();
    });
    el.suggestions.appendChild(li);
  }
  el.suggestions.hidden = results.length === 0;
  el.search.setAttribute("aria-expanded", results.length ? "true" : "false");
}

async function loadInitialFromUrl() {
  const u = new URL(window.location.href);
  const loginHint = u.searchParams.get("user_login") || u.searchParams.get("user");
  if (el.userLogin && loginHint) el.userLogin.value = loginHint;
  const ids = parseTaxaQuery(u.searchParams);
  if (!ids.length) return;
  try {
    await fetchTaxaByIds(taxonById, ids);
    for (const id of ids) {
      if (taxonById.has(id)) tipIds.add(id);
    }
    renderChips();
    await refreshTree();
  } catch {
    showError("Could not load taxa from URL.");
  }
}

async function onBulkAddObserved() {
  const login = el.userLogin?.value.trim().toLowerCase() || "";
  if (!login) {
    showError("Enter your iNaturalist username first.");
    return;
  }
  showError("");
  if (el.btnBulk) el.btnBulk.disabled = true;
  if (el.bulkStatus) el.bulkStatus.textContent = "Loading species counts…";
  try {
    let page = 1;
    /** @type {object[]} */
    const collected = [];
    while (true) {
      const p = new URLSearchParams();
      p.set("user_login", login);
      p.set("verifiable", "true");
      p.set("per_page", "200");
      p.set("page", String(page));
      p.set("order_by", "count");
      p.set("order", "desc");
      const res = await inatFetch(`observations/species_counts?${p}`);
      if (!res.ok) throw new Error(`species_counts failed (${res.status})`);
      const data = await res.json();
      const rows = data.results || [];
      if (!rows.length) break;
      for (const row of rows) {
        const taxon = row.taxon;
        if (!taxon || taxon.id == null) continue;
        const rk = typeof taxon.rank === "string" ? taxon.rank.toLowerCase() : "";
        if (rk !== "species" && rk !== "hybrid") continue;
        collected.push(taxon);
      }
      if (rows.length < 200) break;
      page += 1;
      if (el.bulkStatus) el.bulkStatus.textContent = `Loaded ${collected.length} species (page ${page})…`;
    }
    if (!collected.length) {
      if (el.bulkStatus) el.bulkStatus.textContent = "No species-level counts returned for that user.";
      return;
    }
    for (const t of collected) {
      taxonById.set(Number(t.id), t);
      tipIds.add(Number(t.id));
    }
    renderChips();
    await refreshTree();
    syncUrlSoon();
    if (el.bulkStatus) el.bulkStatus.textContent = `Added ${collected.length} species.`;
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Bulk import failed.";
    showError(msg);
    if (el.bulkStatus) el.bulkStatus.textContent = "";
  } finally {
    if (el.btnBulk) el.btnBulk.disabled = false;
  }
}

el.search?.addEventListener("input", () => {
  if (searchDebounce) clearTimeout(searchDebounce);
  const q = el.search.value.trim();
  if (q.length < 2) {
    hideSuggestions();
    return;
  }
  searchDebounce = setTimeout(async () => {
    try {
      const res = await inatFetch(`taxa/autocomplete?q=${encodeURIComponent(q)}&per_page=14`);
      const data = res.ok ? await res.json() : { results: [] };
      renderSuggestions(data.results || []);
    } catch {
      hideSuggestions();
    }
  }, 260);
});

el.search?.addEventListener("keydown", (e) => {
  const items = el.suggestions?.querySelectorAll("li") || [];
  if (!items.length) return;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    suggestHighlight = Math.min(suggestHighlight + 1, items.length - 1);
    items.forEach((li, i) => li.setAttribute("aria-selected", i === suggestHighlight ? "true" : "false"));
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    suggestHighlight = Math.max(suggestHighlight - 1, 0);
    items.forEach((li, i) => li.setAttribute("aria-selected", i === suggestHighlight ? "true" : "false"));
  } else if (e.key === "Enter" && suggestHighlight >= 0) {
    e.preventDefault();
    items[suggestHighlight].dispatchEvent(new MouseEvent("mousedown"));
  } else if (e.key === "Escape") {
    hideSuggestions();
  }
});

document.addEventListener("click", (ev) => {
  if (!el.search || !el.suggestions) return;
  const t = ev.target;
  if (t instanceof Node && !el.search.contains(t) && !el.suggestions.contains(t)) hideSuggestions();
});

el.btnBulk?.addEventListener("click", () => void onBulkAddObserved());

el.btnClear?.addEventListener("click", () => {
  tipIds.clear();
  taxonById.clear();
  showError("");
  if (el.bulkStatus) el.bulkStatus.textContent = "";
  renderChips();
  void refreshTree();
  syncUrlSoon();
});

void loadInitialFromUrl().then(() => {
  if (!tipIds.size && el.viz) {
    el.viz.innerHTML = `<p class="tree-empty">Add one or more species to see a merged taxonomic tree.</p>`;
  }
});

/** Block browser page zoom (Ctrl+wheel / trackpad pinch); d3.zoom on the SVG still receives the wheel event. */
(() => {
  window.addEventListener(
    "wheel",
    (e) => {
      if (e.ctrlKey) e.preventDefault();
    },
    { passive: false, capture: true }
  );
  const diagramHas = (/** @type {EventTarget | null} */ tgt) => {
    const w = document.querySelector(".tree-svg-wrap");
    return !!(w && tgt instanceof Node && w.contains(tgt));
  };
  document.addEventListener(
    "gesturestart",
    (e) => {
      if (!diagramHas(e.target)) e.preventDefault();
    },
    { passive: false }
  );
})();
