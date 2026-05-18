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
/** Horizontal layout unit; `separation` returns multiples of this distance between node centers. */
const NODE_BREADTH_UNIT = 6;
/** Minimum vertical gap between stacked node pills (px). */
const NODE_VERT_GAP = 14;
/** Horizontal gap required between adjacent sibling node edges (px). */
const SIBLING_H_GAP = 12;
/** Padding inside the node pill around text (px). */
const NODE_CELL_PAD_X = 6;
const NODE_CELL_PAD_Y = 4;
const NODE_MIN_W = 72;
const NODE_MAX_W = 300;
/** Left strip width on branch nodes for fold/unfold hit target (px). */
const TOGGLE_STRIP_W = 18;
/** Space reserved on the right of the pill for the “open in app” control (px). */
const APP_LINK_ICON_RESERVE = 24;
/** “Open in new” style path, viewBox 0 0 24 24 (scaled when drawn). */
const APP_LINK_ICON_PATH =
  "M19 19H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7h-2v7zM14 3h7v7h-2V5.41l-9.83 9.83-1.41-1.41L17.59 5H14V3z";
/** Extra vertical slack inside the pill vs measured text. */
const LABEL_VPAD = 2;

/** Approximate average character width (px) for label width estimates at ~11px. */
const LABEL_CHAR_PX = 6.85;
/** Match CSS font sizes for vertical alignment math. */
const LABEL_FONT_MAIN = 11;
const LABEL_FONT_RANK = 9.5;
const LABEL_LINE_GAP = 3;

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
    const syOut = sy + nodeHalfH(s);
    const tyIn = ty - nodeHalfH(t);
    const midY = (syOut + tyIn) / 2;
    const cx = (sx + tx) / 2;

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
    if (!label) continue;

    const charPx = 5.45;
    const padX = 9;
    const padY = 5;
    const boxH = 20;
    const estW = Math.min(220, Math.max(44, label.length * charPx + padX * 2));

    const g = layer.append("g").attr("class", "tree-divergence-bubble").attr("transform", `translate(${cx},${midY})`);
    g.append("rect")
      .attr("class", "tree-link-age-bg")
      .attr("x", -estW / 2)
      .attr("y", -boxH / 2)
      .attr("width", estW)
      .attr("height", boxH)
      .attr("rx", 6)
      .attr("ry", 6);
    g.append("text")
      .attr("class", "tree-link-age")
      .attr("text-anchor", "middle")
      .attr("dominant-baseline", "middle")
      .attr("y", 0)
      .text(label);
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
 * @param {object | null} taxon
 * @param {number} tid
 */
function taxonCommonScientificStrings(taxon, tid) {
  if (tid < 0) return { common: "", scientific: "Shared ancestry" };
  if (!taxon || typeof taxon !== "object") return { common: "", scientific: `Taxon ${tid}` };
  const cn = typeof taxon.preferred_common_name === "string" ? taxon.preferred_common_name.trim() : "";
  const nm = typeof taxon.name === "string" ? taxon.name.trim() : "";
  const sci = nm || `Taxon ${tid}`;
  if (cn && sci && cn.toLowerCase() !== sci.toLowerCase()) return { common: cn, scientific: sci };
  return { common: "", scientific: cn || sci };
}

/**
 * @param {import("d3").HierarchyPointNode<{ commonName?: string; scientificName?: string }>} d
 * @param {number} innerWidthPx
 */
function labelDisplayCommonInCell(d, innerWidthPx) {
  const cap = Math.max(6, Math.floor(innerWidthPx / LABEL_CHAR_PX));
  const raw = d.data.commonName && String(d.data.commonName).trim();
  if (!raw) return "";
  return truncateLabel(raw, Math.min(36, cap));
}

/**
 * @param {import("d3").HierarchyPointNode<{ scientificName?: string }>} d
 * @param {number} innerWidthPx
 */
function labelDisplayScientificInCell(d, innerWidthPx) {
  const cap = Math.max(6, Math.floor(innerWidthPx / LABEL_CHAR_PX));
  const raw = d.data.scientificName && String(d.data.scientificName).trim();
  if (!raw) return "";
  return truncateLabel(raw, Math.min(36, cap));
}

