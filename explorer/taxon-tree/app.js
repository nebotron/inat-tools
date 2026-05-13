const API = "https://api.inaturalist.org/v1";
/** Cap bulk import so the tree and API stay responsive. */
const MAX_BULK_SPECIES = 100;
const TAXA_FETCH_CHUNK = 40;

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

/**
 * Very rough "crown age" guess from iNaturalist rank_level (higher = broader taxon).
 * Real ages vary enormously; this is only for casual visualization.
 * @param {number | null | undefined} rankLevel
 * @returns {number | null} millions of years ago, or null
 */
function approximateAgeMaFromRankLevel(rankLevel) {
  const rl = Number(rankLevel);
  if (!Number.isFinite(rl)) return null;
  if (rl >= 100) return null;
  if (rl >= 70) return 1200;
  if (rl >= 65) return 800;
  if (rl >= 60) return 550;
  if (rl >= 55) return 480;
  if (rl >= 50) return 400;
  if (rl >= 45) return 220;
  if (rl >= 40) return 120;
  if (rl >= 37) return 90;
  if (rl >= 35) return 70;
  if (rl >= 33) return 55;
  if (rl >= 30) return 45;
  if (rl >= 27) return 32;
  if (rl >= 23) return 22;
  if (rl >= 20) return 12;
  if (rl >= 17) return 6;
  if (rl >= 13) return 2.5;
  if (rl >= 10) return 0.8;
  return null;
}

/**
 * @param {number | null} ma
 */
function formatApproxMa(ma) {
  if (ma == null) return "";
  if (ma >= 1000) return `~${(ma / 1000).toFixed(1)} Ga`;
  if (ma >= 100) return `~${Math.round(ma)} Ma`;
  if (ma >= 1) return `~${Math.round(ma)} Ma`;
  if (ma >= 0.1) return `~${ma.toFixed(1)} Ma`;
  return "<1 Ma";
}

/** @param {object} taxon */
function taxonDisplayName(taxon) {
  if (!taxon || typeof taxon !== "object") return "";
  const cn = typeof taxon.preferred_common_name === "string" ? taxon.preferred_common_name.trim() : "";
  const nm = typeof taxon.name === "string" ? taxon.name.trim() : "";
  if (cn && nm && cn.toLowerCase() !== nm.toLowerCase()) return `${cn} (${nm})`;
  return cn || nm || `Taxon ${taxon.id ?? ""}`;
}

/** @param {object} taxon */
function taxonHref(taxon) {
  const id = taxon && taxon.id != null ? String(taxon.id).trim() : "";
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
 * @param {{ taxonId: number, children: Map<number, { taxonId: number, children: Map<number, unknown> }> }} node
 * @param {Map<number, object>} taxonById
 * @param {boolean} isRoot
 */
function renderCladeHtml(node, taxonById, isRoot) {
  const taxon = taxonById.get(node.taxonId);
  const name = taxon ? taxonDisplayName(taxon) : `Taxon ${node.taxonId}`;
  const rank = taxon && taxon.rank ? String(taxon.rank) : "";
  const rl = taxon && taxon.rank_level != null ? Number(taxon.rank_level) : NaN;
  const ageMa = taxon ? approximateAgeMaFromRankLevel(rl) : null;
  const ageLabel = ageMa != null ? formatApproxMa(ageMa) : "";
  const href = taxon ? taxonHref(taxon) : `https://www.inaturalist.org/taxa/${node.taxonId}`;
  const kids = [...node.children.values()].sort((a, b) => {
    const ta = taxonById.get(a.taxonId);
    const tb = taxonById.get(b.taxonId);
    const ra = ta && ta.rank_level != null ? Number(ta.rank_level) : 0;
    const rb = tb && tb.rank_level != null ? Number(tb.rank_level) : 0;
    if (ra !== rb) return ra - rb;
    const na = ta ? taxonDisplayName(ta) : "";
    const nb = tb ? taxonDisplayName(tb) : "";
    return na.localeCompare(nb);
  });

  const wrapCls = isRoot ? "clade clade--root" : "clade";
  const ageHtml =
    ageLabel && kids.length > 0
      ? `<span class="clade-age" title="Rough rank-based guess for this clade; not a calibrated date.">${escapeHtml(ageLabel)}</span>`
      : "";

  const head = `<div class="clade-head">
    <a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(name)}</a>
    ${rank ? `<span class="clade-rank">${escapeHtml(rank)}</span>` : ""}
    ${ageHtml}
  </div>`;

  if (!kids.length) {
    return `<div class="${wrapCls}">${head}</div>`;
  }
  const inner = kids.map((ch) => renderCladeHtml(ch, taxonById, false)).join("");
  return `<div class="${wrapCls}">${head}<div class="clade-kids">${inner}</div></div>`;
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

    const root = { taxonId: -1, children: new Map() };
    for (const tid of tipIds) {
      const t = taxonById.get(tid);
      if (!t) continue;
      const path = pathIdsForTaxon(t);
      if (path.length) insertPath(root, path);
    }

    const topLevel = [...root.children.values()];
    if (!topLevel.length) {
      el.viz.innerHTML = `<p class="tree-empty">No paths to display.</p>`;
      return;
    }
    if (topLevel.length === 1) {
      el.viz.innerHTML = renderCladeHtml(topLevel[0], taxonById, true);
    } else {
      const inner = topLevel.map((n) => renderCladeHtml(n, taxonById, false)).join("");
      el.viz.innerHTML = `<div class="clade clade--root"><div class="clade-kids">${inner}</div></div>`;
    }
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
    while (collected.length < MAX_BULK_SPECIES) {
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
        if (collected.length >= MAX_BULK_SPECIES) break;
      }
      if (rows.length < 200) break;
      page += 1;
      if (page > 5) break;
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
    const totalNote = collected.length >= MAX_BULK_SPECIES ? ` (capped at ${MAX_BULK_SPECIES} for performance)` : "";
    if (el.bulkStatus) el.bulkStatus.textContent = `Added ${collected.length} species${totalNote}.`;
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
