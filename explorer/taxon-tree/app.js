import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm";

const API = "https://api.inaturalist.org/v1";
const TAXA_FETCH_CHUNK = 40;

const M = { top: 36, right: 40, bottom: 36, left: 36 };
/** Horizontal spacing between sibling columns (d3 tree “breadth”). */
const NODE_BREADTH = 26;
/** Vertical spacing between parent and child rows (d3 tree “depth”). */
const NODE_DEPTH = 58;
/** Horizontal space reserved to the right of the rightmost node for labels. */
const LABEL_SLOT = 268;

/**
 * @param {string} pathAndQuery
 */
function inatFetch(pathAndQuery) {
  const trimmed = pathAndQuery.replace(/^\//, "");
  const u = new URL(trimmed, `${API}/`);
  u.searchParams.set("_cb", `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`);
  return fetch(u.href, { cache: "no-store" });
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
    const padY = dd.data?.rank ? 26 : 16;
    x0 = Math.min(x0, dd.px - padX);
    x1 = Math.max(x1, dd.px + LABEL_SLOT);
    y0 = Math.min(y0, dd.py - padY);
    y1 = Math.max(y1, dd.py + padY);
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
 */
function mountD3Tree(host, hRoot) {
  host.innerHTML = "";

  const toolbar = document.createElement("div");
  toolbar.className = "tree-viz-toolbar";
  toolbar.innerHTML = `<button type="button" class="btn secondary btn--sm" id="btn-zoom-reset">Reset zoom</button>
    <button type="button" class="btn secondary btn--sm" id="btn-expand-all">Expand all</button>`;

  const wrap = document.createElement("div");
  wrap.className = "tree-svg-wrap";

  const tree = d3
    .tree()
    .nodeSize([NODE_BREADTH, NODE_DEPTH])
    .separation((a, b) => (a.parent === b.parent ? 1.15 : 1.35));
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

  let maxPx = 0;
  let maxPy = 0;
  hRoot.each((d) => {
    maxPx = Math.max(maxPx, d.px);
    maxPy = Math.max(maxPy, d.py);
  });

  const contentW = maxPx + LABEL_SLOT + M.right;
  const contentH = maxPy + M.bottom + 20;

  const svg = d3
    .create("svg")
    .attr("class", "tree-viz-svg")
    .attr("viewBox", `0 0 ${contentW} ${contentH}`)
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
    .data(hRoot.descendants(), (/** @type {import("d3").HierarchyPointNode<{ taxonId: number }>} */ d) => String(d.data.taxonId))
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
      mountD3Tree(host, hRoot);
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
    const main = truncateLabel(d.data.label, 34);
    const rank = d.data.rank ? truncateLabel(String(d.data.rank), 22) : "";

    const parent = hasHref
      ? g
          .append("a")
          .attr("href", d.data.href)
          .attr("target", "_blank")
          .attr("rel", "noopener noreferrer")
      : g;

    const te = parent
      .append("text")
      .attr("class", "tree-node-label")
      .attr("fill", "#1a2e1a")
      .attr("x", 12)
      .attr("y", 0)
      .attr("dominant-baseline", "middle");
    te.append("tspan")
      .attr("x", 12)
      .attr("dy", rank ? "-0.52em" : "0")
      .text(main);
    if (rank) {
      te.append("tspan")
        .attr("class", "tree-node-rank")
        .attr("x", 12)
        .attr("dy", "1.08em")
        .text(rank);
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

  const svgEl = /** @type {SVGSVGElement} */ (svg.node());
  toolbar.querySelector("#btn-zoom-reset")?.addEventListener("click", () => {
    d3.select(svgEl).transition().duration(280).call(zoom.transform, d3.zoomIdentity);
  });
  toolbar.querySelector("#btn-expand-all")?.addEventListener("click", () => {
    expandAllUnder(hRoot);
    mountD3Tree(host, hRoot);
  });
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

    mountD3Tree(el.viz, hRoot);
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