/**
 * @param {import("d3").HierarchyPointNode<{ commonName?: string; scientificName?: string; rank?: string }>} d
 * @param {number} innerWidthPx
 */
function labelDisplayRankInCell(d, innerWidthPx) {
  if (!d.data.rank) return "";
  const cap = Math.max(4, Math.floor(innerWidthPx / LABEL_CHAR_PX));
  return truncateLabel(String(d.data.rank), Math.min(22, cap));
}

/**
 * Untruncated tooltip / aria string: common · scientific · rank.
 * @param {import("d3").HierarchyPointNode<{ commonName?: string; scientificName?: string; rank?: string; label?: string }>} d
 */
function taxonNodeTitlePlain(d) {
  const parts = [];
  const cn = d.data.commonName && String(d.data.commonName).trim();
  const sci = d.data.scientificName && String(d.data.scientificName).trim();
  const rk = d.data.rank && String(d.data.rank).trim();
  if (cn) parts.push(cn);
  if (sci) parts.push(sci);
  else if (d.data.label) parts.push(String(d.data.label));
  if (rk) parts.push(rk);
  return parts.join(" · ");
}

/**
 * @param {import("d3").HierarchyPointNode<{ commonName?: string; scientificName?: string; rank?: string }>} d
 */
function nodeNameLineCount(d) {
  return d.data.commonName && String(d.data.commonName).trim() ? 2 : 1;
}

/**
 * True height of the drawn label block (px), matching mountD3Tree text y positions.
 * @param {import("d3").HierarchyPointNode<{ commonName?: string; scientificName?: string; rank?: string }>} d
 */
function labelBlockHeightPx(d) {
  const twoNames = nodeNameLineCount(d) === 2;
  const nameBlock = twoNames ? LABEL_FONT_MAIN + LABEL_LINE_GAP + LABEL_FONT_MAIN : LABEL_FONT_MAIN;
  const rk = d.data.rank && String(d.data.rank).trim();
  if (rk) return nameBlock + LABEL_LINE_GAP + LABEL_FONT_RANK;
  return nameBlock;
}

/**
 * Hanging-baseline Y for each stacked line; block centered on node origin.
 * @param {import("d3").HierarchyPointNode<{ commonName?: string; scientificName?: string; rank?: string }>} d
 * @returns {{ yCommon: number | null, yScientific: number, yRank: number | null, hasCommon: boolean, hasRank: boolean }}
 */
function labelStackHangYs(d) {
  const hasCommon = !!(d.data.commonName && String(d.data.commonName).trim());
  const hasRank = !!(d.data.rank && String(d.data.rank).trim());
  const nameBlock = hasCommon ? LABEL_FONT_MAIN + LABEL_LINE_GAP + LABEL_FONT_MAIN : LABEL_FONT_MAIN;
  const total = nameBlock + (hasRank ? LABEL_LINE_GAP + LABEL_FONT_RANK : 0);
  const yTop = -total / 2;
  const yCommon = hasCommon ? yTop : null;
  const yScientific = hasCommon ? yTop + LABEL_FONT_MAIN + LABEL_LINE_GAP : yTop;
  const yRank = hasRank ? yTop + nameBlock + LABEL_LINE_GAP : null;
  return { yCommon, yScientific, yRank, hasCommon, hasRank };
}

/**
 * Text-only width estimate (px), before cell padding and pill clamp.
 * @param {import("d3").HierarchyPointNode<{ commonName?: string; scientificName?: string; rank?: string }>} d
 */
function estimateTextBlockWidthPx(d) {
  const cap = 36;
  const common = d.data.commonName ? truncateLabel(String(d.data.commonName), cap) : "";
  const sci = truncateLabel(String(d.data.scientificName || ""), cap);
  const rank = d.data.rank ? truncateLabel(String(d.data.rank), 22) : "";
  const wChars = Math.max(common.length, sci.length, rank.length);
  return Math.min(wChars * LABEL_CHAR_PX + 18, 300);
}

/**
 * Full pill width (px).
 * @param {import("d3").HierarchyPointNode<{ label: string; rank?: string }>} d
 */
function nodeBoxWidth(d) {
  return Math.min(Math.max(estimateTextBlockWidthPx(d) + 2 * NODE_CELL_PAD_X, NODE_MIN_W), NODE_MAX_W);
}

/**
 * @param {import("d3").HierarchyPointNode<{ label: string; rank?: string }>} d
 */
function nodeHalfW(d) {
  return nodeBoxWidth(d) / 2;
}

/**
 * @param {import("d3").HierarchyPointNode<{ label: string; rank?: string }>} d
 */
function nodeBoxHeight(d) {
  return labelBlockHeightPx(d) + LABEL_VPAD * 2 + 2 * NODE_CELL_PAD_Y;
}

/**
 * @param {import("d3").HierarchyPointNode<{ label: string; rank?: string }>} d
 */
function nodeHalfH(d) {
  return nodeBoxHeight(d) / 2;
}

/**
 * @param {import("d3").HierarchyPointNode<{ label: string; rank?: string }>} d
 */
function estimateLabelHeightPx(d) {
  return nodeBoxHeight(d);
}

/**
 * Largest node half-width in each subtree — drives d3 `separation` so adjacent subtrees clear.
 * @param {import("d3").HierarchyNode<{ label: string; rank?: string }>} root
 */
function subtreeMaxNodeHalfWidth(root) {
  /** @type {Map<import("d3").HierarchyNode<{ label: string; rank?: string }>, number>} */
  const map = new Map();
  root.eachAfter((n) => {
    let m = nodeHalfW(/** @type {import("d3").HierarchyPointNode<{ label: string; rank?: string }>} */ (n));
    const ch = n.children;
    if (ch) {
      for (const c of ch) m = Math.max(m, map.get(c) ?? 0);
    }
    map.set(n, m);
  });
  return map;
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

/** Same deep link as the observation explorer: opens the taxon in the iNaturalist mobile app when installed. */
function taxonAppHrefForId(id) {
  const sid = id != null ? String(id).trim() : "";
  if (!sid) return "https://www.inaturalist.org/";
  return `inaturalist://taxa/${sid}`;
}

/** @param {object | null} taxon */
function taxonHref(taxon) {
  if (!taxon || taxon.id == null) return "https://www.inaturalist.org/";
  return taxonAppHrefForId(taxon.id);
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
  const ancRaw = Array.isArray(taxon.ancestor_ids)
    ? taxon.ancestor_ids.map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0)
    : [];
  /** Root-to-tip ids without duplicates (APIs may repeat ids or include the tip in `ancestor_ids`). */
  const out = [];
  const seen = new Set();
  for (const id of ancRaw) {
    if (id === selfId) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  if (!seen.has(selfId)) {
    seen.add(selfId);
    out.push(selfId);
  }
  return out;
}

/** iNaturalist `rank` slugs kept in the merged tree (Life uses `stateofmatter` in the API). */
const MAJOR_RANK_SLUGS = new Set([
  "domain",
  "kingdom",
  "phylum",
  "class",
  "order",
  "family",
  "genus",
  "species",
  "hybrid",
  "stateofmatter",
]);

/**
 * @param {string} rankLower
 */
function isMajorRankSlug(rankLower) {
  return MAJOR_RANK_SLUGS.has(rankLower);
}

/**
 * Root-to-tip ids along the lineage, keeping only major ranks plus the selected tip (any rank).
 * @param {object} taxon
 * @param {Map<number, object>} taxonById
 * @returns {number[]}
 */
function majorRankPathIdsForTaxon(taxon, taxonById) {
  const full = pathIdsForTaxon(taxon);
  const selfId = taxon.id != null ? Number(taxon.id) : NaN;
  const out = [];
  for (const id of full) {
    const t = taxonById.get(id);
    const isTip = Number.isFinite(selfId) && id === selfId;
    const rk = t && typeof t.rank === "string" ? t.rank.trim().toLowerCase() : "";
    const keep = isTip || !t || isMajorRankSlug(rk);
    if (keep && (out.length === 0 || out[out.length - 1] !== id)) out.push(id);
  }
  return out;
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
  const { common: commonName, scientific: scientificName } = taxonCommonScientificStrings(t, tid);
  const label =
    tid < 0 ? "Shared ancestry" : t ? taxonDisplayName(t) : `Taxon ${tid}`;
  const rank = tid < 0 ? "" : t && t.rank ? String(t.rank) : "";
  const href = tid < 0 ? "" : t ? taxonHref(t) : taxonAppHrefForId(tid);
  return {
    taxonId: tid,
    label,
    commonName,
    scientificName,
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

/**
 * Parse `taxa` / `ids` query values. Canonical delimiter is `-` (no URL-encoding needed for ids).
 * Also accepts commas, plus signs, and whitespace for older shared links.
 * @param {URLSearchParams} q
 */
function parseTaxaQuery(q) {
  const raw = q.get("taxa") || q.get("ids") || "";
  const parts = String(raw)
    .split(/[,+\s-]+/)
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
    if (ids.length) u.searchParams.set("taxa", ids.join("-"));
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
    const hw = nodeHalfW(dd);
    const hh = nodeHalfH(dd);
    x0 = Math.min(x0, dd.px - hw - padX);
    x1 = Math.max(x1, dd.px + hw + padX);
    y0 = Math.min(y0, dd.py - hh);
    y1 = Math.max(y1, dd.py + hh);
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

  let maxNodeH = 0;
  hRoot.each((d) => {
    maxNodeH = Math.max(maxNodeH, nodeBoxHeight(d));
  });
  const vStep = maxNodeH + NODE_VERT_GAP;

  const spanMap = subtreeMaxNodeHalfWidth(hRoot);
  const sep = (/** @type {import("d3").HierarchyNode<{ label: string; rank?: string }>} */ a, b) => {
    const gap = SIBLING_H_GAP;
    const hw = (/** @type {import("d3").HierarchyNode<{ label: string; rank?: string }>} */ n) =>
      nodeHalfW(/** @type {import("d3").HierarchyPointNode<{ label: string; rank?: string }>} */ (n));
    const same = (hw(a) + hw(b) + gap) / NODE_BREADTH_UNIT;
    if (a.parent === b.parent) return Math.max(1.02, same);
    const wa = spanMap.get(a) ?? hw(a);
    const wb = spanMap.get(b) ?? hw(b);
    return Math.max(1.35, (wa + wb + gap * 2) / NODE_BREADTH_UNIT);
  };

  const tree = d3.tree().nodeSize([NODE_BREADTH_UNIT, vStep]).separation(sep);
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

  let minLblY = Infinity;
  let maxLblY = -Infinity;
  let minEdgeX = Infinity;
  let maxEdgeX = -Infinity;
  hRoot.each((d) => {
    const hh = nodeHalfH(d);
    const hw = nodeHalfW(d);
    minLblY = Math.min(minLblY, d.py - hh);
    maxLblY = Math.max(maxLblY, d.py + hh);
    minEdgeX = Math.min(minEdgeX, d.px - hw);
    maxEdgeX = Math.max(maxEdgeX, d.px + hw);
  });
  const viewY = Number.isFinite(minLblY) ? Math.min(0, minLblY - 10) : 0;
  const maxPy = hRoot.descendants().reduce((m, d) => Math.max(m, d.py), 0);

  const padOuter = 14;
  const lowX = (Number.isFinite(minEdgeX) ? minEdgeX : 0) - padOuter;
  const highX = (Number.isFinite(maxEdgeX) ? maxEdgeX : 0) + padOuter;
  const viewX = Math.min(0, lowX);
  const contentW = highX - viewX + M.right;
  const contentH = Math.max(maxLblY + M.bottom + 28, maxPy + M.bottom + 24) - viewY;

  const svg = d3
    .create("svg")
    .attr("class", "tree-viz-svg")
    .attr("viewBox", `${viewX} ${viewY} ${contentW} ${contentH}`)
    .attr("width", "100%")
    .attr("height", Math.min(780, Math.max(380, contentH)))
    .attr("role", "img")
    .attr("aria-label", "Taxonomic tree diagram");

  const innerG = svg.append("g").attr("class", "tree-zoom-inner");

  const zoom = d3
    .zoom()
    /** Min keeps the full tree reachable when zoomed out; max is effectively uncapped for scroll/pinch zoom-in. */
    .scaleExtent([0.08, 1e6])
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
    const syOut = sy + nodeHalfH(s);
    const tyIn = ty - nodeHalfH(t);
    const mid = (syOut + tyIn) / 2;
    return `M${sx},${syOut}C${sx},${mid} ${tx},${mid} ${tx},${tyIn}`;
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

  nodes.each(function (d) {
    const g = d3.select(this);
    const hw = nodeHalfW(d);
    const hh = nodeHalfH(d);
    const expandable = Boolean(d.children || d._children);
    const hasHref = Boolean(d.data.href && String(d.data.href).length > 1);
    const titlePlain = taxonNodeTitlePlain(d);
    g.append("title").text(titlePlain);

    const tw = expandable ? TOGGLE_STRIP_W : 0;
    const iconReserve = hasHref ? APP_LINK_ICON_RESERVE : 0;
    const innerW = Math.max(16, 2 * hw - tw - 12 - iconReserve);
    const innerTx = tw > 0 ? TOGGLE_STRIP_W / 2 : 0;
    const common = labelDisplayCommonInCell(d, innerW);
    const sci = labelDisplayScientificInCell(d, innerW);
    const rank = labelDisplayRankInCell(d, innerW);
    const ys = labelStackHangYs(d);

    const branchTone = expandable ? "#cfe8d9" : "#d8f3dc";
    const strokeTone = expandable ? "#2d6a4f" : "#40916c";

    g.append("rect")
      .attr("class", "tree-node-bg")
      .attr("x", -hw)
      .attr("y", -hh)
      .attr("width", 2 * hw)
      .attr("height", 2 * hh)
      .attr("rx", 10)
      .attr("ry", 10)
      .attr("fill", branchTone)
      .attr("stroke", strokeTone)
      .attr("stroke-width", 1.35)
      .style("pointer-events", "none");

    if (expandable) {
      g.append("rect")
        .attr("class", "tree-node-toggle-strip")
        .attr("x", -hw)
        .attr("y", -hh)
        .attr("width", TOGGLE_STRIP_W)
        .attr("height", 2 * hh)
        .attr("fill", "transparent")
        .style("cursor", "pointer")
        .on("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          toggleCollapse(d);
          mountD3Tree(host, hRoot, taxonById, { preserveZoom: true });
        });
    }

    const labelG = g.append("g").attr("class", "tree-node-label-wrap").attr("transform", `translate(${innerTx},0)`);

    if (ys.hasCommon && common) {
      labelG
        .append("text")
        .attr("class", "tree-node-label")
        .attr("x", 0)
        .attr("y", /** @type {number} */ (ys.yCommon))
        .attr("text-anchor", "middle")
        .attr("dominant-baseline", "hanging")
        .text(common);
    }

    labelG
      .append("text")
      .attr("class", ys.hasCommon && common ? "tree-node-scientific" : "tree-node-label")
      .attr("x", 0)
      .attr("y", ys.yScientific)
      .attr("text-anchor", "middle")
      .attr("dominant-baseline", "hanging")
      .text(sci || String(d.data.scientificName || d.data.label || "").trim());

    if (ys.hasRank && rank && ys.yRank != null) {
      labelG
        .append("text")
        .attr("class", "tree-node-rank")
        .attr("x", 0)
        .attr("y", ys.yRank)
        .attr("text-anchor", "middle")
        .attr("dominant-baseline", "hanging")
        .text(rank);
    }

    if (hasHref) {
      const hit = 22;
      const ax = hw - hit - 1;
      const ay = -hh + 1;
      const tipRaw = titlePlain.length > 80 ? `${titlePlain.slice(0, 77)}…` : titlePlain;
      const tipName = tipRaw.replace(/"/g, "'");
      const linkA = g
        .append("a")
        .attr("class", "tree-node-app-link")
        .attr("href", d.data.href)
        .attr("aria-label", `Open ${tipName} in the iNaturalist app`)
        .attr("title", "Open in iNaturalist app");
      linkA
        .append("rect")
        .attr("class", "tree-node-app-link-hit")
        .attr("x", ax)
        .attr("y", ay)
        .attr("width", hit)
        .attr("height", hit)
        .attr("rx", 5)
        .attr("ry", 5)
        .attr("fill", "transparent");
      linkA
        .append("path")
        .attr("class", "tree-node-app-link-icon")
        .attr("d", APP_LINK_ICON_PATH)
        .attr("transform", `translate(${ax + 4},${ay + 4}) scale(0.55)`)
        .attr("fill", strokeTone);
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
      const path = majorRankPathIdsForTaxon(t, taxonById);
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
