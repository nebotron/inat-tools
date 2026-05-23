import {
  INAT_API_V1 as API,
  getStoredInatApiJwt,
  validateInatJwtFormat,
  parseInatApiTokenPaste,
  persistParsedInatApiJwt,
  clearStoredInatApiJwt,
  inatApiJwtAuthorizationValue,
  formatInatHttpErrorForDisplay,
  fetchUsersMeWithStoredJwt,
  inatFetch,
  inatPostV2MethodOverrideGet,
} from "../lib/inat-api-client.js";
import { installExplorerImagePinchZoom } from "./pinch-zoom-images.js";

/**
 * Report an exception via fatal full-page dump (see fatal-dump-bootstrap.js).
 * @param {unknown} reason
 * @param {string} [contextLabel]
 * @param {string} [appendix] Optional extra text appended to the dump (e.g. diagnostics).
 */
function explorerFatal(reason, contextLabel = "", appendix) {
  const g = typeof globalThis !== "undefined" ? globalThis : undefined;
  if (g && typeof g.explorerReportFatalException === "function") {
    g.explorerReportFatalException(reason, contextLabel || "(no context)", appendix);
    return;
  }
  const err = reason instanceof Error ? reason : new Error(String(reason));
  console.error(contextLabel, err);
  throw err;
}

function isAndroidBrowser() {
  return typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent || "");
}

function isIOSOrIPadOS() {
  const ua = navigator.userAgent || "";
  if (/iPhone|iPad|iPod/i.test(ua)) return true;
  if (typeof navigator !== "undefined" && navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1) {
    return true;
  }
  return false;
}

/**
 * `navigator.share({ files })` with more than one file has caused hard tab crashes on
 * Chrome (Android) and WebKit (iOS Safari); fall back to per-file downloads.
 */
function isWebShareMultiFileUnsafe() {
  return isAndroidBrowser() || isIOSOrIPadOS();
}

/**
 * Pathname + query in a stable form for BFCache `pageshow` and sync tracking.
 * Sorts query keys so harmless `replaceState` ordering differences (and some UA
 * serializations of the same logical URL) are not treated as navigation, which
 * would resync from the URL and clear the Observations grid.
 * @param {string} href
 */
function explorerStableRoutingKeyFromHref(href) {
  try {
    const u = new URL(href);
    const keys = [...new Set(u.searchParams.keys())].sort((a, b) => a.localeCompare(b));
    const q2 = new URLSearchParams();
    for (const key of keys) {
      for (const val of u.searchParams.getAll(key)) {
        q2.append(key, val);
      }
    }
    const qs = q2.toString();
    return u.pathname + (qs ? `?${qs}` : "");
  } catch {
    if (typeof href !== "string") return "";
    const hash = href.indexOf("#");
    return hash >= 0 ? href.slice(0, hash) : href;
  }
}

const OBS_PER_PAGE = 60;

/** Set by `refreshInatAuthUser`; used for Agree UI on observation cards. */
let inatAuthUser = null;

/**
 * Last `location.href` after the explorer applied its filters to the address bar (`syncUrl`, etc.).
 * Used to skip `pageshow` BFCache resync when the URL did not change (e.g. app switch / resume).
 */
let lastExplorerLocationHref = window.location.href;

/** Stable pathname + query (see `explorerStableRoutingKeyFromHref`) after the explorer last wrote the URL. */
let lastExplorerPathSearch = explorerStableRoutingKeyFromHref(window.location.href);

function noteExplorerLocationHrefApplied() {
  lastExplorerLocationHref = window.location.href;
  lastExplorerPathSearch = explorerStableRoutingKeyFromHref(window.location.href);
}

/**
 * Shared `near_me=1` links omit lat/lng. Each full page load requests a fresh browser position
 * (see `resolvePendingNearMeUrlIfNeeded`) before the first search.
 */

/** Taxon page on iNaturalist (HTTPS works in every browser; some mobile setups still open the native app). */
function inaturalistTaxonWebUrl(taxonId) {
  const id = taxonId != null ? String(taxonId).trim() : "";
  if (!id) return "https://www.inaturalist.org/";
  return `https://www.inaturalist.org/taxa/${id}`;
}

/**
 * Lazy-loaded King County noxious-weed data: full taxon id set, per-id class + href, and hawkweed subgenus links.
 * @type {{
 *   allIds: Set<number>,
 *   byTaxonId: Map<number, { weedClass: string, href: string }>,
 *   meadowHawkweedGenusId: number,
 *   wallHawkweedGenusId: number,
 *   autumnHawkweedTaxonIds: Set<number>,
 *   meadowHawkweedHref: string,
 *   wallHawkweedHref: string,
 * } | null}
 */
let kingCountyNoxiousData = null;

async function ensureKingCountyNoxiousData() {
  if (kingCountyNoxiousData !== null) return kingCountyNoxiousData;
  try {
    const url = new URL("./king-county-noxious-weeds.json", import.meta.url);
    const res = await fetch(url.href);
    if (!res.ok) {
      kingCountyNoxiousData = {
        allIds: new Set(),
        byTaxonId: new Map(),
        meadowHawkweedGenusId: 203680,
        wallHawkweedGenusId: 55910,
        autumnHawkweedTaxonIds: new Set([163800]),
        meadowHawkweedHref:
          "https://kingcounty.gov/en/dept/dnrp/nature-recreation/environment-ecology-conservation/noxious-weeds/identification-control/meadow-hawkweed-subgenus",
        wallHawkweedHref:
          "https://kingcounty.gov/en/dept/dnrp/nature-recreation/environment-ecology-conservation/noxious-weeds/identification-control/wall-hawkweed-subgenus",
      };
      return kingCountyNoxiousData;
    }
    const data = await res.json();
    const taxa = Array.isArray(data.taxa) ? data.taxa : [];
    const allIds = new Set();
    const byTaxonId = new Map();
    let meadowHref = "";
    let wallHref = "";
    for (const row of taxa) {
      const id = row.taxonId != null ? Number(row.taxonId) : NaN;
      if (!Number.isFinite(id) || id <= 0) continue;
      const weedClass = typeof row.class === "string" ? row.class.trim().toUpperCase() : "";
      const href = typeof row.href === "string" ? row.href.trim() : "";
      if (weedClass !== "A" && weedClass !== "B" && weedClass !== "C") continue;
      if (!href) continue;
      allIds.add(id);
      byTaxonId.set(id, { weedClass, href });
      const sci = typeof row.scientificName === "string" ? row.scientificName : "";
      if (sci.includes("subgenus Pilosella")) meadowHref = href;
      if (sci.includes("subgenus Hieracium")) wallHref = href;
    }
    kingCountyNoxiousData = {
      allIds,
      byTaxonId,
      meadowHawkweedGenusId: 203680,
      wallHawkweedGenusId: 55910,
      autumnHawkweedTaxonIds: new Set([163800]),
      meadowHawkweedHref: meadowHref || "https://kingcounty.gov/en/dept/dnrp/nature-recreation/environment-ecology-conservation/noxious-weeds/identification-control/meadow-hawkweed-subgenus",
      wallHawkweedHref: wallHref || "https://kingcounty.gov/en/dept/dnrp/nature-recreation/environment-ecology-conservation/noxious-weeds/identification-control/wall-hawkweed-subgenus",
    };
    return kingCountyNoxiousData;
  } catch (ex) {
    explorerFatal(ex, "ensureKingCountyNoxiousData");
  }
}

/**
 * King County noxious match for this taxon (including genus-level hawkweed rules), or null.
 * @param {object | null | undefined} taxon
 * @param {Awaited<ReturnType<typeof ensureKingCountyNoxiousData>>} kc
 */
function kingCountyNoxiousMatchForTaxon(taxon, kc) {
  if (!kc || !kc.byTaxonId.size || !taxon || typeof taxon !== "object") return null;
  const tid = taxon.id != null ? Number(taxon.id) : NaN;
  if (!Number.isNaN(tid) && kc.byTaxonId.has(tid)) return kc.byTaxonId.get(tid);
  const ancestors = Array.isArray(taxon.ancestor_ids) ? taxon.ancestor_ids : [];
  const autumn = kc.autumnHawkweedTaxonIds || new Set();
  const isAutumnHawkweed =
    autumn.has(tid) || ancestors.some((a) => autumn.has(Number(a)));
  for (let i = ancestors.length - 1; i >= 0; i -= 1) {
    const aid = Number(ancestors[i]);
    if (!Number.isFinite(aid)) continue;
    if (aid === kc.meadowHawkweedGenusId) {
      return { weedClass: "B", href: kc.meadowHawkweedHref };
    }
    if (aid === kc.wallHawkweedGenusId) {
      if (isAutumnHawkweed) continue;
      return { weedClass: "B", href: kc.wallHawkweedHref };
    }
    if (kc.byTaxonId.has(aid)) return kc.byTaxonId.get(aid);
  }
  return null;
}
const SPECIES_PER_PAGE = 60;
/** iNaturalist caps `per_page` at 200; above this we show the density grid instead of pins. */
const MAP_PIN_THRESHOLD = 200;
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Larger on touch / narrow viewports so pins are easier to tap than the default 4px dot. */
function mapPinMarkerRadius() {
  try {
    const mq = window.matchMedia.bind(window);
    if (mq("(pointer: coarse)").matches || mq("(any-pointer: coarse)").matches) return 12;
    if (mq("(max-width: 900px)").matches) return 10;
  } catch (ex) {
    explorerFatal(ex, "mapPinMarkerRadius");
  }
  return 4;
}

let currentView = "filters";
/** Offset page for species_counts only; observation lists use cursor pagination (`id_below` / `id_above`) to avoid duplicate rows when the result set shifts. */
let speciesPage = 1;
let obsHasMore = false;
let speciesHasMore = false;
let obsLoading = false;
let speciesLoading = false;
let statsLoading = false;
let mapSearchSeq = 0;
let mapActiveRequests = 0;
let totalObs = 0;
let totalSpecies = 0;
/** Avoid `querySelectorAll('.card')` on large grids (expensive on scroll). */
let obsCardCount = 0;
let speciesCardCount = 0;
/** Minimum observation id from the last API page — `id_below` for descending sort (recent / faves). */
let obsListCursorId = null;
/** Maximum observation id from the last API page — `id_above` for ascending upload time (`oldest`). */
let obsListCursorAscId = null;
/** Observation ids already rendered; skips duplicates if any slip through. */
const obsSeenIds = new Set();

let map = null;
let pinsLayer = null;
/** Observation pins sit below this layer so the user location dot stays visible on top. */
let mapUserLocationLayer = null;
/** `navigator.geolocation.watchPosition` id while Map tab is active; cleared when leaving Map. */
let mapGeolocationWatchId = null;
let heatGridLayer = null;
let pendingHeatLayer = null;
let mapMoveTimer = null;
let currentHeatUrl = null;
let mapMode = null;
let lastMapFilterKey = null;
/** Debounced `invalidateSize` when the Map tab is active (`trackResize` is disabled on the map). */
let mapWindowResizeRaf = 0;
let mapWindowResizeListenerInstalled = false;

/** "none" | fixed lat/lng in URL; "button" | "url" = near me, share as `near_me` not coordinates */
let nearMeSource = "none";

/** True when the user is filtering by nearby (radius + optional GPS), not by a named place. */
let placeNearbyMode = false;

/** Last committed label shown in the place field (cleared when the user edits the field). */
let placeInputCommitted = "";

let detailTaxonId = null;

/** Positive taxon filters (include); iNaturalist `taxon_id` comma list. */
let taxonIncludeFilters = [];
/** Negative taxon filters (exclude); iNaturalist `without_taxon_id` comma list. */
let taxonExcludeFilters = [];

const el = {
  taxonInput: document.getElementById("taxon-input"),
  taxonSuggestions: document.getElementById("taxon-suggestions"),
  taxonSelectedStack: document.getElementById("taxon-selected-stack"),
  placeInputWrap: document.getElementById("place-input-wrap"),
  placeInput: document.getElementById("place-input"),
  placeId: document.getElementById("place-id"),
  placeSuggestions: document.getElementById("place-suggestions"),
  btnClearPlace: document.getElementById("btn-clear-place"),
  userLogin: document.getElementById("user-login"),
  unobservedInput: document.getElementById("unobserved-input"),
  inatApiToken: document.getElementById("inat-api-token"),
  btnInatApiTokenApply: document.getElementById("btn-inat-api-token-apply"),
  btnInatApiTokenClear: document.getElementById("btn-inat-api-token-clear"),
  inatApiAuthStatus: document.getElementById("inat-api-auth-status"),
  btnExplorerAuthToggle: document.getElementById("btn-explorer-auth-toggle"),
  explorerAuthPanel: document.getElementById("explorer-auth-panel"),
  btnExplorerAuthPanelClose: document.getElementById("btn-explorer-auth-panel-close"),
  radiusKm: document.getElementById("radius-km"),
  nearbyControls: document.getElementById("nearby-controls"),
  lat: document.getElementById("lat"),
  lng: document.getElementById("lng"),
  filterEstEndemic: document.getElementById("filter-est-endemic"),
  filterEstNative: document.getElementById("filter-est-native"),
  filterEstIntroduced: document.getElementById("filter-est-introduced"),
  filterEstInvasive: document.getElementById("filter-est-invasive"),
  qualityGrade: document.getElementById("quality-grade"),
  sortMode: document.getElementById("sort-mode"),
  filterMyReview: document.getElementById("filter-my-review"),
  filterFavedByMe: document.getElementById("filter-faved-by-me"),
  mediaPhotos: document.getElementById("media-photos"),
  mediaSounds: document.getElementById("media-sounds"),
  observedDays: document.getElementById("observed-days"),
  uploadedDays: document.getElementById("uploaded-days"),
  popularOnly: document.getElementById("popular-only"),
  metaFaves: document.getElementById("meta-faves"),
  metaSpeciesCount: document.getElementById("meta-species-count"),
  metaObserver: document.getElementById("meta-observer"),
  metaLocation: document.getElementById("meta-location"),
  metaNativeStatus: document.getElementById("meta-native-status"),
  metaConservationStatus: document.getElementById("meta-conservation-status"),
  metaGrade: document.getElementById("meta-grade"),
  metaObsDate: document.getElementById("meta-obs-date"),
  metaPhotoPage: document.getElementById("meta-photo-page"),
  metaSciName: document.getElementById("meta-sci-name"),
  metaFavoriteControl: document.getElementById("meta-favorite-control"),
  metaIdentifyControls: document.getElementById("meta-identify-controls"),
  handLayoutRight: document.getElementById("hand-layout-right"),
  handLayoutLeft: document.getElementById("hand-layout-left"),
  searchForm: document.getElementById("search-form"),
  btnReset: document.getElementById("btn-reset"),
  btnCopyLink: document.getElementById("btn-copy-link"),
  btnRefreshMap: document.getElementById("btn-refresh-map"),
  btnRefreshStats: document.getElementById("btn-refresh-stats"),
  btnRefreshDetail: document.getElementById("btn-refresh-detail"),
  tabs: document.querySelectorAll(".tab"),
  panelFilters: document.getElementById("panel-filters"),
  panelObs: document.getElementById("panel-observations"),
  panelSpecies: document.getElementById("panel-species"),
  panelStats: document.getElementById("panel-stats"),
  panelMap: document.getElementById("panel-map"),
  resultsGrid: document.getElementById("results-grid"),
  speciesGrid: document.getElementById("species-grid"),
  obsError: document.getElementById("error-banner-obs"),
  speciesError: document.getElementById("error-banner-species"),
  searchSummaryObs: document.getElementById("search-summary-obs"),
  searchSummarySpecies: document.getElementById("search-summary-species"),
  mapError: document.getElementById("error-banner-map"),
  statsError: document.getElementById("error-banner-stats"),
  placeGeoError: document.getElementById("error-banner-place"),
  searchSummaryStats: document.getElementById("search-summary-stats"),
  statsContent: document.getElementById("stats-content"),
  obsSentinel: document.getElementById("obs-sentinel"),
  speciesSentinel: document.getElementById("species-sentinel"),
  mapContainer: document.getElementById("map-container"),
  mapLoading: document.getElementById("map-loading"),
  panelDetail: document.getElementById("panel-detail"),
  detailContent: document.getElementById("detail-content"),
};

function showMapSpinner() {
  mapActiveRequests += 1;
  el.mapLoading.hidden = false;
}

function hideMapSpinner() {
  mapActiveRequests = Math.max(0, mapActiveRequests - 1);
  if (mapActiveRequests === 0) el.mapLoading.hidden = true;
}

let taxonDebounce = null;
let placeDebounce = null;
let unobsDebounce = null;
/** Debounce URL updates from the Filters tab (no iNaturalist list/map API calls until a result tab is opened). */
let urlSyncDebounce = null;
let taxonHighlight = -1;
let placeHighlight = -1;
let unobsHighlight = -1;

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s || "";
  return d.innerHTML;
}

const NEARBY_SUGGESTION = { __nearby: true };

function parseTaxonCsvParam(raw) {
  if (!raw || typeof raw !== "string") return [];
  return [
    ...new Set(
      raw
        .split(",")
        .map((x) => Number(String(x).trim()))
        .filter((n) => Number.isFinite(n) && n > 0)
    ),
  ];
}

/** URL `taxon_inc` / `taxon_exc`: `id|urlencodedLabel` segments separated by commas. */
function parseTaxonLabeledParam(raw) {
  if (!raw || typeof raw !== "string") return [];
  const out = [];
  for (const seg of raw.split(",")) {
    const s = seg.trim();
    if (!s) continue;
    const pipe = s.indexOf("|");
    if (pipe === -1) {
      const id = Number(s);
      if (Number.isFinite(id) && id > 0) out.push({ id, label: `Taxon ${id}` });
      continue;
    }
    const id = Number(s.slice(0, pipe).trim());
    let label = "";
    try {
      label = decodeURIComponent(s.slice(pipe + 1));
    } catch {
      label = s.slice(pipe + 1);
    }
    if (Number.isFinite(id) && id > 0) out.push({ id, label: label.trim() || `Taxon ${id}` });
  }
  return out;
}

function formatTaxonLabeledParam(filters) {
  return (filters || [])
    .filter((f) => f && Number.isFinite(f.id) && f.id > 0)
    .map((f) => `${f.id}|${encodeURIComponent(taxonFilterLabel(f))}`)
    .join(",");
}

function formatTaxonCsvParam(filters) {
  const ids = (filters || []).map((f) => f.id).filter((n) => Number.isFinite(n) && n > 0);
  const uniq = [...new Set(ids)];
  return uniq.sort((a, b) => a - b).join(",");
}

function mergeTaxonCsvParam(baseCsv, extraIds) {
  const set = new Set(parseTaxonCsvParam(baseCsv));
  for (const id of extraIds) {
    const n = Number(id);
    if (Number.isFinite(n) && n > 0) set.add(n);
  }
  return [...set].sort((a, b) => a - b).join(",");
}

function taxonFilterLabel(f) {
  if (!f) return "";
  const lab = typeof f.label === "string" ? f.label.trim() : "";
  return lab || `Taxon ${f.id}`;
}

function renderTaxonSelectedStack() {
  if (!el.taxonSelectedStack) return;
  el.taxonSelectedStack.innerHTML = "";
  const rows = [
    ...taxonIncludeFilters.map((f) => ({ ...f, sign: "+", cls: "taxon-pill--include" })),
    ...taxonExcludeFilters.map((f) => ({ ...f, sign: "−", cls: "taxon-pill--exclude" })),
  ];
  if (!rows.length) return;
  rows.sort((a, b) => a.id - b.id);
  for (const { id, sign, cls, label } of rows) {
    const pill = document.createElement("span");
    pill.className = `selected-pill taxon-pill ${cls}`;
    pill.dataset.taxonId = String(id);
    const short = taxonFilterLabel({ id, label });
    pill.innerHTML = `<span class="taxon-pill-sign" aria-hidden="true">${sign}</span><span class="taxon-pill-label">${escapeHtml(short)}</span><button type="button" class="taxon-pill-remove" aria-label="Remove taxon filter">×</button>`;
    pill.querySelector("button").addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      taxonIncludeFilters = taxonIncludeFilters.filter((x) => x.id !== id);
      taxonExcludeFilters = taxonExcludeFilters.filter((x) => x.id !== id);
      renderTaxonSelectedStack();
      lastMapFilterKey = null;
      scheduleUrlSync();
      queueMicrotask(() => refreshResultPanelsIfMetaChanged());
    });
    el.taxonSelectedStack.appendChild(pill);
  }
}

function appendTaxonFilter(isInclude, id, label) {
  const tid = Number(id);
  if (!Number.isFinite(tid) || tid <= 0) return;
  const lab = typeof label === "string" && label.trim() ? label.trim() : `Taxon ${tid}`;
  const entry = { id: tid, label: lab };
  if (isInclude) {
    taxonExcludeFilters = taxonExcludeFilters.filter((x) => x.id !== tid);
    if (!taxonIncludeFilters.some((x) => x.id === tid)) taxonIncludeFilters.push(entry);
  } else {
    taxonIncludeFilters = taxonIncludeFilters.filter((x) => x.id !== tid);
    if (!taxonExcludeFilters.some((x) => x.id === tid)) taxonExcludeFilters.push(entry);
  }
  renderTaxonSelectedStack();
  el.taxonInput.value = "";
  hideSuggestion("taxon");
  lastMapFilterKey = null;
  scheduleUrlSync();
  queueMicrotask(() => refreshResultPanelsIfMetaChanged());
}

function clampRadiusKm(n) {
  const x = Math.round(Number(n));
  if (Number.isNaN(x)) return 25;
  return Math.min(500, Math.max(1, x));
}

/** Radius used for API and URL while the field may be temporarily empty during editing. */
function effectiveRadiusKm() {
  const raw = String(el.radiusKm.value ?? "").trim();
  if (raw === "") return 25;
  return clampRadiusKm(raw);
}

function updatePlaceNearbyUI() {
  if (el.nearbyControls) el.nearbyControls.hidden = !placeNearbyMode;
}

function syncPlaceClearButton() {
  if (!el.btnClearPlace) return;
  const active = Boolean(el.placeId.value.trim() || placeNearbyMode);
  el.btnClearPlace.hidden = !active;
}

function setCommittedPlaceDisplay(text) {
  placeInputCommitted = text || "";
  el.placeInput.value = placeInputCommitted;
  syncPlaceClearButton();
}

function clearPlaceFilter() {
  clearNearbyGeolocationFailureMessage();
  placeNearbyMode = false;
  nearMeSource = "none";
  el.placeId.value = "";
  el.lat.value = "";
  el.lng.value = "";
  setCommittedPlaceDisplay("");
  updatePlaceNearbyUI();
  void onLocationFilterChanged();
}

function formatCountLabel(n, singular, plural) {
  const c = n == null || Number.isNaN(Number(n)) ? 0 : Number(n);
  return c === 1 ? `1 ${singular}` : `${c.toLocaleString()} ${plural}`;
}

function updateSearchSummaryElements() {
  if (el.searchSummaryObs) {
    el.searchSummaryObs.textContent = formatCountLabel(totalObs, "observation", "observations");
  }
  if (el.searchSummarySpecies) {
    el.searchSummarySpecies.textContent = formatCountLabel(totalSpecies, "species", "species");
  }
  setSearchSummaryVisibility();
}

function setSearchSummaryVisibility() {
  const obsOn = currentView === "observations";
  const speciesOn = currentView === "species";
  const statsOn = currentView === "stats";
  if (el.searchSummaryObs) {
    el.searchSummaryObs.hidden = !obsOn || !el.searchSummaryObs.textContent.trim();
  }
  if (el.searchSummarySpecies) {
    el.searchSummarySpecies.hidden = !speciesOn || !el.searchSummarySpecies.textContent.trim();
  }
  if (el.searchSummaryStats) {
    el.searchSummaryStats.hidden = !statsOn || !el.searchSummaryStats.textContent.trim();
  }
}

/** Same ranking as iNaturalist mobile search — prefers metros / high-traffic places over substring prefix matches. */
async function fetchPlacesForAutocomplete(query) {
  const q = query.trim();
  if (q.length < 2) return [];
  const p = new URLSearchParams({ q, sources: "places", per_page: "12" });
  const la = el.lat.value.trim();
  const ln = el.lng.value.trim();
  if (la && ln) {
    const laNum = parseFloat(la);
    const lnNum = parseFloat(ln);
    if (!Number.isNaN(laNum) && !Number.isNaN(lnNum)) {
      p.set("lat", String(laNum));
      p.set("lng", String(lnNum));
    }
  }
  const res = await inatFetch(`search?${p.toString()}`);
  if (!res.ok) return [];
  const data = await res.json();
  const rows = data.results || [];
  return rows
    .filter((row) => row && row.type === "Place" && row.record && row.record.id != null)
    .map((row) => row.record);
}

/** Canonical HTTPS observation URL on www.inaturalist.org (used by “open on iNaturalist”). */
function inatObservationWebUrl(obsId) {
  const id = Math.floor(Number(obsId));
  if (!Number.isFinite(id) || id <= 0) return "";
  return `https://www.inaturalist.org/observations/${id}`;
}

/**
 * Observation cards open iNaturalist in a new tab. On iOS/iPadOS, use `http://` so universal links
 * are less likely to capture the tap or destabilize the heavy observations grid (Safari).
 */
function inatObservationCardExternalHref(obsId) {
  const httpsUrl = inatObservationWebUrl(obsId);
  if (!httpsUrl) return "";
  if (isIOSOrIPadOS()) return httpsUrl.replace(/^https:\/\//i, "http://");
  return httpsUrl;
}

/** Full-size URL from an iNaturalist photo `url` field (CDN supports square, thumb, small, medium, large, original). */
function originalPhotoUrl(url) {
  if (!url) return "";
  return url.replace(/\/(square|thumb|small|medium|large|original)\./i, "/original.");
}

/** Medium derivative for in-grid display (many decoded originals while scrolling can OOM low-memory tabs). */
function mediumPhotoUrl(url) {
  if (!url) return "";
  return url.replace(/\/(square|thumb|small|medium|large|original)\./i, "/medium.");
}

/** Larger derivative (~1024px) for high-DPI `srcset` alongside `medium`. */
function largePhotoUrl(url) {
  if (!url) return "";
  return url.replace(/\/(square|thumb|small|medium|large|original)\./i, "/large.");
}

/** Display URL for grid/detail hero cards when `rawUrl` is present. */
function observationCardPhotoDisplayUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") return "";
  const trimmed = rawUrl.trim();
  if (!trimmed) return "";
  return mediumPhotoUrl(trimmed);
}

/** Display URLs for each observation photo (grid carousel), in API order. */
function observationPhotoDisplayUrlsFromObs(obs) {
  const photos = obs && Array.isArray(obs.photos) ? obs.photos : [];
  const out = [];
  for (const p of photos) {
    if (!p || !p.url) continue;
    const u = observationCardPhotoDisplayUrl(p.url);
    if (u) out.push(u);
  }
  return out;
}

function extensionFromPhotoUrl(url) {
  const m = String(url || "").match(/\.(jpe?g|png|gif|webp|heic|bmp)(\?|$)/i);
  return m ? `.${m[1].toLowerCase()}` : ".jpg";
}

function isJpegMagic(buf) {
  return buf && buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xd8;
}

/**
 * @param {object} px window.piexif
 * @param {Uint8Array} bin
 * @param {object} exifDict
 * @returns {string} binary string for piexif output
 */
function embedExifInJpegBinaryString(px, bin, exifDict) {
  let jpegStr = "";
  for (let i = 0; i < bin.length; i += 1) jpegStr += String.fromCharCode(bin[i]);
  let outStr = jpegStr;
  const hadExif = jpegStr.indexOf("Exif\x00\x00") !== -1;
  if (hadExif) outStr = px.remove(jpegStr);
  const exifBytes = px.dump(exifDict);
  return px.insert(exifBytes, outStr);
}

function binaryStringToUint8Array(bin) {
  const len = bin.length;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) out[i] = bin.charCodeAt(i) & 0xff;
  return out;
}

function escapeFilenameSegment(s) {
  return String(s || "photo").replace(/[^\w.\-]+/g, "_").slice(0, 120) || "photo";
}

const EXIF_PAD2 = (n) => String(Math.max(0, Math.min(99, Number(n) || 0))).padStart(2, "0");

/**
 * Wall-clock components for EXIF DateTime / DateTimeOriginal (what the API reports as observed time,
 * not forced to UTC — many viewers expect local/wall time here).
 * @returns {{ y: number, mo: number, day: number, h: number, mi: number, s: number, subMs: number } | null}
 */
function observationWallClockParts(obs) {
  const raw = obs && obs.time_observed_at;
  if (raw && typeof raw === "string") {
    const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
    if (m) {
      let subMs = 0;
      const frac = raw.match(/\.(\d{1,3})/);
      if (frac) subMs = Number((frac[1] + "000").slice(0, 3)) || 0;
      return {
        y: Number(m[1]),
        mo: Number(m[2]),
        day: Number(m[3]),
        h: Number(m[4]),
        mi: Number(m[5]),
        s: Number(m[6]),
        subMs,
      };
    }
  }
  const s = obs && obs.observed_on_string;
  if (s && typeof s === "string") {
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
    if (m) {
      return {
        y: Number(m[1]),
        mo: Number(m[2]),
        day: Number(m[3]),
        h: Number(m[4]),
        mi: Number(m[5]),
        s: Number(m[6]),
        subMs: 0,
      };
    }
  }
  const det = obs && obs.observed_on_details;
  if (det && det.year != null) {
    return {
      y: Number(det.year),
      mo: Number(det.month ?? 1),
      day: Number(det.day ?? 1),
      h: Number(det.hour ?? 12),
      mi: 0,
      s: 0,
      subMs: 0,
    };
  }
  const on = obs && obs.observed_on;
  if (on && typeof on === "string" && /^\d{4}-\d{2}-\d{2}$/.test(on)) {
    const [y, mo, day] = on.split("-").map((x) => Number(x));
    return { y, mo, day, h: 12, mi: 0, s: 0, subMs: 0 };
  }
  return null;
}

function formatExifDateTimeFromWallClock(w) {
  if (!w) return null;
  return `${w.y}:${EXIF_PAD2(w.mo)}:${EXIF_PAD2(w.day)} ${EXIF_PAD2(w.h)}:${EXIF_PAD2(w.mi)}:${EXIF_PAD2(w.s)}`;
}

/**
 * GPS date/time in UTC per EXIF spec (from the same instant as `time_observed_at`).
 * @returns {{ dateStamp: string, timeStamp: number[][] } | null}
 */
function observationGpsUtcRational(obs) {
  const raw = obs && obs.time_observed_at;
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  const dateStamp = `${d.getUTCFullYear()}:${EXIF_PAD2(d.getUTCMonth() + 1)}:${EXIF_PAD2(d.getUTCDate())}`;
  const timeStamp = [
    [d.getUTCHours(), 1],
    [d.getUTCMinutes(), 1],
    [d.getUTCSeconds(), 1],
  ];
  return { dateStamp, timeStamp };
}

/**
 * @returns {number[] | null} GeoJSON Point [lng, lat]
 */
function observationLngLat(obs) {
  const g = obs && obs.geojson;
  if (!g || g.type !== "Point" || !Array.isArray(g.coordinates)) return null;
  const [lng, lat] = g.coordinates;
  const ln = Number(lng);
  const la = Number(lat);
  if (!Number.isFinite(ln) || !Number.isFinite(la)) return null;
  if (la < -90 || la > 90 || ln < -180 || ln > 180) return null;
  return [ln, la];
}

function buildExifDictForObservation(obs) {
  const px = typeof window !== "undefined" ? window.piexif : null;
  if (!px) return null;

  const exifDict = {
    "0th": {},
    Exif: {},
    GPS: {},
    Interop: {},
    "1st": {},
    thumbnail: null,
  };

  const wall = observationWallClockParts(obs);
  if (wall) {
    const dateTime = formatExifDateTimeFromWallClock(wall);
    if (dateTime) {
      exifDict["0th"][px.ImageIFD.DateTime] = dateTime;
      exifDict.Exif[px.ExifIFD.DateTimeOriginal] = dateTime;
      exifDict.Exif[px.ExifIFD.DateTimeDigitized] = dateTime;
      exifDict.Exif[px.ExifIFD.SubSecTimeOriginal] = String(wall.subMs).padStart(3, "0");
      exifDict.Exif[px.ExifIFD.SubSecTimeDigitized] = String(wall.subMs).padStart(3, "0");
    }
    exifDict.Exif[px.ExifIFD.ExifVersion] = "\x30\x32\x33\x30";
  }

  const ll = observationLngLat(obs);
  if (ll) {
    const [lng, lat] = ll;
    const latRef = lat >= 0 ? "N" : "S";
    const lngRef = lng >= 0 ? "E" : "W";
    const gpsLat = px.GPSHelper.degToDmsRational(Math.abs(lat));
    const gpsLng = px.GPSHelper.degToDmsRational(Math.abs(lng));
    exifDict.GPS[px.GPSIFD.GPSVersionID] = [2, 2, 0, 0];
    exifDict.GPS[px.GPSIFD.GPSLatitudeRef] = latRef;
    exifDict.GPS[px.GPSIFD.GPSLatitude] = gpsLat;
    exifDict.GPS[px.GPSIFD.GPSLongitudeRef] = lngRef;
    exifDict.GPS[px.GPSIFD.GPSLongitude] = gpsLng;
    exifDict.GPS[px.GPSIFD.GPSMapDatum] = "WGS-84";
    const gpsUtc = observationGpsUtcRational(obs);
    if (gpsUtc) {
      exifDict.GPS[px.GPSIFD.GPSDateStamp] = gpsUtc.dateStamp;
      exifDict.GPS[px.GPSIFD.GPSTimeStamp] = gpsUtc.timeStamp;
    }
  }

  const hasTime = wall != null;
  const hasGps = ll != null;
  if (!hasTime && !hasGps) return null;
  return exifDict;
}

/**
 * Fetch every observation photo at original size, embed EXIF on JPEGs when possible, then Web Share
 * all files or download each. Requires CORS on the image host for each URL.
 */
async function saveObservationPhotoWithExif(obs) {
  const px = typeof window !== "undefined" ? window.piexif : null;
  if (!px) {
    window.alert("Could not load photo tools. Try refreshing the page.");
    return;
  }
  const photos = obs && Array.isArray(obs.photos) ? obs.photos : [];
  if (!photos.length) {
    window.alert("No photos on this observation.");
    return;
  }

  const exifDict = buildExifDictForObservation(obs);
  const id = obs && obs.id != null ? String(obs.id) : "observation";
  const taxonBit = obs && obs.taxon && obs.taxon.name ? escapeFilenameSegment(obs.taxon.name) : "species";
  const obsTime = obs && obs.time_observed_at ? new Date(obs.time_observed_at) : null;
  const lastMod = obsTime && !Number.isNaN(obsTime.getTime()) ? obsTime.getTime() : Date.now();

  const files = [];

  for (let i = 0; i < photos.length; i += 1) {
    const photo = photos[i];
    const srcUrl = photo && photo.url ? originalPhotoUrl(photo.url) : "";
    if (!srcUrl) {
      continue;
    }
    const ext = extensionFromPhotoUrl(srcUrl);
    const baseName = photos.length > 1 ? `inat-${id}-${taxonBit}-photo-${i + 1}` : `inat-${id}-${taxonBit}`;

    let bin;
    try {
      const res = await fetch(srcUrl, { mode: "cors" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      bin = new Uint8Array(await res.arrayBuffer());
    } catch (ex) {
      explorerFatal(ex, "saveObservationPhotoWithExif:fetch");
    }

    if (isJpegMagic(bin) && exifDict) {
      try {
        const outStr = embedExifInJpegBinaryString(px, bin, exifDict);
        const out = binaryStringToUint8Array(outStr);
        const blob = new Blob([out], { type: "image/jpeg" });
        const name = `${baseName}.jpg`;
        files.push(new File([blob], name, { type: "image/jpeg", lastModified: lastMod }));
      } catch (ex) {
        explorerFatal(ex, "saveObservationPhotoWithExif:embedExifInJpegBinaryString");
      }
    } else if (isJpegMagic(bin)) {
      const blob = new Blob([bin], { type: "image/jpeg" });
      files.push(new File([blob], `${baseName}.jpg`, { type: "image/jpeg", lastModified: lastMod }));
    } else {
      const mime = ext === ".png" ? "image/png" : ext === ".gif" ? "image/gif" : ext === ".webp" ? "image/webp" : "application/octet-stream";
      const blob = new Blob([bin], { type: mime });
      files.push(new File([blob], `${baseName}${ext}`, { type: mime, lastModified: lastMod }));
    }
  }

  if (!files.length) {
    window.alert(
      "Could not load any photos in the browser (the host may block cross-origin access). Open the observation on iNaturalist to download photos."
    );
    return;
  }

  const sharePayload = { files };
  if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
    if (isWebShareMultiFileUnsafe() && files.length > 1) {
      /* Same multi-file + Web Share crash class as cropper / iOS Safari — fall through to per-file downloads. */
    } else {
      try {
        if (typeof navigator.canShare !== "function" || navigator.canShare(sharePayload)) {
          await navigator.share(sharePayload);
          return;
        }
      } catch (e) {
        if (e && e.name === "AbortError") return;
        console.warn("saveObservationPhotoWithExif:navigator.share", e);
      }
    }
  }

  for (let i = 0; i < files.length; i += 1) {
    const f = files[i];
    const a = document.createElement("a");
    const url = URL.createObjectURL(f);
    a.href = url;
    a.download = f.name;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    if (i < files.length - 1) {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

function showError(panel, msg) {
  const node =
    panel === "species"
      ? el.speciesError
      : panel === "map"
        ? el.mapError
        : panel === "stats"
          ? el.statsError
          : el.obsError;
  if (!node) return;
  node.textContent = msg;
  node.hidden = !msg;
}

function clearErrors() {
  showError("obs", "");
  showError("species", "");
  showError("map", "");
  showError("stats", "");
  clearNearbyGeolocationFailureMessage();
}

/**
 * Clears the Filters-tab banner for Nearby / geolocation failures.
 */
function clearNearbyGeolocationFailureMessage() {
  if (!el.placeGeoError) return;
  el.placeGeoError.textContent = "";
  el.placeGeoError.hidden = true;
}

/**
 * User-visible failure for Nearby (modal + persistent banner in Filters).
 * @param {string} message
 */
function showNearbyGeolocationFailureMessage(message) {
  const text = (message || "").trim() || "Could not get your location for Nearby search.";
  if (el.placeGeoError) {
    el.placeGeoError.textContent = text;
    el.placeGeoError.hidden = false;
  }
  try {
    window.alert(text);
  } catch (ex) {
    explorerFatal(ex, "showNearbyGeolocationFailureMessage:window.alert");
  }
}

/**
 * @param {unknown} err from `getCurrentPosition` or thrown Error
 */
function formatGeolocationFailureMessage(err) {
  if (err && typeof err === "object" && "code" in err) {
    const code = /** @type {{ code?: number }} */ (err).code;
    if (code === 1) {
      return "Location permission was denied. Nearby search needs your position. Allow location for this site (lock or tune icon in the address bar), then try Nearby again, or pick a named place.";
    }
    if (code === 2) {
      return "Your device could not determine its position (position unavailable). Try Nearby again or pick a named place.";
    }
    if (code === 3) {
      return "Getting your location timed out. Try again, or pick a named place.";
    }
  }
  const msg =
    err && typeof err === "object" && "message" in err && typeof /** @type {{ message?: unknown }} */ (err).message === "string"
      ? String(/** @type {{ message: string }} */ (err).message).trim()
      : "";
  if (msg) return `Could not get your location: ${msg}`;
  return "Could not get your location. Check browser settings or pick a named place.";
}

function mediaQueryFromCheckboxes() {
  const p = el.mediaPhotos.checked;
  const s = el.mediaSounds.checked;
  if (p && s) return "both";
  if (p) return "photos";
  if (s) return "sounds";
  return "any";
}

function applyMediaFromQuery(q) {
  if (!q.has("media")) {
    el.mediaPhotos.checked = true;
    el.mediaSounds.checked = false;
    return;
  }
  const m = q.get("media") || "any";
  el.mediaPhotos.checked = m === "photos" || m === "both";
  el.mediaSounds.checked = m === "sounds" || m === "both";
}

function parseCardMetaQuery(q) {
  if (!q.has("cardmeta")) {
    return {
      faves: true,
      speciesCount: true,
      observer: false,
      location: false,
      nativeStatus: false,
      conservationStatus: false,
      grade: false,
      obsDate: false,
      photoPage: false,
      sciName: false,
      identifyControls: false,
      favoriteControl: true,
    };
  }
  const raw = q.get("cardmeta") ?? "";
  if (!raw) {
    return {
      faves: false,
      speciesCount: false,
      observer: false,
      location: false,
      nativeStatus: false,
      conservationStatus: false,
      grade: false,
      obsDate: false,
      photoPage: false,
      sciName: false,
      identifyControls: false,
      favoriteControl: false,
    };
  }
  const set = new Set(
    raw
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean)
  );
  const legacyIdc = set.has("idc");
  return {
    faves: set.has("fav"),
    speciesCount: set.has("spc"),
    observer: set.has("obs"),
    location: set.has("loc"),
    nativeStatus: set.has("nat"),
    conservationStatus: set.has("cns"),
    grade: set.has("grd"),
    obsDate: set.has("obsd"),
    /** `pp` = photo page link; `cam` kept for older shared URLs (same feature now). */
    photoPage: set.has("pp") || set.has("cam"),
    sciName: set.has("sci"),
    /** Agree + Mark reviewed. `idr` is the current URL token; `idc` is legacy (also implied favorite). */
    identifyControls: set.has("idr") || legacyIdc,
    /** Favorite / unfavorite on cards. `fvb` is current; legacy `idc` enabled this together with identify. */
    favoriteControl: set.has("fvb") || legacyIdc,
  };
}

function applyCardMetaFromQuery(q) {
  const o = parseCardMetaQuery(q);
  el.metaFaves.checked = o.faves;
  el.metaSpeciesCount.checked = o.speciesCount;
  if (el.metaObserver) el.metaObserver.checked = o.observer;
  el.metaLocation.checked = o.location;
  el.metaNativeStatus.checked = o.nativeStatus;
  if (el.metaConservationStatus) el.metaConservationStatus.checked = o.conservationStatus;
  el.metaGrade.checked = o.grade;
  if (el.metaObsDate) el.metaObsDate.checked = o.obsDate;
  if (el.metaPhotoPage) el.metaPhotoPage.checked = o.photoPage;
  el.metaSciName.checked = o.sciName;
  if (el.metaIdentifyControls) el.metaIdentifyControls.checked = o.identifyControls;
  if (el.metaFavoriteControl) el.metaFavoriteControl.checked = o.favoriteControl;
}

/** Observation / species cards: controls vs title+meta placement (Filters → Card layout). */
function syncExplorerHandLayoutClass() {
  const left = Boolean(el.handLayoutLeft && el.handLayoutLeft.checked);
  document.body.classList.toggle("explorer-hand-left", left);
}

function formatCardMetaQuery() {
  const fav = el.metaFaves.checked;
  const spc = el.metaSpeciesCount.checked;
  const obs = el.metaObserver && el.metaObserver.checked;
  const loc = el.metaLocation.checked;
  const nat = el.metaNativeStatus.checked;
  const cns = el.metaConservationStatus && el.metaConservationStatus.checked;
  const grd = el.metaGrade.checked;
  const obsd = el.metaObsDate && el.metaObsDate.checked;
  const pp = el.metaPhotoPage && el.metaPhotoPage.checked;
  const sci = el.metaSciName.checked;
  const idr = el.metaIdentifyControls && el.metaIdentifyControls.checked;
  const fvb = el.metaFavoriteControl && el.metaFavoriteControl.checked;
  if (fav && spc && fvb && !obs && !loc && !nat && !cns && !grd && !obsd && !pp && !sci && !idr) return null;
  if (!fav && spc && !fvb && !obs && !loc && !nat && !cns && !grd && !obsd && !pp && !sci && !idr) return null;
  const parts = [];
  if (fav) parts.push("fav");
  if (spc) parts.push("spc");
  if (obs) parts.push("obs");
  if (loc) parts.push("loc");
  if (nat) parts.push("nat");
  if (cns) parts.push("cns");
  if (grd) parts.push("grd");
  if (obsd) parts.push("obsd");
  if (pp) parts.push("pp");
  if (sci) parts.push("sci");
  if (fvb) parts.push("fvb");
  if (idr) parts.push("idr");
  return parts.join(",");
}

function allEstablishmentBucketsEnabled() {
  return (
    el.filterEstEndemic &&
    el.filterEstNative &&
    el.filterEstIntroduced &&
    el.filterEstInvasive &&
    el.filterEstEndemic.checked &&
    el.filterEstNative.checked &&
    el.filterEstIntroduced.checked &&
    el.filterEstInvasive.checked
  );
}

/** True when every establishment checkbox is off (avoid filtering nothing). */
function establishmentCheckboxSelectionEmpty() {
  return (
    el.filterEstEndemic &&
    el.filterEstNative &&
    el.filterEstIntroduced &&
    el.filterEstInvasive &&
    !el.filterEstEndemic.checked &&
    !el.filterEstNative.checked &&
    !el.filterEstIntroduced.checked &&
    !el.filterEstInvasive.checked
  );
}

function establishmentClientFilterActive() {
  if (establishmentCheckboxSelectionEmpty()) return false;
  return !allEstablishmentBucketsEnabled();
}

/**
 * Disjoint establishment bucket for an observation (matches card native-status wording).
 * @returns {"endemic"|"native"|"introduced"|"invasive"|null}
 */
function obsEstablishmentBucket(obs, kc) {
  const t = obs && obs.taxon;
  if (!t || typeof t !== "object") return null;
  if (t.endemic === true) return "endemic";
  if (t.native === true) return "native";
  if (t.native === false) {
    return kingCountyNoxiousMatchForTaxon(t, kc) ? "invasive" : "introduced";
  }
  return null;
}

function observationPassesEstablishmentCheckboxes(obs, kc) {
  if (!establishmentClientFilterActive()) return true;
  const b = obsEstablishmentBucket(obs, kc);
  if (b == null) return true;
  if (b === "endemic") return el.filterEstEndemic.checked;
  if (b === "native") return el.filterEstNative.checked;
  if (b === "introduced") return el.filterEstIntroduced.checked;
  if (b === "invasive") return el.filterEstInvasive.checked;
  return true;
}

function setEstablishmentCheckboxes({ endemic, native, introduced, invasive }) {
  if (el.filterEstEndemic) el.filterEstEndemic.checked = endemic;
  if (el.filterEstNative) el.filterEstNative.checked = native;
  if (el.filterEstIntroduced) el.filterEstIntroduced.checked = introduced;
  if (el.filterEstInvasive) el.filterEstInvasive.checked = invasive;
}

/** URL `est`: four `0`/`1` chars meaning endemic, native, introduced, invasive inclusion (default all `1`). */
function formatEstablishmentForUrl() {
  if (allEstablishmentBucketsEnabled() || establishmentCheckboxSelectionEmpty()) return null;
  const bits = [
    el.filterEstEndemic.checked ? "1" : "0",
    el.filterEstNative.checked ? "1" : "0",
    el.filterEstIntroduced.checked ? "1" : "0",
    el.filterEstInvasive.checked ? "1" : "0",
  ];
  return bits.join("");
}

function parseEstablishmentFromQuery(q) {
  const raw = (q.get("est") || "").trim();
  if (/^[01]{4}$/.test(raw)) {
    setEstablishmentCheckboxes({
      endemic: raw[0] === "1",
      native: raw[1] === "1",
      introduced: raw[2] === "1",
      invasive: raw[3] === "1",
    });
    return;
  }
  const es = (q.get("establish") || "").toLowerCase();
  const endOnly = q.get("endemic") === "1" || q.get("endemic") === "true";
  if (es === "invasive") {
    setEstablishmentCheckboxes({ endemic: false, native: false, introduced: false, invasive: true });
  } else if (es === "introduced") {
    setEstablishmentCheckboxes({ endemic: false, native: false, introduced: true, invasive: false });
  } else if (es === "native") {
    setEstablishmentCheckboxes({ endemic: true, native: true, introduced: false, invasive: false });
  } else if (endOnly) {
    setEstablishmentCheckboxes({ endemic: true, native: false, introduced: false, invasive: false });
  } else {
    setEstablishmentCheckboxes({ endemic: true, native: true, introduced: true, invasive: true });
  }
}

/**
 * @param {object} [options]
 * @param {"list"|"species_counts"} [options.establishmentMode]
 * @param {string} [options.kingCountyTaxonIdsCsv] unused; kept for call-site compatibility
 */
async function commonParams(options = {}) {
  const establishmentMode = options.establishmentMode || "list";
  void establishmentMode;

  const p = new URLSearchParams();
  const incBase = formatTaxonCsvParam(taxonIncludeFilters);
  const excBase = formatTaxonCsvParam(taxonExcludeFilters);

  if (incBase) p.set("taxon_id", incBase);
  if (excBase) {
    const existing = p.get("without_taxon_id");
    const merged = mergeTaxonCsvParam(existing || "", parseTaxonCsvParam(excBase));
    if (merged) p.set("without_taxon_id", merged);
  }

  const userLogin = el.userLogin.value.trim().toLowerCase();
  if (userLogin) p.set("user_login", userLogin);

  const placeId = el.placeId.value.trim();
  if (placeId) {
    p.set("place_id", placeId);
  } else {
    const lat = el.lat.value.trim();
    const lng = el.lng.value.trim();
    if (lat && lng) {
      p.set("lat", lat);
      p.set("lng", lng);
      p.set("radius", String(effectiveRadiusKm()));
      p.set("geo", "true");
    }
  }

  if (el.qualityGrade.value) p.set("quality_grade", el.qualityGrade.value);

  const photosOn = el.mediaPhotos.checked;
  const soundsOn = el.mediaSounds.checked;
  if (photosOn && soundsOn) {
    p.set("photos", "true");
    p.set("sounds", "true");
  } else if (photosOn) p.set("photos", "true");
  else if (soundsOn) p.set("sounds", "true");

  const uploadDays = parseInt(el.uploadedDays && el.uploadedDays.value, 10);
  if (!Number.isNaN(uploadDays) && uploadDays >= 1) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - uploadDays);
    d.setUTCHours(0, 0, 0, 0);
    p.set("created_d1", d.toISOString());
  }

  const obsDays = parseInt(el.observedDays && el.observedDays.value, 10);
  if (!Number.isNaN(obsDays) && obsDays >= 1) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - obsDays);
    const y = d.getUTCFullYear();
    const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
    const da = String(d.getUTCDate()).padStart(2, "0");
    p.set("d1", `${y}-${mo}-${da}`);
  }

  if (el.popularOnly.checked) p.set("popular", "true");

  await applyUnobservedSpeciesExclusionToParams(p);
  return p;
}

function observationListNeedsAuthForReviewFilter() {
  const unreviewed = el.filterMyReview && el.filterMyReview.value === "unreviewed";
  const faved = el.filterFavedByMe && el.filterFavedByMe.checked;
  return Boolean(unreviewed || faved);
}

/**
 * iNaturalist search: exclude observations the signed-in user has already reviewed
 * (`reviewed_by` in the API index), using `reviewed=false` + `viewer_id`.
 */
function applyUnreviewedByMeObservationParams(p) {
  if (!observationListNeedsAuthForReviewFilter()) return;
  const uid = inatAuthUser && inatAuthUser.id != null ? Number(inatAuthUser.id) : NaN;
  if (!Number.isFinite(uid) || uid <= 0) return;
  p.set("reviewed", "false");
  p.set("viewer_id", String(Math.floor(uid)));
}

function observationListAuthFetchOptions() {
  return observationListNeedsAuthForReviewFilter() ? { auth: true } : {};
}

function joinKingCountyTaxonIdsCsv(kc) {
  if (!kc || !kc.allIds || kc.allIds.size === 0) return "";
  return [...kc.allIds].sort((a, b) => a - b).join(",");
}

/**
 * Observation list params. Uses `id_below` (desc) or `id_above` (asc) cursor pagination instead of `page`.
 * @param {{ idBelow?: number | null, idAbove?: number | null }} opts
 */
async function observationParams(opts = {}) {
  const idBelow = opts.idBelow != null && Number.isFinite(opts.idBelow) ? opts.idBelow : null;
  const idAbove = opts.idAbove != null && Number.isFinite(opts.idAbove) ? opts.idAbove : null;
  const p = await commonParams({});
  p.set("per_page", String(OBS_PER_PAGE));
  const sort = el.sortMode.value;
  if (sort === "faves") {
    p.set("order_by", "votes");
    p.set("order", "desc");
    if (idBelow != null) p.set("id_below", String(Math.floor(idBelow)));
  } else if (sort === "oldest") {
    p.set("order_by", "created_at");
    p.set("order", "asc");
    if (idAbove != null) p.set("id_above", String(Math.floor(idAbove)));
  } else if (sort === "obs_oldest") {
    p.set("order_by", "observed_on");
    p.set("order", "asc");
    if (idAbove != null) p.set("id_above", String(Math.floor(idAbove)));
  } else if (sort === "obs_recent") {
    p.set("order_by", "observed_on");
    p.set("order", "desc");
    if (idBelow != null) p.set("id_below", String(Math.floor(idBelow)));
  } else {
    p.set("order_by", "created_at");
    p.set("order", "desc");
    if (idBelow != null) p.set("id_below", String(Math.floor(idBelow)));
  }
  applyUnreviewedByMeObservationParams(p);
  return p;
}

/** Epoch ms for API `created_at` (upload time); fallback so ties still sort stably. */
function observationCreatedAtMs(obs) {
  if (obs && obs.created_at) {
    const t = Date.parse(obs.created_at);
    if (!Number.isNaN(t)) return t;
  }
  const id = obs && obs.id != null ? Number(obs.id) : 0;
  return Number.isFinite(id) ? id : 0;
}

/** Epoch ms for observed date/time; falls back to `observed_on` date-only then observation id. */
function observationObservedOnMs(obs) {
  if (obs && obs.time_observed_at) {
    const t = Date.parse(obs.time_observed_at);
    if (!Number.isNaN(t)) return t;
  }
  if (obs && obs.observed_on) {
    const raw = String(obs.observed_on).trim();
    if (raw) {
      const t = Date.parse(`${raw}T12:00:00Z`);
      if (!Number.isNaN(t)) return t;
    }
  }
  const id = obs && obs.id != null ? Number(obs.id) : 0;
  return Number.isFinite(id) ? id : 0;
}

/**
 * API returns `order_by=votes` desc; only re-sort a page when ties need breaking by upload time.
 */
function sortObservationResultsForDisplay(results) {
  if (!results.length) return results;
  if (el.sortMode.value === "faves") {
    const counts = results.map((o) => Number(o.faves_count) || 0);
    if (new Set(counts).size === counts.length) return results;
    return [...results].sort((a, b) => {
      const fa = Number(a.faves_count) || 0;
      const fb = Number(b.faves_count) || 0;
      if (fb !== fa) return fb - fa;
      return observationCreatedAtMs(b) - observationCreatedAtMs(a);
    });
  }
  if (el.sortMode.value === "oldest") {
    return [...results].sort((a, b) => {
      const ta = observationCreatedAtMs(a);
      const tb = observationCreatedAtMs(b);
      if (ta !== tb) return ta - tb;
      return (Number(a.id) || 0) - (Number(b.id) || 0);
    });
  }
  if (el.sortMode.value === "recent") {
    return [...results].sort((a, b) => {
      const ta = observationCreatedAtMs(a);
      const tb = observationCreatedAtMs(b);
      if (tb !== ta) return tb - ta;
      return (Number(b.id) || 0) - (Number(a.id) || 0);
    });
  }
  if (el.sortMode.value === "obs_oldest") {
    return [...results].sort((a, b) => {
      const ta = observationObservedOnMs(a);
      const tb = observationObservedOnMs(b);
      if (ta !== tb) return ta - tb;
      return (Number(a.id) || 0) - (Number(b.id) || 0);
    });
  }
  if (el.sortMode.value === "obs_recent") {
    return [...results].sort((a, b) => {
      const ta = observationObservedOnMs(a);
      const tb = observationObservedOnMs(b);
      if (tb !== ta) return tb - ta;
      return (Number(b.id) || 0) - (Number(a.id) || 0);
    });
  }
  return results;
}

async function speciesParams(page) {
  const kc = await ensureKingCountyNoxiousData();
  const p = await commonParams({ establishmentMode: "species_counts", kingCountyTaxonIdsCsv: joinKingCountyTaxonIdsCsv(kc) });
  p.set("page", String(page));
  p.set("per_page", String(SPECIES_PER_PAGE));
  p.set("order", "desc");
  p.set("order_by", "count");
  applyUnreviewedByMeObservationParams(p);
  return p;
}

async function observationCountParams() {
  const p = await observationParams();
  p.set("per_page", "1");
  return p;
}

async function speciesCountParams() {
  const p = await speciesParams(1);
  p.set("per_page", "1");
  return p;
}

/** Same query scope as `GET /observations/species_counts` for a taxon (list ordering params). */
async function speciesFilterParams(taxonId) {
  const kc = await ensureKingCountyNoxiousData();
  const p = await commonParams({ establishmentMode: "species_counts", kingCountyTaxonIdsCsv: joinKingCountyTaxonIdsCsv(kc) });
  const tid = Number(taxonId);
  if (Number.isFinite(tid) && tid > 0) {
    const existing = p.get("taxon_id");
    p.set("taxon_id", mergeTaxonCsvParam(existing || "", [tid]));
  }
  p.set("order_by", "count");
  p.set("order", "desc");
  return p;
}

/**
 * Params for `GET /observations/histogram` month-of-year for species detail.
 * Matches the species_counts scope for this taxon, but drops `month` so the chart reflects
 * the full year of observed dates rather than a subset.
 * iNaturalist does not return per-month arrays on the species_counts response;
 * histogram is the supported aggregate for this chart.
 */
async function monthOfYearHistogramParams(taxonId) {
  const p = await speciesFilterParams(taxonId);
  p.delete("order_by");
  p.delete("order");
  p.delete("month");
  p.set("date_field", "observed");
  p.set("interval", "month_of_year");
  return p;
}

/**
 * Params for `GET /observations/histogram` matching current filters but without month scoping.
 * @param {"month"|"year"} interval
 */
async function observedHistogramParamsForStats(interval) {
  const kc = await ensureKingCountyNoxiousData();
  const p = await commonParams({ establishmentMode: "list", kingCountyTaxonIdsCsv: joinKingCountyTaxonIdsCsv(kc) });
  p.delete("month");
  p.set("date_field", "observed");
  p.set("interval", interval);
  return p;
}

async function monthHistogramParamsForStats() {
  return observedHistogramParamsForStats("month");
}

async function yearHistogramParamsForStats() {
  return observedHistogramParamsForStats("year");
}

/**
 * Params for `GET /observations/species_counts` with `per_page=1` — `total_results` is distinct leaf taxa count.
 * @param {string} observedEndDate `YYYY-MM-DD` inclusive end of observed date range (API `d2`).
 */
async function speciesCountTotalParamsForEndDate(observedEndDate) {
  const kc = await ensureKingCountyNoxiousData();
  const p = await commonParams({ establishmentMode: "species_counts", kingCountyTaxonIdsCsv: joinKingCountyTaxonIdsCsv(kc) });
  p.delete("month");
  p.set("d2", observedEndDate);
  p.set("per_page", "1");
  p.set("page", "1");
  return p;
}

/** Last calendar day of month `m` (1–12) in year `y`, as `YYYY-MM-DD` (local calendar, no UTC shift). */
function endOfCalendarMonthStr(y, m) {
  const last = new Date(y, m, 0);
  const yy = last.getFullYear();
  const mm = String(last.getMonth() + 1).padStart(2, "0");
  const dd = String(last.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatStatsPointLabel(y, m, stepMonths) {
  if (stepMonths >= 12) return String(y);
  if (stepMonths >= 3) {
    const q = Math.floor((m - 1) / 3) + 1;
    return `Q${q} ${y}`;
  }
  return `${MONTH_SHORT[m - 1]} ${String(y).slice(-2)}`;
}

/**
 * Pick ~1–48 sample points from the observed-month range (finer than yearly when the span is short).
 * @param {{ y: number, m: number, obs: number }[]} activeMonths sorted ascending, first month of bucket only
 */
function buildStatsSampleMonths(activeMonths, maxPoints = 48) {
  if (!activeMonths.length) return { samples: [], stepMonths: 1 };
  const first = activeMonths[0];
  const last = activeMonths[activeMonths.length - 1];
  const span =
    (last.y - first.y) * 12 + (last.m - first.m) + 1;
  let rawStep = Math.max(1, Math.ceil(span / maxPoints));
  const nice = [1, 2, 3, 4, 6, 12, 24, 36, 60, 120];
  const stepMonths = nice.find((x) => x >= rawStep) ?? rawStep;

  const samples = [];
  let cy = first.y;
  let cm = first.m;
  const endKey = last.y * 12 + last.m;
  while (cy * 12 + cm <= endKey) {
    samples.push({ y: cy, m: cm });
    cm += stepMonths;
    while (cm > 12) {
      cm -= 12;
      cy += 1;
    }
  }
  const lastPt = samples[samples.length - 1];
  if (!lastPt || lastPt.y !== last.y || lastPt.m !== last.m) {
    samples.push({ y: last.y, m: last.m });
  }
  return { samples, stepMonths };
}

/**
 * When matching observation count is at most this value, Stats loads every observation once
 * (paginated) and aggregates cumulative distinct taxa locally — no per-month `species_counts`.
 * Above this, Stats uses year-end `species_counts` only (few server calls).
 */
const STATS_LOCAL_MAX_TOTAL = 6_000;
const STATS_FETCH_PER_PAGE = 200;

/** Retry transient iNaturalist failures (rate limits, gateway errors). */
async function inatFetchWithRetry(pathAndQuery, opts = {}) {
  const retries = opts.retries ?? 4;
  let res = null;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    res = await inatFetch(pathAndQuery, opts);
    if (res.ok) return res;
    const retry = res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504;
    if (retry && attempt < retries - 1) {
      await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
      continue;
    }
    return res;
  }
  return res;
}

/** True when observation search should use POST /v2 (JSON body) — favorites filter or large “Unseen by” exclusions. */
function observationQueryUsesV2Post() {
  return Boolean(
    observationSearchUsesV2FavoritesPost() ||
      (el.unobservedInput && el.unobservedInput.value.trim()),
  );
}

const UNOBSERVED_SPECIES_CACHE_TTL_MS = 60 * 60 * 1000;
const UNOBSERVED_SPECIES_FETCH_PER_PAGE = 500;
const UNOBSERVED_SPECIES_MAX_PAGES = 400;
/** @type {Map<string, { ids: number[]; expiry: number }>} */
const unobservedSpeciesIdsCache = new Map();

/**
 * Paginate `GET /v1/observations/species_counts?user_login=…` (global life list for that observer;
 * no place/taxon filters) to collect distinct species-level taxon ids (`taxon.id` on each row).
 * @param {string} login lowercased iNaturalist login
 * @returns {Promise<number[]>}
 */
async function fetchObservedSpeciesTaxonIdsForUserLogin(login) {
  const ids = [];
  for (let page = 1; page <= UNOBSERVED_SPECIES_MAX_PAGES; page += 1) {
    const q = new URLSearchParams();
    q.set("user_login", login);
    q.set("per_page", String(UNOBSERVED_SPECIES_FETCH_PER_PAGE));
    q.set("page", String(page));
    const res = await inatFetchWithRetry(`observations/species_counts?${q.toString()}`, {});
    if (!res.ok) {
      throw new Error(`species_counts for observed species failed (${res.status})`);
    }
    const j = await res.json();
    const rows = j.results || [];
    for (const row of rows) {
      const t = row && row.taxon;
      const tid = t && t.id != null ? Number(t.id) : NaN;
      if (Number.isFinite(tid) && tid > 0) ids.push(tid);
    }
    if (rows.length < UNOBSERVED_SPECIES_FETCH_PER_PAGE) break;
  }
  return [...new Set(ids)];
}

/**
 * Cached species-level taxon ids for the “Unseen by” user (matches server life-list grain).
 * @param {string} login lowercased login
 */
async function getUnobservedSpeciesTaxonIdsCached(login) {
  const now = Date.now();
  const hit = unobservedSpeciesIdsCache.get(login);
  if (hit && hit.expiry > now) return hit.ids;
  const ids = await fetchObservedSpeciesTaxonIdsForUserLogin(login);
  unobservedSpeciesIdsCache.set(login, { ids, expiry: now + UNOBSERVED_SPECIES_CACHE_TTL_MS });
  return ids;
}

/**
 * “Unseen by”: exclude observations under species the named user has already observed
 * (`without_taxon_id` on `taxon.ancestor_ids`), and restrict results to species through infraspecifics.
 * @param {URLSearchParams} p
 */
async function applyUnobservedSpeciesExclusionToParams(p) {
  const login = el.unobservedInput && el.unobservedInput.value.trim().toLowerCase();
  if (!login) return;
  const ids = await getUnobservedSpeciesTaxonIdsCached(login);
  if (ids.length) {
    const existing = p.get("without_taxon_id") || "";
    const merged = mergeTaxonCsvParam(existing, ids);
    if (merged) p.set("without_taxon_id", merged);
  }
  p.set("lrank", "subspecies");
  p.set("hrank", "species");
}

/**
 * PNG grid tiles are requested via GET; very long `without_taxon_id` lists can exceed URL limits.
 * Fall back to API-native `unobserved_by_user_id` for the heat layer only (slightly different semantics at fine ranks).
 */
const HEAT_GRID_WITHOUT_TAXON_SAFE_LEN = 2800;
function relaxUnobservedParamsForObservationGridTiles(p) {
  const wit = p.get("without_taxon_id") || "";
  if (wit.length <= HEAT_GRID_WITHOUT_TAXON_SAFE_LEN) return;
  const login = el.unobservedInput && el.unobservedInput.value.trim().toLowerCase();
  if (!login) return;
  p.delete("without_taxon_id");
  p.delete("lrank");
  p.delete("hrank");
  p.set("unobserved_by_user_id", login);
}

/** True when “Favorited by me” is on and we have a user id (POST /v2 search with nested `votes` filter). */
function observationSearchUsesV2FavoritesPost() {
  return Boolean(
    el.filterFavedByMe && el.filterFavedByMe.checked && inatAuthUser && inatAuthUser.id != null,
  );
}

function urlSearchParamsToPlainJsonObject(sp) {
  const o = {};
  for (const key of new Set([...sp.keys()])) {
    const vals = sp.getAll(key);
    if (vals.length === 1) o[key] = vals[0];
    else o[key] = vals;
  }
  return o;
}

function favoritedByMeNestedVoteFilter(userId) {
  const uid = Math.floor(Number(userId));
  return {
    nested: {
      path: "votes",
      query: {
        bool: {
          filter: [
            { term: { "votes.user_id": uid } },
            { bool: { must_not: { exists: { field: "votes.vote_scope" } } } },
          ],
        },
      },
    },
  };
}

function applyFavoritedNestedFilterToPostBody(body) {
  if (!observationSearchUsesV2FavoritesPost()) return;
  const uid = inatAuthUser && inatAuthUser.id != null ? Number(inatAuthUser.id) : NaN;
  if (!Number.isFinite(uid) || uid <= 0) return;
  const nested = favoritedByMeNestedVoteFilter(uid);
  const existing = Array.isArray(body.filters) ? body.filters : [];
  body.filters = [nested, ...existing];
}

async function inatV2PostMethodOverrideGetWithRetry(relPath, body, opts = {}) {
  const retries = opts.retries ?? 4;
  let res = null;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    res = await inatPostV2MethodOverrideGet(relPath, body, opts);
    if (res.ok) return res;
    const retry = res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504;
    if (retry && attempt < retries - 1) {
      await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
      continue;
    }
    return res;
  }
  return res;
}

/**
 * GET v1 or POST /v2 (JSON body) for observation search endpoints when “Favorited by me” or “Unseen by”
 * requires a POST body; `fields=all` is set for `observations` and `observations/species_counts` so v2
 * returns full taxon payloads (v2 defaults omit names and photos).
 * @param {"observations"|"observations/species_counts"|"observations/histogram"} relPath
 * @param {URLSearchParams} searchParams
 */
async function inatObservationQueryFetchWithRetry(relPath, searchParams, opts = {}) {
  if (!observationQueryUsesV2Post()) {
    return inatFetchWithRetry(`${relPath}?${searchParams.toString()}`, opts);
  }
  const body = urlSearchParamsToPlainJsonObject(searchParams);
  applyFavoritedNestedFilterToPostBody(body);
  if (relPath === "observations" || relPath === "observations/species_counts") {
    body.fields = "all";
  }
  return inatV2PostMethodOverrideGetWithRetry(relPath, body, opts);
}

/** Params for listing observations in observed-on order (Stats local aggregation). */
async function statsObservationListParams() {
  const kc = await ensureKingCountyNoxiousData();
  const p = await commonParams({ establishmentMode: "list", kingCountyTaxonIdsCsv: joinKingCountyTaxonIdsCsv(kc) });
  p.delete("month");
  p.set("order_by", "observed_on");
  p.set("order", "asc");
  return p;
}

function statsObservedMonthOrdinal(obs) {
  const w = observationWallClockParts(obs);
  if (!w || !Number.isFinite(w.y) || !Number.isFinite(w.mo)) return null;
  return w.y * 12 + w.mo;
}

function statsDistinctTaxonId(obs) {
  const t = obs && obs.taxon;
  const id = t && t.id != null ? Number(t.id) : NaN;
  return Number.isFinite(id) && id > 0 ? id : null;
}

/**
 * Fetch every observation matching current filters (ascending observed_on), paginated.
 * Caller must only invoke when the total count is known to be modest.
 * @returns {Promise<object[]>}
 */
async function fetchAllObservationsForStatsAggregation() {
  const base = await statsObservationListParams();
  base.set("per_page", String(STATS_FETCH_PER_PAGE));
  const out = [];
  let page = 1;
  const maxPages = Math.ceil(STATS_LOCAL_MAX_TOTAL / STATS_FETCH_PER_PAGE) + 5;
  const kc = establishmentClientFilterActive() ? await ensureKingCountyNoxiousData() : null;
  while (page <= maxPages) {
    const p = new URLSearchParams(base);
    p.set("page", String(page));
    const res = await inatObservationQueryFetchWithRetry("observations", p, observationListAuthFetchOptions());
    if (!res.ok) throw new Error(`Observations request failed (${res.status})`);
    const j = await res.json();
    const rows = j.results || [];
    if (!rows.length) break;
    for (const obs of rows) {
      if (kc && !observationPassesEstablishmentCheckboxes(obs, kc)) continue;
      out.push(obs);
    }
    if (rows.length < STATS_FETCH_PER_PAGE) break;
    page += 1;
  }
  return out;
}

/**
 * Cumulative distinct taxon ids at each sample month-end (local, matches client-side rollup of listed obs).
 * @param {object[]} observations
 * @param {{ y: number, m: number }[]} samples
 */
function aggregateStatsFromObservations(observations, samples) {
  const rows = [];
  for (const obs of observations) {
    const ord = statsObservedMonthOrdinal(obs);
    const tid = statsDistinctTaxonId(obs);
    if (ord == null || tid == null) continue;
    const oid = obs.id != null ? Number(obs.id) : 0;
    rows.push({ ord, tid, oid });
  }
  rows.sort((a, b) => (a.ord !== b.ord ? a.ord - b.ord : a.oid - b.oid));

  const endOrds = samples.map(({ y, m }) => y * 12 + m);
  const set = new Set();
  let oi = 0;
  const counts = [];
  for (let si = 0; si < endOrds.length; si += 1) {
    const cap = endOrds[si];
    while (oi < rows.length && rows[oi].ord <= cap) {
      set.add(rows[oi].tid);
      oi += 1;
    }
    counts.push(set.size);
  }
  return counts;
}

function parseHistogramMonthBuckets(monthObj) {
  const activeMonths = [];
  if (!monthObj || typeof monthObj !== "object") return activeMonths;
  for (const k of Object.keys(monthObj)) {
    const c = Number(monthObj[k]) || 0;
    if (c <= 0) continue;
    const mk = String(k).match(/^(\d{4})-(\d{1,2})-/);
    if (!mk) continue;
    const y = parseInt(mk[1], 10);
    const m = parseInt(mk[2], 10);
    if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) continue;
    activeMonths.push({ y, m, obs: c });
  }
  activeMonths.sort((a, b) => (a.y !== b.y ? a.y - b.y : a.m - b.m));
  return activeMonths;
}

function parseHistogramYearBuckets(yearObj) {
  const years = [];
  if (!yearObj || typeof yearObj !== "object") return years;
  for (const k of Object.keys(yearObj)) {
    const c = Number(yearObj[k]) || 0;
    if (c <= 0) continue;
    const y = parseInt(String(k).slice(0, 4), 10);
    if (!Number.isFinite(y)) continue;
    years.push({ y, obs: c });
  }
  years.sort((a, b) => a.y - b.y);
  return years;
}

/**
 * Cumulative distinct taxa over time: local aggregation from observation pages when the
 * filtered set is small; otherwise one `species_counts` per year-end (few server round-trips).
 * @returns {Promise<{ labels: string[], counts: number[], stepMonths: number, endLabels: string[], mode: string }>}
 */
async function cumulativeDistinctSpeciesOverTime() {
  const countP = await observationCountParams();
  const countRes = await inatObservationQueryFetchWithRetry("observations", countP, observationListAuthFetchOptions());
  if (!countRes.ok) throw new Error(`Observation count failed (${countRes.status})`);
  const countJson = await countRes.json();
  const totalObs = Number(countJson.total_results) || 0;
  if (totalObs <= 0) {
    return { labels: [], counts: [], stepMonths: 1, endLabels: [], mode: "none" };
  }

  if (totalObs <= STATS_LOCAL_MAX_TOTAL) {
    const histParams = await monthHistogramParamsForStats();
    const histRes = await inatObservationQueryFetchWithRetry("observations/histogram", histParams, observationListAuthFetchOptions());
    if (!histRes.ok) throw new Error(`Histogram request failed (${histRes.status})`);
    const histJson = await histRes.json();
    const activeMonths = parseHistogramMonthBuckets(histJson.results?.month);
    if (!activeMonths.length) {
      return { labels: [], counts: [], stepMonths: 1, endLabels: [], mode: "local" };
    }
    const { samples, stepMonths } = buildStatsSampleMonths(activeMonths, 48);
    const observations = await fetchAllObservationsForStatsAggregation();
    const counts = aggregateStatsFromObservations(observations, samples);
    const labels = samples.map(({ y, m }) => formatStatsPointLabel(y, m, stepMonths));
    const endLabels = samples.map(({ y, m }) => endOfCalendarMonthStr(y, m));
    return { labels, counts, stepMonths, endLabels, mode: "local" };
  }

  const histParams = await yearHistogramParamsForStats();
  const histRes = await inatObservationQueryFetchWithRetry("observations/histogram", histParams, observationListAuthFetchOptions());
  if (!histRes.ok) throw new Error(`Histogram request failed (${histRes.status})`);
  const histJson = await histRes.json();
  const activeYears = parseHistogramYearBuckets(histJson.results?.year);
  if (!activeYears.length) {
    return { labels: [], counts: [], stepMonths: 12, endLabels: [], mode: "server-year" };
  }
  const minY = activeYears[0].y;
  const maxY = activeYears[activeYears.length - 1].y;
  const years = [];
  for (let y = minY; y <= maxY; y += 1) years.push(y);

  const BATCH = 8;
  const counts = [];
  const labels = [];
  const endLabels = [];
  for (let i = 0; i < years.length; i += BATCH) {
    const slice = years.slice(i, i + BATCH);
    const results = await Promise.all(
      slice.map(async (y) => {
        const d2 = endOfCalendarMonthStr(y, 12);
        const p = await speciesCountTotalParamsForEndDate(d2);
        const r = await inatObservationQueryFetchWithRetry("observations/species_counts", p, observationListAuthFetchOptions());
        if (!r.ok) throw new Error(`Species count failed (${r.status})`);
        const j = await r.json();
        return Number(j.total_results) || 0;
      })
    );
    for (let j = 0; j < slice.length; j += 1) {
      const y = slice[j];
      labels.push(String(y));
      endLabels.push(endOfCalendarMonthStr(y, 12));
      counts.push(results[j]);
    }
    if (i + BATCH < years.length) {
      await new Promise((r) => setTimeout(r, 120));
    }
  }
  return { labels, counts, stepMonths: 12, endLabels, mode: "server-year" };
}

/**
 * SVG line chart for stats (cumulative series).
 * @param {number[]} values
 * @param {string[]} labels
 */
function renderStatsLineChart(values, labels) {
  const vals = values.map((v) => (Number.isFinite(Number(v)) ? Number(v) : 0));
  const n = vals.length;
  const wrap = document.createElement("div");
  wrap.className = "stats-line-chart-wrap";
  if (n === 0) return wrap;

  const W = 720;
  const H = 260;
  const padL = 52;
  const padR = 16;
  const padT = 14;
  const padB = 46;
  const iw = W - padL - padR;
  const ih = H - padT - padB;
  const vmax = Math.max(...vals, 1) * 1.06;
  const xAt = (i) => padL + (n === 1 ? iw / 2 : (iw * i) / (n - 1));
  const yAt = (v) => padT + ih * (1 - v / vmax);

  const pts = vals.map((v, i) => `${xAt(i).toFixed(2)},${yAt(v).toFixed(2)}`).join(" ");
  const areaD = `M ${xAt(0).toFixed(2)} ${padT + ih} L ${pts} L ${xAt(n - 1).toFixed(2)} ${padT + ih} Z`;

  const tickStep = Math.max(1, Math.ceil(n / 7));
  const ticks = [];
  for (let i = 0; i < n; i += tickStep) ticks.push(i);
  if (ticks[ticks.length - 1] !== n - 1) ticks.push(n - 1);

  const yTicks = 4;
  const yTickVals = [];
  for (let t = 0; t <= yTicks; t += 1) {
    yTickVals.push((vmax * t) / yTicks);
  }

  const esc = (s) => escapeHtml(String(s));

  const parts = [
    `<svg class="stats-line-chart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Cumulative distinct species over time">`,
    `<path class="stats-line-chart__area" d="${areaD}" />`,
  ];
  for (const gv of yTickVals) {
    const yy = yAt(gv);
    parts.push(`<line class="stats-line-chart__grid" x1="${padL}" y1="${yy.toFixed(2)}" x2="${padL + iw}" y2="${yy.toFixed(2)}" />`);
    parts.push(`<text class="stats-line-chart__tick" x="${padL - 6}" y="${yy + 4}" text-anchor="end">${esc(Math.round(gv).toLocaleString())}</text>`);
  }
  parts.push(`<line class="stats-line-chart__axis" x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + ih}" />`);
  parts.push(`<line class="stats-line-chart__axis" x1="${padL}" y1="${padT + ih}" x2="${padL + iw}" y2="${padT + ih}" />`);
  parts.push(`<polyline class="stats-line-chart__line" points="${pts}" />`);
  for (let i = 0; i < n; i += 1) {
    parts.push(
      `<circle class="stats-line-chart__dot" cx="${xAt(i).toFixed(2)}" cy="${yAt(vals[i]).toFixed(2)}" r="${n > 48 ? 2.5 : 3.5}" />`
    );
  }
  for (const i of ticks) {
    const lx = xAt(i);
    const lab = labels[i] || "";
    parts.push(`<text class="stats-line-chart__tick" x="${lx.toFixed(2)}" y="${H - 10}" text-anchor="middle">${esc(lab)}</text>`);
  }
  parts.push("</svg>");
  wrap.innerHTML = parts.join("");
  return wrap;
}

async function runStatsSearch() {
  if (statsLoading) return;
  statsLoading = true;
  showError("stats", "");
  if (el.searchSummaryStats) el.searchSummaryStats.textContent = "Loading…";
  if (el.statsContent) {
    el.statsContent.innerHTML = `<p class="stats-loading">Loading cumulative species over time…</p>`;
  }
  try {
    const { labels, counts, stepMonths, endLabels, mode } = await cumulativeDistinctSpeciesOverTime();
    if (!labels.length) {
      if (el.searchSummaryStats) el.searchSummaryStats.textContent = "No observations in range for this filter.";
      if (el.statsContent) {
        el.statsContent.innerHTML =
          `<p class="stats-empty">No months with observations matched these filters. Try a broader place or taxon.</p>`;
      }
      setSearchSummaryVisibility();
      return;
    }
    const latest = counts[counts.length - 1] || 0;
    const lastEnd = endLabels[endLabels.length - 1] || "";
    if (el.searchSummaryStats) {
      el.searchSummaryStats.textContent = `${latest.toLocaleString()} distinct species through ${lastEnd} (cumulative by observation date)`;
    }
    if (el.statsContent) {
      el.statsContent.innerHTML = "";
      const section = document.createElement("div");
      section.className = "stats-section";
      const h = document.createElement("h2");
      h.className = "stats-heading";
      h.textContent = "Cumulative distinct species over time";
      const note = document.createElement("p");
      note.className = "stats-note";
      const stepDesc =
        stepMonths >= 12
          ? "yearly"
          : stepMonths >= 3
            ? "quarterly (or coarser)"
            : stepMonths === 2
              ? "every two months"
              : "monthly";
      if (mode === "local") {
        note.textContent = `Each point counts distinct species (leaf taxa) from your matching observations with observed date on or before that month’s end — computed in the browser from the full result set (no per-point server species count). X-axis sampling is ${stepDesc} when the span is long.`;
      } else {
        note.textContent = `Large result sets use one server count per year-end (through December 31) for speed. Smaller sets (${STATS_LOCAL_MAX_TOTAL.toLocaleString()} or fewer matching observations) use finer monthly sampling computed locally.`;
      }
      section.appendChild(h);
      section.appendChild(note);
      section.appendChild(renderStatsLineChart(counts, labels));
      el.statsContent.appendChild(section);
    }
    setSearchSummaryVisibility();
    syncUrl();
  } catch (err) {
    explorerFatal(err, "runStatsSearch");
  } finally {
    statsLoading = false;
    setSearchSummaryVisibility();
  }
}

function getCardMetaOptions() {
  return {
    faves: el.metaFaves.checked,
    speciesCount: el.metaSpeciesCount.checked,
    observer: el.metaObserver && el.metaObserver.checked,
    location: el.metaLocation.checked,
    nativeStatus: el.metaNativeStatus.checked,
    conservationStatus: el.metaConservationStatus && el.metaConservationStatus.checked,
    grade: el.metaGrade.checked,
    obsDate: el.metaObsDate && el.metaObsDate.checked,
    photoPage: el.metaPhotoPage && el.metaPhotoPage.checked,
    sciName: el.metaSciName.checked,
    identifyControls: Boolean(el.metaIdentifyControls && el.metaIdentifyControls.checked),
    favoriteControl: Boolean(el.metaFavoriteControl && el.metaFavoriteControl.checked),
  };
}

function formatQualityGradeLabel(qg) {
  const g = String(qg || "").trim().toLowerCase();
  if (g === "research") return "Research grade";
  if (g === "needs_id") return "Needs ID";
  if (g === "casual") return "Casual";
  return "";
}

/** Human-readable conservation line from iNaturalist `taxon.conservation_status`. */
function conservationStatusMetaLine(taxon) {
  const cs = taxon && taxon.conservation_status;
  if (!cs || typeof cs !== "object") return "";
  const name = typeof cs.status_name === "string" ? cs.status_name.trim() : "";
  const auth = typeof cs.authority === "string" ? cs.authority.trim() : "";
  const code = typeof cs.status === "string" ? cs.status.trim().toUpperCase() : "";
  const label = name ? name.charAt(0).toUpperCase() + name.slice(1) : code;
  if (!label) return "";
  if (auth) return `${label} (${auth})`;
  return label;
}

/**
 * From observation.taxon (iNaturalist API): `native`, `endemic` booleans.
 * Endemic ⊂ native; introduced is inferred when `native` is false.
 * When introduced and the taxon matches the King County noxious weed list, append a linked "Invasive (Class X)" tag.
 */
function nativeStatusMetaSegmentsForTaxon(taxon, kcData) {
  const t = taxon;
  if (!t || typeof t !== "object") return [];
  const endemic = t.endemic === true;
  const native = t.native === true;
  if (endemic) return [{ kind: "text", text: "Endemic" }];
  if (native) return [{ kind: "text", text: "Native" }];
  if (t.native === false) {
    const segs = [{ kind: "text", text: "Introduced" }];
    const match = kingCountyNoxiousMatchForTaxon(t, kcData);
    if (match && match.href) {
      const wc = match.weedClass;
      const label = wc ? `Invasive (Class ${wc})` : "Invasive";
      segs.push({ kind: "text", text: " · " });
      segs.push({ kind: "link", label, href: match.href });
    }
    return segs;
  }
  return [];
}

function nativeStatusMetaSegments(obs, kcData) {
  return nativeStatusMetaSegmentsForTaxon(obs && obs.taxon, kcData);
}

/**
 * species_counts taxon objects omit native/endemic; load one observation per taxon (same filters) to read status.
 */
async function fetchObservationTaxonById(taxonIds) {
  const map = new Map();
  const uniq = [...new Set(taxonIds.map((id) => Number(id)).filter((n) => Number.isFinite(n) && n > 0))];
  if (!uniq.length) return map;

  const kc = await ensureKingCountyNoxiousData();
  const kcCsv = joinKingCountyTaxonIdsCsv(kc);

  const chunkSize = 25;
  for (let i = 0; i < uniq.length; i += chunkSize) {
    const slice = uniq.slice(i, i + chunkSize);
    const p = await commonParams({ establishmentMode: "list", kingCountyTaxonIdsCsv: kcCsv });
    p.set("taxon_id", slice.join(","));
    p.set("per_page", "200");
    p.set("page", "1");
    p.set("order_by", "created_at");
    p.set("order", "desc");
    try {
      const res = await inatObservationQueryFetchWithRetry("observations", p, observationListAuthFetchOptions());
      if (!res.ok) continue;
      const data = await res.json();
      const want = new Set(slice);
      for (const obs of data.results || []) {
        const t = obs.taxon;
        if (!t || t.id == null) continue;
        const tid = Number(t.id);
        if (want.has(tid) && !map.has(tid)) map.set(tid, t);
      }
    } catch (ex) {
      explorerFatal(ex, "fetchObservationTaxonById:chunk");
    }
  }

  const missing = uniq.filter((id) => !map.has(id));
  for (const tid of missing) {
    const p = await commonParams({ establishmentMode: "list", kingCountyTaxonIdsCsv: kcCsv });
    p.set("taxon_id", String(tid));
    p.set("per_page", "1");
    p.set("page", "1");
    try {
      const res = await inatObservationQueryFetchWithRetry("observations", p, observationListAuthFetchOptions());
      if (!res.ok) continue;
      const data = await res.json();
      const obs = (data.results || [])[0];
      const t = obs && obs.taxon;
      if (t && t.id != null) map.set(tid, t);
    } catch (ex) {
      explorerFatal(ex, "fetchObservationTaxonById:single");
    }
  }

  return map;
}

function renderMetaSegmentsHtml(segments) {
  if (!segments.length) return "";
  const inner = segments
    .map((s) => {
      if (s.kind === "text") return escapeHtml(s.text);
      if (s.kind === "link") {
        return `<a class="card-meta-tag-link" href="${escapeHtml(s.href)}" rel="noopener noreferrer">${escapeHtml(s.label)}</a>`;
      }
      return "";
    })
    .join("");
  return `<p class="card-meta-line">${inner}</p>`;
}

function scientificNameMetaHtml(obs) {
  const t = obs && obs.taxon;
  const sci = t && typeof t.name === "string" ? t.name.trim() : "";
  if (!sci) return "";
  return `<p class="card-meta-line card-meta-line--sci"><em>${escapeHtml(sci)}</em></p>`;
}

function observationLocationLine(obs) {
  const pg = (obs.place_guess || "").trim();
  if (pg) return pg;
  const g = obs.geojson;
  if (g && g.type === "Point" && Array.isArray(g.coordinates)) {
    const [lng, lat] = g.coordinates;
    return `${Number(lat).toFixed(4)}, ${Number(lng).toFixed(4)}`;
  }
  return "";
}

function inatFirstPhotoPageUrlFromObs(obs) {
  const photo = obs && obs.photos && obs.photos[0];
  const pid = photo && photo.id != null ? Number(photo.id) : NaN;
  if (!Number.isFinite(pid) || pid <= 0) return "";
  return `https://www.inaturalist.org/photos/${pid}`;
}

/** Observed-on line for observation cards (date ± time when available). */
function observationObservedOnLine(obs) {
  if (!obs || typeof obs !== "object") return "";
  const s = obs.observed_on_string;
  if (typeof s === "string" && s.trim()) return s.trim();
  const t = obs.time_observed_at;
  if (typeof t === "string" && t.trim()) {
    const d = new Date(t);
    if (!Number.isNaN(d.getTime())) return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    return t.trim();
  }
  const on = obs.observed_on;
  if (typeof on === "string" && on.trim()) return on.trim();
  return "";
}

function observationObserverLine(obs) {
  if (!obs || typeof obs !== "object") return "";
  const u = obs.user;
  const login = u && typeof u.login === "string" ? u.login.trim() : "";
  return login;
}

function observationMetaHtmlParts(obs, kcData) {
  const o = getCardMetaOptions();
  const parts = [];
  if (o.faves) {
    const n = obs.faves_count;
    const c = n == null ? 0 : Number(n);
    if (c > 0) {
      const t = c === 1 ? "1 favorite" : `${c} favorites`;
      parts.push(`<p class="card-meta-line">${escapeHtml(t)}</p>`);
    }
  }
  if (o.observer) {
    const login = observationObserverLine(obs);
    if (login) {
      parts.push(`<p class="card-meta-line">${escapeHtml(login)}</p>`);
    }
  }
  if (o.location) {
    const loc = observationLocationLine(obs);
    if (loc) parts.push(`<p class="card-meta-line">${escapeHtml(loc)}</p>`);
  }
  if (o.obsDate) {
    const od = observationObservedOnLine(obs);
    if (od) parts.push(`<p class="card-meta-line">${escapeHtml(od)}</p>`);
  }
  if (o.nativeStatus) {
    const segs = nativeStatusMetaSegments(obs, kcData);
    const h = renderMetaSegmentsHtml(segs);
    if (h) parts.push(h);
  }
  if (o.conservationStatus) {
    const line = conservationStatusMetaLine(obs && obs.taxon);
    if (line) parts.push(`<p class="card-meta-line">${escapeHtml(line)}</p>`);
  }
  if (o.grade) {
    const gl = formatQualityGradeLabel(obs.quality_grade);
    if (gl) parts.push(`<p class="card-meta-line">${escapeHtml(gl)}</p>`);
  }
  if (o.sciName) {
    const sh = scientificNameMetaHtml(obs);
    if (sh) parts.push(sh);
  }
  return parts;
}

function speciesMetaParts(row, obsTaxonById, kcData) {
  const o = getCardMetaOptions();
  const parts = [];
  if (o.speciesCount) {
    const c = row.count == null ? 0 : Number(row.count);
    const t = c === 1 ? "1 observation" : `${c} observations`;
    parts.push(`<p class="card-meta-line">${escapeHtml(t)}</p>`);
  }
  if (o.nativeStatus) {
    const taxon = row.taxon || {};
    const tid = taxon.id != null ? Number(taxon.id) : NaN;
    const statusTaxon = !Number.isNaN(tid) && obsTaxonById ? obsTaxonById.get(tid) : null;
    const segs = nativeStatusMetaSegmentsForTaxon(statusTaxon, kcData);
    const h = renderMetaSegmentsHtml(segs);
    if (h) parts.push(h);
  }
  if (o.conservationStatus) {
    const taxon = row.taxon || {};
    const tid = taxon.id != null ? Number(taxon.id) : NaN;
    const rich = !Number.isNaN(tid) && obsTaxonById ? obsTaxonById.get(tid) : null;
    const tCon = rich || taxon;
    const line = conservationStatusMetaLine(tCon);
    if (line) parts.push(`<p class="card-meta-line">${escapeHtml(line)}</p>`);
  }
  if (o.sciName) {
    const taxon = row.taxon || {};
    const sci = typeof taxon.name === "string" ? taxon.name.trim() : "";
    if (sci) parts.push(`<p class="card-meta-line card-meta-line--sci"><em>${escapeHtml(sci)}</em></p>`);
  }
  return parts;
}

/**
 * Taxon to agree with: same as the observation card title (`obs.taxon`), falling back to
 * `community_taxon_id` only when the observation has no taxon object (e.g. coarse guess only).
 * @param {object | null | undefined} obs
 * @returns {number | null}
 */
function agreeTargetTaxonIdForObservation(obs) {
  if (!obs || typeof obs !== "object") return null;
  const tid = obs.taxon && obs.taxon.id != null ? Number(obs.taxon.id) : NaN;
  if (Number.isFinite(tid) && tid > 0) return tid;
  const cid = obs.community_taxon_id != null ? Number(obs.community_taxon_id) : NaN;
  return Number.isFinite(cid) && cid > 0 ? cid : null;
}

/**
 * Taxon payload for the ID returned by {@link agreeTargetTaxonIdForObservation} (card / community / current ID).
 * @param {object | null | undefined} obs
 * @param {number} targetTaxonId
 * @returns {object | null}
 */
function agreeTargetTaxonFromObservation(obs, targetTaxonId) {
  if (!obs || typeof obs !== "object" || !Number.isFinite(targetTaxonId) || targetTaxonId <= 0) return null;
  const matchId = (t) => t && t.id != null && Number(t.id) === targetTaxonId;
  if (matchId(obs.taxon)) return obs.taxon;
  if (obs.community_taxon && matchId(obs.community_taxon)) return obs.community_taxon;
  const rows = Array.isArray(obs.identifications) ? obs.identifications : [];
  for (const row of rows) {
    if (!row || !row.current || row.hidden) continue;
    const tid = row.taxon_id != null ? Number(row.taxon_id) : NaN;
    if (tid !== targetTaxonId) continue;
    if (row.taxon && matchId(row.taxon)) return row.taxon;
  }
  return null;
}

/**
 * True when the taxon is species rank or finer (iNaturalist `rank_level` ≤ 10; genus is typically 20+).
 * @param {object | null | undefined} taxon
 */
function taxonIsSpeciesLevelOrFiner(taxon) {
  if (!taxon || typeof taxon !== "object") return false;
  const rl = taxon.rank_level != null ? Number(taxon.rank_level) : NaN;
  if (Number.isFinite(rl) && rl > 0) return rl <= 10;
  const r = typeof taxon.rank === "string" ? taxon.rank.trim().toLowerCase() : "";
  return r === "species" || r === "subspecies" || r === "variety" || r === "form" || r === "hybrid";
}

/**
 * Whether the signed-in user already has a current identification at `taxonId`.
 * @param {object | null | undefined} obs
 * @param {number} userId
 * @param {number} taxonId
 */
function userHasCurrentIdentificationAtTaxon(obs, userId, taxonId) {
  if (!obs || !Number.isFinite(userId) || userId <= 0 || !Number.isFinite(taxonId) || taxonId <= 0) return false;
  const rows = obs.identifications;
  if (!Array.isArray(rows)) return false;
  for (const row of rows) {
    if (!row || !row.current || row.hidden) continue;
    const uid = row.user && row.user.id != null ? Number(row.user.id) : NaN;
    if (uid !== userId) continue;
    const t = row.taxon_id != null ? Number(row.taxon_id) : NaN;
    if (t === taxonId) return true;
  }
  return false;
}

/**
 * HTML for the observation-card Agree control, or empty string when not applicable.
 * Uses Font Awesome 4 `fa-handshake-o` for a clearer “agree” metaphor than a thumbs-up.
 * @param {object | null | undefined} obs
 */
function observationAgreeButtonHtml(obs) {
  if (!inatAuthUser || inatAuthUser.id == null) return "";
  const meId = Number(inatAuthUser.id);
  if (!Number.isFinite(meId) || meId <= 0) return "";
  const ownerId = obs && obs.user && obs.user.id != null ? Number(obs.user.id) : NaN;
  if (Number.isFinite(ownerId) && ownerId === meId) return "";
  const taxonId = agreeTargetTaxonIdForObservation(obs);
  if (taxonId == null) return "";
  const agreeTaxon = agreeTargetTaxonFromObservation(obs, taxonId);
  if (!taxonIsSpeciesLevelOrFiner(agreeTaxon)) return "";
  if (userHasCurrentIdentificationAtTaxon(obs, meId, taxonId)) return "";
  const oid = obs && obs.id != null ? Number(obs.id) : NaN;
  if (!Number.isFinite(oid) || oid <= 0) return "";
  return `<button type="button" class="card-agree" aria-label="Agree with this observation on iNaturalist" title="Agree (posts your identification at the taxon shown on this card)" data-agree-obs-id="${Math.floor(
    oid
  )}" data-agree-taxon-id="${taxonId}"><i class="fa fa-handshake-o" aria-hidden="true"></i></button>`;
}

function renderInatApiAuthStatusEl(message, variant = "neutral") {
  const stat = el.inatApiAuthStatus;
  if (!stat) return;
  stat.textContent = message || "";
  stat.classList.toggle("inat-api-auth-status--error", variant === "error");
  stat.classList.toggle("inat-api-auth-status--ok", variant === "ok");
}

function explorerAuthPanelIsOpen() {
  return Boolean(el.explorerAuthPanel && !el.explorerAuthPanel.hidden);
}

function explorerIsSignedIn() {
  return Boolean(inatApiJwtAuthorizationValue() && inatAuthUser && inatAuthUser.id != null);
}

function setExplorerAuthPanelOpen(open) {
  if (!el.explorerAuthPanel || !el.btnExplorerAuthToggle) return;
  el.explorerAuthPanel.hidden = !open;
  if (explorerIsSignedIn()) {
    el.btnExplorerAuthToggle.removeAttribute("aria-expanded");
    return;
  }
  el.btnExplorerAuthToggle.setAttribute("aria-expanded", open ? "true" : "false");
}

function closeExplorerAuthPanel() {
  setExplorerAuthPanelOpen(false);
}

/**
 * Opens the Filters tab and the sign-in panel (e.g. auth-required filter or card action).
 * @param {{ reason?: string }} [options]
 */
async function openExplorerAuthPanel(options = {}) {
  const { reason } = options;
  if (!el.explorerAuthPanel) return;
  if (currentView !== "filters") await switchView("filters");
  setExplorerAuthPanelOpen(true);
  await refreshInatAuthUser();
  if (reason) renderInatApiAuthStatusEl(reason, "neutral");
  if (el.inatApiToken && typeof el.inatApiToken.focus === "function") {
    try {
      el.inatApiToken.focus({ preventScroll: false });
    } catch (ex) {
      explorerFatal(ex, "openExplorerAuthPanel:focus");
    }
  }
  try {
    el.explorerAuthPanel.scrollIntoView({ block: "nearest", behavior: "smooth" });
  } catch (ex) {
    explorerFatal(ex, "openExplorerAuthPanel:scrollIntoView");
  }
}

function syncExplorerAuthChrome() {
  if (!el.btnExplorerAuthToggle) return;
  const signedIn = explorerIsSignedIn();
  el.btnExplorerAuthToggle.textContent = signedIn ? "Log out" : "Log in";
  el.btnExplorerAuthToggle.setAttribute("aria-label", signedIn ? "Log out of iNaturalist" : "Log in to iNaturalist");
  if (signedIn) {
    setExplorerAuthPanelOpen(false);
    el.btnExplorerAuthToggle.removeAttribute("aria-expanded");
  } else {
    el.btnExplorerAuthToggle.setAttribute("aria-expanded", explorerAuthPanelIsOpen() ? "true" : "false");
  }
}

/** Loads `inatAuthUser` from `GET /users/me` when a JWT is stored; updates the Filters status line. */
async function refreshInatAuthUser() {
  try {
    const jwt = getStoredInatApiJwt();
    if (!jwt) {
      inatAuthUser = null;
      if (!explorerAuthPanelIsOpen()) renderInatApiAuthStatusEl("", "neutral");
      else renderInatApiAuthStatusEl("Not signed in. Paste a token (JSON or JWT), then Apply.", "neutral");
      return;
    }
    const format = validateInatJwtFormat(jwt);
    if (!format.ok) {
      inatAuthUser = null;
      renderInatApiAuthStatusEl(
        `Token format: ${format.error} Clear it and paste valid JSON or a JWT from iNaturalist.`,
        "error"
      );
      return;
    }
    let res;
    try {
      res = await fetchUsersMeWithStoredJwt();
    } catch (ex) {
      explorerFatal(ex, "refreshInatAuthUser:fetchUsersMeWithStoredJwt");
    }
    if (!res.ok) {
      inatAuthUser = null;
      const detail = await formatInatHttpErrorForDisplay(res);
      renderInatApiAuthStatusEl(`Token rejected. ${detail} Clear it or paste a new one.`, "error");
      return;
    }
    let data;
    try {
      data = await res.json();
    } catch (ex) {
      explorerFatal(ex, "refreshInatAuthUser:res.json");
    }
    const u = data && Array.isArray(data.results) ? data.results[0] : null;
    inatAuthUser = u && typeof u === "object" ? u : null;
    const login = inatAuthUser && typeof inatAuthUser.login === "string" ? inatAuthUser.login.trim() : "";
    renderInatApiAuthStatusEl(
      login
        ? `Signed in as ${login}. Under Controls shown, turn on “Favorite” for the star on cards, or “Agree & Mark reviewed” for those actions.`
        : "Signed in.",
      "ok"
    );
  } finally {
    syncExplorerAuthChrome();
  }
}

/**
 * Show a spinner on an Agree or Mark reviewed card control while its iNat API request is in flight.
 * @param {HTMLButtonElement} button
 */
function beginObservationCardWriteActionLoading(button) {
  button.classList.add("card-write-action--loading");
  const icon = button.querySelector("i.fa");
  if (icon) {
    button.dataset.writeActionIconClass = icon.className;
    icon.className = "fa fa-spinner fa-spin";
  }
  button.setAttribute("aria-busy", "true");
  if (button.classList.contains("card-agree")) {
    button.dataset.writeActionPrevAria = button.getAttribute("aria-label") || "";
    button.dataset.writeActionPrevTitle = button.getAttribute("title") || "";
    button.setAttribute("aria-label", "Agreeing…");
    button.title = "Agreeing…";
  } else if (button.classList.contains("card-mark-reviewed")) {
    button.dataset.writeActionPrevAria = button.getAttribute("aria-label") || "";
    button.dataset.writeActionPrevTitle = button.getAttribute("title") || "";
    button.setAttribute("aria-label", "Marking reviewed…");
    button.title = "Marking reviewed…";
  }
}

/**
 * @param {HTMLButtonElement} button
 */
function endObservationCardWriteActionLoadingFailure(button) {
  button.classList.remove("card-write-action--loading");
  button.removeAttribute("aria-busy");
  const icon = button.querySelector("i.fa");
  const saved = button.dataset.writeActionIconClass;
  if (icon && typeof saved === "string" && saved.trim() !== "") {
    icon.className = saved;
  }
  delete button.dataset.writeActionIconClass;
  const pa = button.dataset.writeActionPrevAria;
  const pt = button.dataset.writeActionPrevTitle;
  if (pa !== undefined) button.setAttribute("aria-label", pa);
  if (pt !== undefined) button.setAttribute("title", pt);
  delete button.dataset.writeActionPrevAria;
  delete button.dataset.writeActionPrevTitle;
}

/**
 * Drop loading chrome before applying the permanent success state (caller sets new labels).
 * @param {HTMLButtonElement} button
 */
function endObservationCardWriteActionLoadingSuccess(button) {
  button.classList.remove("card-write-action--loading");
  button.removeAttribute("aria-busy");
  const icon = button.querySelector("i.fa");
  const saved = button.dataset.writeActionIconClass;
  if (icon && typeof saved === "string" && saved.trim() !== "") {
    icon.className = saved;
  }
  delete button.dataset.writeActionIconClass;
  delete button.dataset.writeActionPrevAria;
  delete button.dataset.writeActionPrevTitle;
}

/**
 * After a successful Agree or Mark reviewed API write, keep the card on screen and show which
 * action completed (disabled button plus a `--done` class for styling).
 * @param {HTMLButtonElement} button
 */
function markObservationWriteActionButtonSucceeded(button) {
  endObservationCardWriteActionLoadingSuccess(button);
  try {
    if (button instanceof HTMLElement && "blur" in button) button.blur();
  } catch (ex) {
    explorerFatal(ex, "markObservationWriteActionButtonSucceeded:blur");
  }
  if (button.classList.contains("card-agree")) {
    button.classList.add("card-agree--done");
    button.title = "Agreed (posted to iNaturalist)";
    button.setAttribute("aria-label", "Agreed with this observation on iNaturalist");
  } else if (button.classList.contains("card-mark-reviewed")) {
    button.classList.add("card-mark-reviewed--done");
    button.title = "Marked reviewed on iNaturalist";
    button.setAttribute("aria-label", "Marked reviewed on iNaturalist");
  }
  button.disabled = true;
}

/**
 * @param {HTMLButtonElement} button
 * @param {string} obsIdStr
 * @param {string} taxonIdStr
 */
async function submitObservationAgree(button, obsIdStr, taxonIdStr) {
  const obsId = Number(obsIdStr);
  const taxonId = Number(taxonIdStr);
  if (!Number.isFinite(obsId) || obsId <= 0 || !Number.isFinite(taxonId) || taxonId <= 0) return;
  if (!inatApiJwtAuthorizationValue()) {
    void openExplorerAuthPanel({ reason: "Sign in with an API token to use Agree on observation cards." });
    return;
  }
  if (button.disabled) return;
  button.disabled = true;
  beginObservationCardWriteActionLoading(button);
  try {
    const res = await inatFetch("identifications", {
      method: "POST",
      auth: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identification: { observation_id: Math.floor(obsId), taxon_id: taxonId } }),
    });
    if (!res.ok) {
      const detail = await formatInatHttpErrorForDisplay(res);
      window.alert(`Could not agree. ${detail}`);
      endObservationCardWriteActionLoadingFailure(button);
      button.disabled = false;
      return;
    }
    markObservationWriteActionButtonSucceeded(button);
  } catch (e) {
    endObservationCardWriteActionLoadingFailure(button);
    button.disabled = false;
    explorerFatal(e, "submitObservationAgree");
  }
}

/**
 * HTML for “Mark reviewed” on an observation card (Identify-style; requires API sign-in).
 * Hidden for your own observations (same boundary as Agree).
 */
function observationMarkReviewedButtonHtml(obs) {
  if (!inatAuthUser || inatAuthUser.id == null) return "";
  const meId = Number(inatAuthUser.id);
  if (!Number.isFinite(meId) || meId <= 0) return "";
  const ownerId = obs && obs.user && obs.user.id != null ? Number(obs.user.id) : NaN;
  if (Number.isFinite(ownerId) && ownerId === meId) return "";
  const oid = obs && obs.id != null ? Number(obs.id) : NaN;
  if (!Number.isFinite(oid) || oid <= 0) return "";
  return `<button type="button" class="card-mark-reviewed" aria-label="Mark this observation as reviewed on iNaturalist" title="Mark reviewed (your Identify queue)" data-review-obs-id="${Math.floor(
    oid
  )}"><i class="fa fa-eye-slash" aria-hidden="true"></i></button>`;
}

/**
 * True when a vote row is an observation “fave” (not a quality-metric vote such as `needs_id`).
 * @param {object | null | undefined} row
 */
function observationVoteRowIsFave(row) {
  if (!row || typeof row !== "object") return false;
  if (row.vote_flag === false) return false;
  const vs = row.vote_scope;
  return vs == null || String(vs).trim() === "";
}

/**
 * User id on a vote / fave row (`user_id` or nested `user.id`).
 * @param {object | null | undefined} row
 */
function observationVoteRowUserId(row) {
  if (!row || typeof row !== "object") return NaN;
  if (row.user_id != null) {
    const n = Number(row.user_id);
    if (Number.isFinite(n) && n > 0) return n;
  }
  if (row.user && row.user.id != null) {
    const n = Number(row.user.id);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return NaN;
}

/**
 * Whether the signed-in user has an active fave on this observation.
 * Uses `faved_by_current_user` when present, otherwise scans `faves` and `votes` (index `faves` can be
 * truncated; `votes` includes the viewer’s fave vote when the API omits them from `faves`).
 * @param {object | null | undefined} obs
 * @param {number} meId
 */
function currentUserHasFavedObservation(obs, meId) {
  if (!obs || typeof obs !== "object" || !Number.isFinite(meId) || meId <= 0) return false;
  if (obs.faved_by_current_user === true || obs.faved_by_current_user === 1) return true;
  const scanRows = (rows) => {
    if (!Array.isArray(rows)) return false;
    for (const row of rows) {
      if (observationVoteRowUserId(row) !== meId) continue;
      if (observationVoteRowIsFave(row)) return true;
    }
    return false;
  };
  if (scanRows(obs.faves)) return true;
  if (scanRows(obs.votes)) return true;
  return false;
}

/**
 * HTML for Favorite / Unfavorite on an observation card (API v1 `POST/DELETE …/fave` / `unfave`).
 * Shown when “Favorite” is enabled under Controls shown and the viewer is signed in.
 * @param {object | null | undefined} obs
 */
function observationFavoriteButtonHtml(obs) {
  if (!inatAuthUser || inatAuthUser.id == null) return "";
  const meId = Number(inatAuthUser.id);
  if (!Number.isFinite(meId) || meId <= 0) return "";
  const oid = obs && obs.id != null ? Number(obs.id) : NaN;
  if (!Number.isFinite(oid) || oid <= 0) return "";
  const faved = currentUserHasFavedObservation(obs, meId);
  const iconClass = faved ? "fa fa-star" : "fa fa-star-o";
  const title = faved ? "Unfavorite on iNaturalist" : "Favorite on iNaturalist";
  const aria = faved ? "Remove favorite on iNaturalist" : "Add favorite on iNaturalist";
  const activeClass = faved ? " card-fave--active" : "";
  return `<button type="button" class="card-fave${activeClass}" aria-pressed="${faved ? "true" : "false"}" aria-label="${escapeHtml(
    aria
  )}" title="${escapeHtml(title)}" data-fave-obs-id="${Math.floor(oid)}" data-fave-active="${faved ? "1" : "0"}"><i class="${iconClass}" aria-hidden="true"></i></button>`;
}

/**
 * @param {HTMLButtonElement} button
 * @param {string} obsIdStr
 * @param {boolean} currentlyFaved
 */
async function submitObservationFavoriteToggle(button, obsIdStr, currentlyFaved) {
  const obsId = Number(obsIdStr);
  if (!Number.isFinite(obsId) || obsId <= 0) return;
  if (!inatApiJwtAuthorizationValue()) {
    void openExplorerAuthPanel({ reason: "Sign in with an API token to favorite observations from cards." });
    return;
  }
  if (button.disabled) return;
  const wantFave = !currentlyFaved;
  button.disabled = true;
  try {
    const res = wantFave
      ? await inatFetch(`observations/${Math.floor(obsId)}/fave`, { method: "POST", auth: true })
      : await inatFetch(`observations/${Math.floor(obsId)}/unfave`, { method: "DELETE", auth: true });
    if (!res.ok) {
      const detail = await formatInatHttpErrorForDisplay(res);
      window.alert(`Could not update favorite. ${detail}`);
      return;
    }
    const icon = button.querySelector("i.fa");
    if (wantFave) {
      button.classList.add("card-fave--active");
      button.setAttribute("aria-pressed", "true");
      button.setAttribute("data-fave-active", "1");
      if (icon) {
        icon.classList.remove("fa-star-o");
        icon.classList.add("fa-star");
      }
      button.title = "Unfavorite on iNaturalist";
      button.setAttribute("aria-label", "Remove favorite on iNaturalist");
    } else {
      button.classList.remove("card-fave--active");
      button.setAttribute("aria-pressed", "false");
      button.setAttribute("data-fave-active", "0");
      if (icon) {
        icon.classList.remove("fa-star");
        icon.classList.add("fa-star-o");
      }
      button.title = "Favorite on iNaturalist";
      button.setAttribute("aria-label", "Add favorite on iNaturalist");
    }
  } catch (e) {
    explorerFatal(e, "submitObservationFavoriteToggle");
  } finally {
    button.disabled = false;
  }
}

/**
 * @param {HTMLButtonElement} button
 * @param {string} obsIdStr
 */
async function submitObservationMarkReviewed(button, obsIdStr) {
  const obsId = Number(obsIdStr);
  if (!Number.isFinite(obsId) || obsId <= 0) return;
  if (!inatApiJwtAuthorizationValue()) {
    void openExplorerAuthPanel({ reason: "Sign in with an API token to use Mark reviewed on observation cards." });
    return;
  }
  if (button.disabled) return;
  button.disabled = true;
  beginObservationCardWriteActionLoading(button);
  try {
    const res = await inatFetch(`observations/${Math.floor(obsId)}/review`, {
      method: "POST",
      auth: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reviewed: "true" }),
    });
    if (!res.ok) {
      const detail = await formatInatHttpErrorForDisplay(res);
      window.alert(`Could not mark reviewed. ${detail}`);
      endObservationCardWriteActionLoadingFailure(button);
      button.disabled = false;
      return;
    }
    markObservationWriteActionButtonSucceeded(button);
  } catch (e) {
    endObservationCardWriteActionLoadingFailure(button);
    button.disabled = false;
    explorerFatal(e, "submitObservationMarkReviewed");
  }
}

/** Wraps an observation/species card photo for in-app pinch / Ctrl+wheel zoom (page zoom is disabled). */
function wrapExplorerImagePinchShell(innerMarkup) {
  return `<div class="card-photo-pinch" data-explorer-pinch-zoom><div class="card-photo-pinch__view">${innerMarkup}</div></div>`;
}

function cardPhotoImgTagFromMediumUrl(mediumUrl, loading = "lazy") {
  const raw = typeof mediumUrl === "string" ? mediumUrl.trim() : "";
  if (!raw) return "";
  const escSrc = escapeHtml(raw);
  const largeU = largePhotoUrl(raw);
  const srcset = largeU && largeU !== raw ? ` srcset="${escapeHtml(largeU)} 2x"` : "";
  const loadAttr = loading === "eager" ? 'loading="eager"' : 'loading="lazy"';
  return wrapExplorerImagePinchShell(
    `<img class="card-photo" src="${escSrc}"${srcset} alt="" ${loadAttr} decoding="async" />`,
  );
}

function buildCardImageBlockFromUrls(urls) {
  if (!urls.length) return `<div class="no-photo">No photo</div>`;
  if (urls.length === 1) {
    return cardPhotoImgTagFromMediumUrl(urls[0], "lazy");
  }
  const nPhotos = urls.length;
  const dotsHtml = urls
    .map(
      (_, i) =>
        `<button type="button" class="card-media-carousel__dot-slot" data-dot-index="${i}" aria-label="Show photo ${i + 1} of ${nPhotos}" title="Photo ${i + 1}"><span class="card-media-carousel__dot${
          i === 0 ? " card-media-carousel__dot--active" : ""
        }" aria-hidden="true"></span></button>`
    )
    .join("");
  const slidesHtml = urls
    .map((raw, slideIndex) => {
      const inner = cardPhotoImgTagFromMediumUrl(raw, slideIndex === 0 ? "eager" : "lazy");
      return `<div class="card-media-carousel__slide">${inner}</div>`;
    })
    .join("");
  return `<div class="card-media-carousel" role="group" aria-label="Observation photos"><div class="card-media-carousel__scroll">${slidesHtml}</div><div class="card-media-carousel__dots" role="group" aria-label="Choose photo">${dotsHtml}</div></div>`;
}

/**
 * Horizontal photo carousel: scroll-snap + swipe; suppress stray taps after a swipe.
 * @param {HTMLElement} card
 */
function wireObservationCardPhotoCarousel(card) {
  const root = card.querySelector(".card-media-carousel");
  const scrollEl = root?.querySelector(":scope > .card-media-carousel__scroll");
  const linkSurface = card.querySelector(".card-link");
  if (!root || !scrollEl || !linkSurface) return;
  const slides = scrollEl.querySelectorAll(":scope > .card-media-carousel__slide");
  const n = slides.length;
  if (n < 2) return;

  const pageW = () => (scrollEl.clientWidth > 0 ? scrollEl.clientWidth : 1);

  /** Index of the slide whose center is nearest the viewport center (stable with scroll-snap + subpixels). */
  const slideIndexFromScroll = () => {
    const w = pageW();
    if (w <= 0 || n < 1) return 0;
    const x = scrollEl.scrollLeft + w * 0.5;
    return Math.min(n - 1, Math.max(0, Math.floor(x / w)));
  };

  let blockNavUntil = 0;
  const blockNav = (ms = 480) => {
    blockNavUntil = Math.max(blockNavUntil, Date.now() + ms);
  };

  const syncDots = () => {
    const idx = slideIndexFromScroll();
    const dotRow = root.querySelector(":scope > .card-media-carousel__dots");
    if (!dotRow) return;
    dotRow.querySelectorAll(".card-media-carousel__dot-slot").forEach((slot) => {
      const di = slot.getAttribute("data-dot-index");
      const j = di != null ? Number(di) : NaN;
      const dot = slot.querySelector(".card-media-carousel__dot");
      if (!dot) return;
      dot.classList.toggle("card-media-carousel__dot--active", Number.isFinite(j) && j === idx);
    });
    root.setAttribute("aria-label", `Observation photos, ${idx + 1} of ${n}`);
  };

  let scrollRaf = 0;
  const scheduleSyncDots = () => {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      syncDots();
    });
  };

  let scrollAtPointerDown = 0;
  let pointerDownX = 0;
  let pointerActive = false;

  scrollEl.addEventListener(
    "pointerdown",
    (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      pointerActive = true;
      pointerDownX = e.clientX;
      scrollAtPointerDown = scrollEl.scrollLeft;
    },
    { passive: true }
  );
  scrollEl.addEventListener(
    "pointerup",
    (e) => {
      if (!pointerActive) return;
      pointerActive = false;
      const dx = e.clientX - pointerDownX;
      const ds = Math.abs(scrollEl.scrollLeft - scrollAtPointerDown);
      if (Math.abs(dx) > 18 || ds > 6) blockNav();
      scheduleSyncDots();
    },
    { passive: true }
  );
  scrollEl.addEventListener("pointercancel", () => {
    pointerActive = false;
  });

  scrollEl.addEventListener(
    "scroll",
    () => {
      scheduleSyncDots();
    },
    { passive: true }
  );

  scrollEl.addEventListener("scrollend", () => {
    scheduleSyncDots();
  });

  const dotRow = root.querySelector(":scope > .card-media-carousel__dots");
  if (dotRow) {
    const goToSlideIndex = (j) => {
      if (!Number.isFinite(j) || j < 0 || j >= n) return;
      const w = pageW();
      scrollEl.scrollTo({ left: j * w, behavior: "smooth" });
      blockNav(220);
      scheduleSyncDots();
    };
    dotRow.addEventListener("click", (e) => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      const btn = t.closest("button.card-media-carousel__dot-slot");
      if (!btn || !dotRow.contains(btn)) return;
      e.preventDefault();
      e.stopPropagation();
      const di = btn.getAttribute("data-dot-index");
      goToSlideIndex(di != null ? Number(di) : NaN);
    });
  }

  linkSurface.addEventListener(
    "click",
    (e) => {
      if (Date.now() < blockNavUntil) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    },
    true
  );

  scrollEl.tabIndex = 0;
  scrollEl.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      scrollEl.scrollBy({ left: -pageW(), behavior: "smooth" });
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      scrollEl.scrollBy({ left: pageW(), behavior: "smooth" });
    }
  });

  scheduleSyncDots();
}

function renderCard({
  href,
  name,
  imageUrl,
  imageUrls = null,
  metaLines = [],
  metaParts = null,
  onClick,
  observationId,
  inatAppObservationId = null,
  agreeObservation = null,
}) {
  const card = document.createElement("article");
  card.className = "card";
  const oid = observationId != null ? Number(observationId) : NaN;
  if (Number.isFinite(oid) && oid > 0) {
    card.dataset.obsId = String(Math.floor(oid));
  }
  const urls =
    imageUrls != null && Array.isArray(imageUrls) && imageUrls.length > 0
      ? imageUrls.filter((u) => typeof u === "string" && u.trim())
      : imageUrl
        ? [imageUrl]
        : [];
  const metaBlock = metaParts != null
    ? metaParts.join("")
    : metaLines.length
      ? metaLines.map((line) => `<p class="card-meta-line">${escapeHtml(line)}</p>`).join("")
      : "";
  const appObsId = inatAppObservationId != null ? Number(inatAppObservationId) : NaN;
  const openInatHref =
    Number.isFinite(appObsId) && appObsId > 0 ? inatObservationCardExternalHref(Math.floor(appObsId)) : "";
  const openAppBtn =
    openInatHref
      ? `<a class="card-open-inat-app" href="${escapeHtml(openInatHref)}" target="_blank" rel="noopener noreferrer" aria-label="Open this observation on iNaturalist in a new tab" title="Open on iNaturalist (new tab)"><i class="fa fa-external-link" aria-hidden="true"></i></a>`
      : "";
  const cardMetaUi = getCardMetaOptions();
  const photoHref =
    cardMetaUi.photoPage && agreeObservation ? inatFirstPhotoPageUrlFromObs(agreeObservation) : "";
  const photoPageBtn =
    photoHref
      ? `<a class="card-photo-page-link" href="${escapeHtml(photoHref)}" target="_blank" rel="noopener noreferrer" aria-label="Open the first photo page on iNaturalist in a new tab" title="Photo page — first image on iNaturalist (new tab)"><i class="fa fa-info-circle" aria-hidden="true"></i></a>`
      : "";
  const agreeBtn =
    cardMetaUi.identifyControls && agreeObservation ? observationAgreeButtonHtml(agreeObservation) : "";
  const reviewBtn =
    cardMetaUi.identifyControls && agreeObservation ? observationMarkReviewedButtonHtml(agreeObservation) : "";
  const faveBtn =
    cardMetaUi.favoriteControl && agreeObservation ? observationFavoriteButtonHtml(agreeObservation) : "";
  /** Upper-right stack: open iNat, photo page, favorite, mark reviewed, agree (top to bottom). */
  const upperRightActions = [openAppBtn, photoPageBtn, faveBtn, reviewBtn, agreeBtn].filter((s) => typeof s === "string" && s.trim() !== "");
  const upperRightActionsHtml =
    upperRightActions.length > 0
      ? `<div class="card-actions-upper-right">${upperRightActions.join("")}</div>`
      : "";
  const imgBlock = buildCardImageBlockFromUrls(urls);
  if (onClick) {
    card.innerHTML = `
      <div class="card-link" role="button" tabindex="0" style="cursor:pointer">
        ${imgBlock}
      </div>
      ${upperRightActionsHtml}
      <div class="card-details-overlay">
        <p class="card-title-overlay">${escapeHtml(name)}</p>
        ${metaBlock}
      </div>
    `;
    const linkEl = card.querySelector(".card-link");
    linkEl.addEventListener("click", (e) => {
      e.preventDefault();
      onClick();
    });
    linkEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onClick();
      }
    });
  } else {
    card.innerHTML = `
      <div class="card-link">
        ${imgBlock}
      </div>
      ${upperRightActionsHtml}
      <div class="card-details-overlay">
        <p class="card-title-overlay">${escapeHtml(name)}</p>
        ${metaBlock}
      </div>
    `;
  }
  if (urls.length > 1) {
    wireObservationCardPhotoCarousel(card);
  }
  return card;
}

async function runObservationSearch(reset) {
  if (obsLoading) return;
  obsLoading = true;
  showError("obs", "");
  try {
    if (observationListNeedsAuthForReviewFilter()) {
      if (!inatAuthUser || inatAuthUser.id == null || !inatApiJwtAuthorizationValue()) {
        showError(
          "obs",
          "Pick “Unreviewed by me” or “Favorited by me” only after you sign in with an API token (Log in at the bottom of Filters).",
        );
        void openExplorerAuthPanel({
          reason: "Sign in with an API token to use the “Unreviewed by me” or “Favorited by me” filters.",
        });
        return;
      }
    }

    if (reset) {
      obsListCursorId = null;
      obsListCursorAscId = null;
      obsSeenIds.clear();
      totalObs = 0;
      totalSpecies = 0;
      obsHasMore = false;
      obsCardCount = 0;
      el.resultsGrid.innerHTML = "";
    }

    const metaOptsEarly = getCardMetaOptions();
    const estFilterActive = establishmentClientFilterActive();
    let kcForEstablishment = null;
    if (estFilterActive || metaOptsEarly.nativeStatus) {
      kcForEstablishment = await ensureKingCountyNoxiousData();
    }

    let lastBatchLen = 0;
    let lastIterAppended = 0;
    let innerAttempts = 0;
    const maxInnerAttempts = 20;

    while (innerAttempts < maxInnerAttempts) {
      innerAttempts += 1;
      const res = await inatObservationQueryFetchWithRetry(
        "observations",
        await observationParams({
          idBelow: obsListCursorId,
          idAbove: obsListCursorAscId,
        }),
        observationListAuthFetchOptions(),
      );
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const data = await res.json();
      totalObs = data.total_results || 0;
      const batch = sortObservationResultsForDisplay(data.results || []);
      lastBatchLen = batch.length;

      const rawIds = batch.map((o) => (o && o.id != null ? Number(o.id) : NaN)).filter((n) => Number.isFinite(n));
      if (rawIds.length) {
        if (el.sortMode.value === "oldest" || el.sortMode.value === "obs_oldest") {
          obsListCursorAscId = Math.max(...rawIds);
        } else {
          obsListCursorId = Math.min(...rawIds);
        }
      }

      const forDisplay = estFilterActive
        ? batch.filter((o) => observationPassesEstablishmentCheckboxes(o, kcForEstablishment))
        : batch;

      const metaOpts = getCardMetaOptions();
      let kcData = null;
      if (metaOpts.nativeStatus) {
        kcData = kcForEstablishment || (await ensureKingCountyNoxiousData());
      }

      const frag = document.createDocumentFragment();
      let iterAppended = 0;
      for (const obs of forDisplay) {
        const oid = obs && obs.id != null ? Number(obs.id) : NaN;
        if (!Number.isFinite(oid) || obsSeenIds.has(oid)) continue;
        obsSeenIds.add(oid);
        const name = obs.taxon?.preferred_common_name || obs.taxon?.name || obs.species_guess || "Unknown";
        const photoUrls = observationPhotoDisplayUrlsFromObs(obs);
        const imageUrl = photoUrls[0] || "";
        frag.appendChild(
          renderCard({
            href: `https://www.inaturalist.org/observations/${obs.id}`,
            name,
            imageUrl,
            imageUrls: photoUrls.length > 1 ? photoUrls : null,
            metaParts: observationMetaHtmlParts(obs, kcData),
            observationId: oid,
            inatAppObservationId: oid,
            agreeObservation: obs,
          })
        );
        iterAppended += 1;
      }
      el.resultsGrid.appendChild(frag);
      obsCardCount += iterAppended;
      lastIterAppended = iterAppended;

      if (iterAppended > 0) break;
      if (batch.length === 0) break;
    }

    if (reset) {
      void (async () => {
        try {
          const sRes = await inatObservationQueryFetchWithRetry(
            "observations/species_counts",
            await speciesCountParams(),
            observationListAuthFetchOptions(),
          );
          if (!sRes.ok) return;
          const sData = await sRes.json();
          totalSpecies = sData.total_results || 0;
          updateSearchSummaryElements();
        } catch (ex) {
          console.warn("runObservationSearch:species_counts side fetch", ex);
        }
      })();
    }

    const stuckWithNoNewCards = lastBatchLen > 0 && lastIterAppended === 0 && !establishmentClientFilterActive();
    if (establishmentClientFilterActive()) {
      obsHasMore = lastBatchLen === OBS_PER_PAGE;
    } else {
      obsHasMore = !stuckWithNoNewCards && obsCardCount < totalObs && lastBatchLen > 0;
    }
    updateSearchSummaryElements();
    syncUrl();
  } catch (err) {
    console.warn("runObservationSearch", err);
    const detail = err instanceof Error ? err.message.trim() : String(err);
    showError(
      "obs",
      detail
        ? `Could not load observations (${detail}). Try Refresh or adjust filters.`
        : "Could not load observations. Try Refresh or adjust filters.",
    );
  } finally {
    obsLoading = false;
  }
}

async function runSpeciesSearch(reset) {
  if (speciesLoading) return;
  speciesLoading = true;
  showError("species", "");
  try {
    if (observationListNeedsAuthForReviewFilter()) {
      if (!inatAuthUser || inatAuthUser.id == null || !inatApiJwtAuthorizationValue()) {
        showError(
          "species",
          "Pick “Unreviewed by me” or “Favorited by me” only after you sign in with an API token (Log in at the bottom of Filters).",
        );
        void openExplorerAuthPanel({
          reason: "Sign in with an API token to use the “Unreviewed by me” or “Favorited by me” filters.",
        });
        return;
      }
    }

    if (reset) {
      speciesPage = 1;
      totalSpecies = 0;
      totalObs = 0;
      speciesHasMore = false;
      speciesCardCount = 0;
      el.speciesGrid.innerHTML = "";
    }

    const res = await inatObservationQueryFetchWithRetry(
      "observations/species_counts",
      await speciesParams(speciesPage),
      observationListAuthFetchOptions(),
    );
    if (!res.ok) throw new Error(`Request failed (${res.status})`);
    const data = await res.json();
    const results = data.results || [];
    totalSpecies = data.total_results || 0;

    if (reset) {
      void (async () => {
        try {
          const oRes = await inatObservationQueryFetchWithRetry(
            "observations",
            await observationCountParams(),
            observationListAuthFetchOptions(),
          );
          if (!oRes.ok) return;
          const oData = await oRes.json();
          totalObs = oData.total_results || 0;
          updateSearchSummaryElements();
        } catch (ex) {
          console.warn("runSpeciesSearch:observation count side fetch", ex);
        }
      })();
    }

    const metaOpts = getCardMetaOptions();
    let kcData = null;
    let obsTaxonById = null;
    if (metaOpts.nativeStatus || metaOpts.conservationStatus) {
      if (metaOpts.nativeStatus) {
        kcData = await ensureKingCountyNoxiousData();
      }
      const ids = results.map((r) => r.taxon && r.taxon.id).filter((id) => id != null);
      obsTaxonById = await fetchObservationTaxonById(ids);
    }

    const frag = document.createDocumentFragment();
    for (const row of results) {
      const taxon = row.taxon || {};
      const name = taxon.preferred_common_name || taxon.name || "Unknown";
      const rawPhoto = taxon.default_photo?.url || taxon.default_photo?.medium_url || "";
      const imageUrl = observationCardPhotoDisplayUrl(rawPhoto);
      frag.appendChild(renderCard({
        href: `https://www.inaturalist.org/taxa/${taxon.id || ""}`,
        name,
        imageUrl,
        metaParts: speciesMetaParts(row, obsTaxonById, kcData),
        onClick: () => showSpeciesDetail(taxon, row.count),
      }));
    }
    el.speciesGrid.appendChild(frag);
    speciesCardCount += results.length;

    const loaded = speciesCardCount;
    speciesHasMore = loaded < totalSpecies && results.length > 0;
    if (speciesHasMore) speciesPage += 1;
    updateSearchSummaryElements();
    syncUrl();
  } catch (err) {
    console.warn("runSpeciesSearch", err);
    const detail = err instanceof Error ? err.message.trim() : String(err);
    showError(
      "species",
      detail
        ? `Could not load species (${detail}). Try Refresh or adjust filters.`
        : "Could not load species. Try Refresh or adjust filters.",
    );
  } finally {
    speciesLoading = false;
  }
}

/** True when URL carries a saved map center so we should not auto-fit to the place/radius filter on load. */
function urlHasValidMapPosition() {
  const q = new URLSearchParams(window.location.search);
  const la = parseFloat(q.get("mlat"));
  const ln = parseFloat(q.get("mlng"));
  if (Number.isNaN(la) || Number.isNaN(ln)) return false;
  if (la < -90 || la > 90 || ln < -180 || ln > 180) return false;
  return true;
}

function readInitialMapViewFromUrl() {
  const q = new URLSearchParams(window.location.search);
  const la = parseFloat(q.get("mlat"));
  const ln = parseFloat(q.get("mlng"));
  const zRaw = q.get("zoom");
  let lat = 20;
  let lng = 0;
  let zoom = 2;
  if (!Number.isNaN(la) && !Number.isNaN(ln) && la >= -90 && la <= 90 && ln >= -180 && ln <= 180) {
    lat = la;
    lng = ln;
  }
  if (zRaw != null && zRaw !== "") {
    const z = parseInt(zRaw, 10);
    if (!Number.isNaN(z)) zoom = Math.min(19, Math.max(0, z));
  }
  return { lat, lng, zoom };
}

function ensureMapUserLocationLayer() {
  if (!map || mapUserLocationLayer) return;
  mapUserLocationLayer = L.layerGroup().addTo(map);
}

function clearMapUserLocationMarker() {
  if (mapUserLocationLayer) mapUserLocationLayer.clearLayers();
}

function stopMapUserLocationWatch() {
  if (mapGeolocationWatchId != null && navigator.geolocation) {
    navigator.geolocation.clearWatch(mapGeolocationWatchId);
    mapGeolocationWatchId = null;
  }
  clearMapUserLocationMarker();
}

function bringMapUserLocationToFront() {
  if (!mapUserLocationLayer || !map || !map.hasLayer(mapUserLocationLayer)) return;
  /* `L.layerGroup` has no `bringToFront` in Leaflet 1.9; bring child layers up instead. */
  mapUserLocationLayer.eachLayer((layer) => {
    try {
      if (typeof layer.bringToFront === "function") layer.bringToFront();
    } catch (ex) {
      explorerFatal(ex, "bringMapUserLocationToFront:bringToFront");
    }
  });
}

function showUserLocationOnMap(lat, lng) {
  if (!map || !window.L) return;
  const la = Number(lat);
  const ln = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln) || la < -90 || la > 90 || ln < -180 || ln > 180) return;
  ensureMapUserLocationLayer();
  if (!mapUserLocationLayer) return;
  mapUserLocationLayer.clearLayers();
  const r = Math.max(mapPinMarkerRadius() + 2, 9);
  const marker = L.circleMarker([la, ln], {
    radius: r,
    color: "#0d47a1",
    fillColor: "#2196f3",
    fillOpacity: 0.92,
    weight: 2,
    className: "map-user-location-marker",
  });
  marker.bindPopup("Your location");
  marker.off("click");
  marker.on("click", function (e) {
    L.DomEvent.stopPropagation(e);
    this.openPopup(this.getLatLng());
  });
  marker.addTo(mapUserLocationLayer);
  bringMapUserLocationToFront();
}

function startMapUserLocationWatch() {
  stopMapUserLocationWatch();
  if (!map || !navigator.geolocation) return;
  ensureMapUserLocationLayer();
  mapGeolocationWatchId = navigator.geolocation.watchPosition(
    (pos) => {
      if (currentView !== "map" || !map) return;
      const { latitude, longitude } = pos.coords;
      showUserLocationOnMap(latitude, longitude);
    },
    (geoErr) => {
      /* iOS Safari can surface transient watch errors when the system UI (share sheet, app switcher)
       * interrupts location updates — must not replace the page via explorerFatal. */
      console.warn("startMapUserLocationWatch:watchPosition", geoErr);
    },
    { enableHighAccuracy: true, maximumAge: 20000, timeout: 20000 }
  );
}

/**
 * Tear down Leaflet when leaving the Map tab (or on full reset). A map whose container is
 * `display:none` still listens to `window` resize; iOS Safari’s system share sheet resizes the
 * viewport and that combination has destabilized WebKit tabs. Recreate the map on the next visit.
 */
function destroyLeafletMap() {
  if (mapMoveTimer != null) {
    clearTimeout(mapMoveTimer);
    mapMoveTimer = null;
  }
  if (mapWindowResizeRaf) {
    cancelAnimationFrame(mapWindowResizeRaf);
    mapWindowResizeRaf = 0;
  }
  mapSearchSeq += 1;
  stopMapUserLocationWatch();
  if (map) {
    try {
      map.remove();
    } catch (ex) {
      console.warn("destroyLeafletMap:map.remove", ex);
    }
  }
  map = null;
  pinsLayer = null;
  mapUserLocationLayer = null;
  heatGridLayer = null;
  pendingHeatLayer = null;
  currentHeatUrl = null;
  mapMode = null;
}

function installExplorerMapWindowResizeListener() {
  if (mapWindowResizeListenerInstalled) return;
  mapWindowResizeListenerInstalled = true;
  const scheduleInvalidate = () => {
    if (currentView !== "map" || !map) return;
    if (mapWindowResizeRaf) cancelAnimationFrame(mapWindowResizeRaf);
    mapWindowResizeRaf = requestAnimationFrame(() => {
      mapWindowResizeRaf = 0;
      if (currentView !== "map" || !map) return;
      try {
        map.invalidateSize(false);
      } catch (ex) {
        console.warn("installExplorerMapWindowResizeListener:invalidateSize", ex);
      }
    });
  };
  window.addEventListener("resize", scheduleInvalidate, { passive: true });
  if (typeof visualViewport !== "undefined" && visualViewport) {
    visualViewport.addEventListener("resize", scheduleInvalidate, { passive: true });
  }
}

function ensureMap() {
  if (map || !window.L) return;
  /* `trackResize: false` — Leaflet’s default window resize path runs even when the map is a bad
   * size; iOS Safari’s share sheet resizes the viewport and has destabilized WebKit. We resize
   * only while the Map tab is active (see `installExplorerMapWindowResizeListener`). */
  map = L.map(el.mapContainer, { trackResize: false });

  const { lat, lng, zoom } = readInitialMapViewFromUrl();
  map.setView([lat, lng], zoom);
 
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  pinsLayer = L.layerGroup().addTo(map);
  ensureMapUserLocationLayer();
  map.on("moveend zoomend", () => {
    if (currentView !== "map" || !map) return;
    try {
      syncUrl();
    } catch (ex) {
      console.warn("ensureMap:moveend/zoomend:syncUrl", ex);
    }
    clearTimeout(mapMoveTimer);
    mapMoveTimer = setTimeout(() => {
      mapMoveTimer = null;
      if (currentView !== "map" || !map) return;
      void runMapSearch(false).catch((ex) => {
        console.warn("ensureMap:runMapSearch", ex);
        showError("map", "Could not refresh the map. Try again.");
      });
    }, 400);
  });
  installExplorerMapWindowResizeListener();
}

/** Remove saved map camera from the URL so the next fit is not skipped by `urlHasValidMapPosition`. */
function stripSavedMapViewFromUrl() {
  const u = new URL(window.location.href);
  const q = new URLSearchParams(u.search);
  if (!q.has("mlat") && !q.has("mlng") && !q.has("zoom")) return;
  q.delete("mlat");
  q.delete("mlng");
  q.delete("zoom");
  u.search = q.toString();
  history.replaceState(null, "", u);
  noteExplorerLocationHrefApplied();
}

/**
 * Call when the place / radius / geolocation filter changes: pan the map to match.
 * Skips refit during URL hydration so shared links keep `mlat`/`mlng`/`zoom`.
 *
 * When the Map tab is active, refit the map and reload pins/heatmap. From the Filters tab,
 * only `syncUrl()` runs — no iNaturalist API calls until the user opens Map (or Observations/Species).
 */
async function onLocationFilterChanged() {
  stripSavedMapViewFromUrl();

  if (currentView === "map" && window.L) {
    ensureMap();
    await new Promise((r) => requestAnimationFrame(r));
    if (map) {
      map.invalidateSize();
      await fitMapToFilterLocation();
      await runMapSearch(true);
    }
  }
  syncUrl();
}

async function fitMapToFilterLocation() {
  if (!map) return;
  const placeId = el.placeId.value.trim();
  const lat = el.lat.value.trim();
  const lng = el.lng.value.trim();

  if (placeId) {
    try {
      const res = await inatFetch(`places/${placeId}`);
      if (!res.ok) return;
      const data = await res.json();
      const place = data.results?.[0];
      const geo = place?.bounding_box_geojson || place?.geometry_geojson;
      if (geo) {
        const layer = L.geoJSON(geo);
        const b = layer.getBounds();
        if (b.isValid()) {
          map.fitBounds(b, { padding: [16, 16], maxZoom: 12 });
          return;
        }
      }
    } catch (ex) {
      explorerFatal(ex, "fitMapToFilterLocation:place geojson");
    }
  }

  if (lat && lng) {
    const la = parseFloat(lat);
    const ln = parseFloat(lng);
    if (Number.isNaN(la) || Number.isNaN(ln)) return;
    const rKm = effectiveRadiusKm();
    const latPad = rKm / 111;
    const cos = Math.cos((la * Math.PI) / 180);
    const lngPad = cos < 0.01 ? rKm / 111 : rKm / (111 * cos);
    map.fitBounds(
      [
        [la - latPad, ln - lngPad],
        [la + latPad, ln + lngPad],
      ],
      { padding: [16, 16], maxZoom: 12 }
    );
  }
}

function clearMapPins() {
  if (pinsLayer) pinsLayer.clearLayers();
}

function swapPinsLayer(newLayer) {
  if (!map || !newLayer) return;
  const oldLayer = pinsLayer;
  newLayer.addTo(map);
  pinsLayer = newLayer;
  if (oldLayer && map.hasLayer(oldLayer)) {
    map.removeLayer(oldLayer);
  }
}

function removeHeatLayer() {
  if (pendingHeatLayer && map) {
    if (map.hasLayer(pendingHeatLayer)) map.removeLayer(pendingHeatLayer);
    pendingHeatLayer = null;
  }
  if (heatGridLayer && map) {
    map.removeLayer(heatGridLayer);
    heatGridLayer = null;
  }
}

function clearMapOverlays() {
  clearMapPins();
  removeHeatLayer();
}

async function mapAreaParams() {
  try {
    if (!map) return null;
    const kc = await ensureKingCountyNoxiousData();
    const p = await commonParams({ establishmentMode: "list", kingCountyTaxonIdsCsv: joinKingCountyTaxonIdsCsv(kc) });
    p.delete("place_id");
    p.delete("lat");
    p.delete("lng");
    p.delete("radius");
    p.delete("geo");
    const b = map.getBounds();
    if (!b || typeof b.getNorth !== "function" || (typeof b.isValid === "function" && !b.isValid())) return null;
    p.set("nelat", String(b.getNorth()));
    p.set("nelng", String(b.getEast()));
    p.set("swlat", String(b.getSouth()));
    p.set("swlng", String(b.getWest()));
    p.set("geo", "true");
    applyUnreviewedByMeObservationParams(p);
    return p;
  } catch (ex) {
    /* Transient Leaflet / layout issues during pinch-zoom or resize must not replace the whole app. */
    console.warn("mapAreaParams", ex);
    return null;
  }
}

function installHeatGridLayer(url, onReady) {
  if (!map) {
    if (onReady) onReady();
    return;
  }
  if (url === currentHeatUrl && heatGridLayer && map.hasLayer(heatGridLayer)) {
    if (onReady) onReady();
    return;
  }
  currentHeatUrl = url;

  if (pendingHeatLayer && map) {
    if (map.hasLayer(pendingHeatLayer)) map.removeLayer(pendingHeatLayer);
    pendingHeatLayer = null;
  }

  const heatLayerOpts = {
    opacity: 0.5,
    maxZoom: 19,
    /* Stretch cell value range in the PNG so sparse vs dense reads more clearly (see .map-heat-tiles in CSS). */
    className: "map-heat-tiles",
  };

  const oldHeat = heatGridLayer;
  if (!oldHeat) {
    try {
      heatGridLayer = L.tileLayer(url, heatLayerOpts).addTo(map);
      heatGridLayer.once("load", () => {
        if (onReady) onReady();
      });
    } catch (ex) {
      console.warn("installHeatGridLayer:first tileLayer", ex);
      showError("map", "Could not load the density map layer. Try zooming slightly or refresh the Map tab.");
    }
    return;
  }

  let newHeat;
  try {
    newHeat = L.tileLayer(url, { ...heatLayerOpts, opacity: 0 }).addTo(map);
  } catch (ex) {
    console.warn("installHeatGridLayer:pending tileLayer", ex);
    showError("map", "Could not load the density map layer. Try again in a moment.");
    return;
  }
  pendingHeatLayer = newHeat;
  let swapped = false;
  const swap = () => {
    try {
      if (swapped || pendingHeatLayer !== newHeat || !map) return;
      swapped = true;
      pendingHeatLayer = null;
      newHeat.setOpacity(0.5);
      if (map.hasLayer(oldHeat)) map.removeLayer(oldHeat);
      heatGridLayer = newHeat;
      if (onReady) onReady();
    } catch (ex) {
      console.warn("installHeatGridLayer:swap", ex);
    }
  };
  newHeat.once("load", swap);
  setTimeout(swap, 4000);
}

async function mapFilterKey() {
  const kc = await ensureKingCountyNoxiousData();
  const p = await commonParams({ establishmentMode: "list", kingCountyTaxonIdsCsv: joinKingCountyTaxonIdsCsv(kc) });
  p.delete("place_id");
  p.delete("lat");
  p.delete("lng");
  p.delete("radius");
  p.delete("geo");
  p.set("_sort", el.sortMode.value);
  applyUnreviewedByMeObservationParams(p);
  p.set("_faved", el.filterFavedByMe && el.filterFavedByMe.checked ? "1" : "0");
  const est = formatEstablishmentForUrl();
  if (est) p.set("_est", est);
  else p.delete("_est");
  p.sort();
  return p.toString();
}

async function runMapSearch(forceRecheck) {
  ensureMap();
  if (!map || currentView !== "map") return;

  const prevMapMode = mapMode;

  const filterKey = await mapFilterKey();
  if (!map || currentView !== "map") return;
  const filtersChanged = filterKey !== lastMapFilterKey;
  lastMapFilterKey = filterKey;

  const seq = ++mapSearchSeq;
  showError("map", "");

  let spinnerShown = false;
  try {
    const area = await mapAreaParams();
    if (!area || seq !== mapSearchSeq || !map || currentView !== "map") return;
    const countParams = new URLSearchParams(area);
    countParams.set("per_page", "1");
    countParams.set("page", "1");
    const countRes = await inatObservationQueryFetchWithRetry(
      "observations",
      countParams,
      observationListAuthFetchOptions(),
    );
    if (seq !== mapSearchSeq || !map || currentView !== "map") return;
    if (!countRes.ok) throw new Error(`Request failed (${countRes.status})`);
    const countData = await countRes.json();
    if (seq !== mapSearchSeq || !map || currentView !== "map") return;
    const totalInArea = countData.total_results || 0;

    const pinEstablishmentFilter = establishmentClientFilterActive();
    const usePins =
      totalInArea < MAP_PIN_THRESHOLD || pinEstablishmentFilter || observationQueryUsesV2Post();
    const nextMapMode = usePins ? "pins" : "heat";
    const modeChanged = prevMapMode !== nextMapMode;

    if (forceRecheck || filtersChanged || modeChanged) {
      showMapSpinner();
      spinnerShown = true;
    }

    if (usePins) {
      removeHeatLayer();
      currentHeatUrl = null;
      mapMode = "pins";
      const pinsParams = new URLSearchParams(area);
      pinsParams.set("per_page", String(MAP_PIN_THRESHOLD));
      pinsParams.set("page", "1");
      const pinRes = await inatObservationQueryFetchWithRetry("observations", pinsParams, observationListAuthFetchOptions());
      if (seq !== mapSearchSeq || !map || currentView !== "map") return;
      if (!pinRes.ok) throw new Error(`Request failed (${pinRes.status})`);
      const pinData = await pinRes.json();
      if (seq !== mapSearchSeq || !map || currentView !== "map") return;
      let observations = pinData.results || [];
      if (pinEstablishmentFilter) {
        const kcPins = await ensureKingCountyNoxiousData();
        if (seq !== mapSearchSeq || !map || currentView !== "map") return;
        observations = observations.filter((o) => observationPassesEstablishmentCheckboxes(o, kcPins));
      }

      const pinR = mapPinMarkerRadius();
      const newPins = L.layerGroup();
      observations.forEach((obs) => {
        const g = obs.geojson;
        if (!g || g.type !== "Point" || !Array.isArray(g.coordinates)) return;
        const [lng, lat] = g.coordinates;
        const marker = L.circleMarker([lat, lng], {
          radius: pinR,
          color: "#1b4332",
          fillColor: "#40916c",
          fillOpacity: 0.75,
          weight: pinR > 6 ? 2 : 1,
        });
        const linkName =
          obs.taxon?.preferred_common_name || obs.taxon?.name || obs.species_guess || `Observation ${obs.id}`;
        marker.bindPopup(
          `<a href="https://www.inaturalist.org/observations/${obs.id}" rel="noopener noreferrer">${escapeHtml(linkName)}</a>`
        );
        /* Leaflet opens Path popups at the click point (edge of the circle), not the center — recentre on the pin. */
        marker.off("click");
        marker.on("click", function (e) {
          L.DomEvent.stopPropagation(e);
          this.openPopup(this.getLatLng());
        });
        marker.addTo(newPins);
      });
      if (seq !== mapSearchSeq || !map || currentView !== "map") return;
      swapPinsLayer(newPins);
      bringMapUserLocationToFront();
    } else {
      if (seq !== mapSearchSeq) return;
      mapMode = "heat";
      const kcHeat = await ensureKingCountyNoxiousData();
      if (seq !== mapSearchSeq || !map || currentView !== "map") return;
      const heatParams = await commonParams({ establishmentMode: "list", kingCountyTaxonIdsCsv: joinKingCountyTaxonIdsCsv(kcHeat) });
      relaxUnobservedParamsForObservationGridTiles(heatParams);
      /* Random `_cb` forced a new tile URL on every pan/zoom so the heat layer was torn down and rebuilt (felt like a refresh). */
      const bustHeatTiles = forceRecheck || filtersChanged || prevMapMode !== "heat";
      if (bustHeatTiles) {
        heatParams.set("_cb", `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`);
      }
      const url = `${API}/grid/{z}/{x}/{y}.png?${heatParams}`; /* density grid tiles (not colored_heatmap) */
      installHeatGridLayer(url, () => {
        if (!map || currentView !== "map") return;
        clearMapPins();
        bringMapUserLocationToFront();
      });
    }

    try {
      bringMapUserLocationToFront();
      syncUrl();
    } catch (ex) {
      console.warn("runMapSearch:bringMapUserLocationToFront/syncUrl", ex);
    }
  } catch (err) {
    console.warn("runMapSearch", err);
    const detail = err instanceof Error ? err.message.trim() : String(err);
    showError(
      "map",
      detail ? `Could not update the map (${detail}). You can try again or use Refresh.` : "Could not update the map. Try again or use Refresh.",
    );
  } finally {
    if (spinnerShown) hideMapSpinner();
  }
}

function setActiveTabUI() {
  el.tabs.forEach((tab) => {
    const on = tab.dataset.view === currentView;
    tab.setAttribute("aria-selected", on ? "true" : "false");
  });
  const filtersOn = currentView === "filters";
  const obsOn = currentView === "observations";
  const speciesOn = currentView === "species";
  const statsOn = currentView === "stats";
  const mapOn = currentView === "map";
  const detailOn = currentView === "detail";

  el.panelFilters.hidden = !filtersOn;
  el.panelObs.hidden = !obsOn;
  el.panelSpecies.hidden = !speciesOn;
  if (el.panelStats) el.panelStats.hidden = !statsOn;
  el.panelMap.hidden = !mapOn;
  el.panelDetail.hidden = !detailOn;

  el.panelFilters.classList.toggle("hidden", !filtersOn);
  el.panelObs.classList.toggle("hidden", !obsOn);
  el.panelSpecies.classList.toggle("hidden", !speciesOn);
  if (el.panelStats) el.panelStats.classList.toggle("hidden", !statsOn);
  el.panelMap.classList.toggle("hidden", !mapOn);
  el.panelDetail.classList.toggle("hidden", !detailOn);

  setSearchSummaryVisibility();
}

function setRefreshButtonsDisabled(disabled) {
  if (el.btnRefreshStats) el.btnRefreshStats.disabled = disabled;
  if (el.btnRefreshMap) el.btnRefreshMap.disabled = disabled;
  if (el.btnRefreshDetail) el.btnRefreshDetail.disabled = disabled;
}

async function refreshActiveView() {
  setRefreshButtonsDisabled(true);
  try {
    if (currentView === "observations") {
      await runObservationSearch(true);
    } else if (currentView === "species") {
      await runSpeciesSearch(true);
    } else if (currentView === "stats") {
      await runStatsSearch();
    } else if (currentView === "map") {
      lastMapFilterKey = null;
      await runMapSearch(true);
    } else if (currentView === "detail" && detailTaxonId) {
      await loadDetailFromTaxonId(detailTaxonId);
    }
  } finally {
    setRefreshButtonsDisabled(false);
  }
}

async function switchView(view) {
  const prevView = currentView;
  currentView = view;
  if (prevView === "map" && view !== "map") {
    destroyLeafletMap();
  }
  setActiveTabUI();
  syncUrl();

  if (view === "observations") {
    await runObservationSearch(true);
  } else if (view === "species") {
    await runSpeciesSearch(true);
  } else if (view === "stats") {
    await runStatsSearch();
  } else if (view === "map") {
    ensureMap();
    await new Promise((r) => requestAnimationFrame(r));
    map.invalidateSize();
    /* Do not fit to place/circle when restoring from URL — that overwrote mlat/mlng/zoom on refresh. */
    if (!urlHasValidMapPosition()) await fitMapToFilterLocation();
    await runMapSearch(true);
    startMapUserLocationWatch();
  } else if (view === "detail" && detailTaxonId) {
    await loadDetailFromTaxonId(detailTaxonId);
  }
}

function syncUrl() {
  const u = new URL(window.location.href);
  const q = new URLSearchParams(window.location.search);

  const inc = formatTaxonLabeledParam(taxonIncludeFilters);
  const exc = formatTaxonLabeledParam(taxonExcludeFilters);
  if (inc) q.set("taxon_inc", inc);
  else q.delete("taxon_inc");
  if (exc) q.set("taxon_exc", exc);
  else q.delete("taxon_exc");
  q.delete("taxon_id");

  const userLogin = el.userLogin.value.trim().toLowerCase();
  if (userLogin) q.set("observer", userLogin);
  else q.delete("observer");

  const placeId = el.placeId.value.trim();
  if (placeId) {
    q.set("place_id", placeId);
    q.delete("lat");
    q.delete("lng");
    q.delete("near_me");
    q.delete("radius");
  } else {
    q.delete("place_id");
    const hasCoords = el.lat.value.trim() && el.lng.value.trim();
    const r = String(effectiveRadiusKm());
    if (nearMeSource === "button" || nearMeSource === "url") {
      q.set("near_me", "1");
      q.set("radius", r);
      q.delete("lat");
      q.delete("lng");
    } else if (hasCoords) {
      q.set("lat", el.lat.value.trim());
      q.set("lng", el.lng.value.trim());
      q.set("radius", r);
      q.delete("near_me");
    } else {
      q.delete("lat");
      q.delete("lng");
      q.delete("near_me");
      q.delete("radius");
    }
  }

  const unobserved = el.unobservedInput.value.trim().toLowerCase();
  if (unobserved) q.set("unobserved", unobserved);
  else q.delete("unobserved");

  const cm = formatCardMetaQuery();
  if (cm === null) q.delete("cardmeta");
  else q.set("cardmeta", cm);

  if (el.handLayoutLeft && el.handLayoutLeft.checked) q.set("hand", "left");
  else q.delete("hand");

  q.delete("months");
  q.delete("evidence");

  if (el.qualityGrade.value) q.set("grade", el.qualityGrade.value);
  else q.delete("grade");
  if (el.sortMode.value !== "recent") q.set("sort", el.sortMode.value);
  else q.delete("sort");

  const mediaQ = mediaQueryFromCheckboxes();
  if (mediaQ === "photos") q.delete("media");
  else q.set("media", mediaQ);
  const ud = el.uploadedDays.value.trim();
  if (ud) q.set("days", ud);
  else q.delete("days");
  const od = el.observedDays && el.observedDays.value.trim();
  if (od) q.set("odays", od);
  else q.delete("odays");
  if (el.popularOnly.checked) q.set("popular", "1");
  else q.delete("popular");

  if (el.filterMyReview) {
    if (el.filterMyReview.value === "unreviewed" && inatAuthUser && inatAuthUser.id != null) {
      q.set("unreviewed", "1");
    } else {
      q.delete("unreviewed");
    }
  }

  if (el.filterFavedByMe) {
    if (el.filterFavedByMe.checked && inatAuthUser && inatAuthUser.id != null) {
      q.set("faved_me", "1");
    } else {
      q.delete("faved_me");
    }
  }

  const est = formatEstablishmentForUrl();
  if (est) q.set("est", est);
  else q.delete("est");
  q.delete("establish");
  q.delete("endemic");

  if (currentView != "filters") {
    q.set("view", currentView);
  } else {
    q.delete("view");
  }

  if (currentView === "detail" && detailTaxonId) {
    q.set("detail_taxon", String(detailTaxonId));
  } else {
    q.delete("detail_taxon");
  }

  if (
    map &&
    currentView === "map" &&
    el.mapContainer &&
    el.mapContainer.isConnected &&
    el.mapContainer.clientWidth > 0 &&
    el.mapContainer.clientHeight > 0
  ) {
    try {
      q.set("mlat", map.getCenter().lat);
      q.set("mlng", map.getCenter().lng);
      q.set("zoom", map.getZoom());
    } catch (ex) {
      console.warn("syncUrl:map camera", ex);
    }
  }

  u.search = q.toString();
  history.replaceState(null, "", u);
  noteExplorerLocationHrefApplied();
}

function readUrl() {
  const q = new URLSearchParams(window.location.search);
  const v = q.get("view");
  if (["filters", "observations", "species", "stats", "map", "detail"].includes(v)) currentView = v;

  const incRaw = q.get("taxon_inc");
  const excRaw = q.get("taxon_exc");
  const legacyTid = q.get("taxon_id");
  if (incRaw || excRaw) {
    taxonIncludeFilters = parseTaxonLabeledParam(incRaw || "");
    taxonExcludeFilters = parseTaxonLabeledParam(excRaw || "");
  } else if (legacyTid) {
    const legacyIds = parseTaxonCsvParam(legacyTid);
    taxonIncludeFilters = legacyIds.map((id) => ({ id, label: `Taxon ${id}` }));
    taxonExcludeFilters = [];
  } else {
    taxonIncludeFilters = [];
    taxonExcludeFilters = [];
  }
  renderTaxonSelectedStack();
  el.userLogin.value = (q.get("observer") || "").toLowerCase();

  const rFromQuery = q.get("radius") || "25";
  el.radiusKm.value = String(clampRadiusKm(rFromQuery));

  const pid = q.get("place_id");
  if (pid) el.placeId.value = pid;

  const nearMeFlag = q.get("near_me") === "1" || q.get("near_me") === "true";
  if (pid) {
    nearMeSource = "none";
    placeNearbyMode = false;
    el.lat.value = "";
    el.lng.value = "";
  } else if (nearMeFlag) {
    nearMeSource = "url";
    placeNearbyMode = true;
    el.lat.value = "";
    el.lng.value = "";
    setCommittedPlaceDisplay("Nearby");
  } else {
    nearMeSource = "none";
    el.lat.value = q.get("lat") || "";
    el.lng.value = q.get("lng") || "";
    placeNearbyMode = Boolean(el.lat.value.trim() && el.lng.value.trim());
  }
  updatePlaceNearbyUI();

  el.unobservedInput.value = (q.get("unobserved") || "").toLowerCase();
  applyCardMetaFromQuery(q);
  if (el.handLayoutLeft && el.handLayoutRight) {
    if ((q.get("hand") || "").toLowerCase() === "left") el.handLayoutLeft.checked = true;
    else el.handLayoutRight.checked = true;
  }
  syncExplorerHandLayoutClass();
  el.qualityGrade.value = q.get("grade") || "";
  {
    const s = q.get("sort") || "recent";
    const allowed = new Set(["recent", "oldest", "faves", "obs_recent", "obs_oldest"]);
    el.sortMode.value = allowed.has(s) ? s : "recent";
  }
  if (el.filterMyReview) {
    el.filterMyReview.value = q.get("unreviewed") === "1" ? "unreviewed" : "all";
  }
  if (el.filterFavedByMe) {
    el.filterFavedByMe.checked = q.get("faved_me") === "1";
  }
  applyMediaFromQuery(q);
  el.uploadedDays.value = q.get("days") || "";
  if (el.observedDays) el.observedDays.value = q.get("odays") || "";
  el.popularOnly.checked = q.get("popular") === "1";

  parseEstablishmentFromQuery(q);

  const dtid = q.get("detail_taxon");
  if (dtid) detailTaxonId = dtid;

  const pg = parseInt(q.get("page") || "1", 10);
  if (!Number.isNaN(pg) && pg > 1 && currentView === "species") {
    speciesPage = pg;
  }
}

async function hydrateSelections() {
  const pid = el.placeId.value.trim();
  if (pid) {
    const res = await inatFetch(`places/${pid}`);
    if (res.ok) {
      const data = await res.json();
      const place = data.results?.[0];
      const label = place?.display_name || place?.name || `Place ${pid}`;
      setPlaceSelection(pid, label, { fromHydrate: true });
    }
  } else if (placeNearbyMode && el.lat.value.trim() && el.lng.value.trim()) {
    setCommittedPlaceDisplay("Nearby");
    updatePlaceNearbyUI();
  }
}

async function setNearbySelection() {
  /**
   * Use `button` immediately so `syncUrl` keeps `near_me=1` in the address bar while geolocation is pending.
   * If `near_me` were omitted (treated like "no location filter"), a refresh mid-request would drop Nearby.
   */
  nearMeSource = "button";
  placeNearbyMode = true;
  el.placeId.value = "";
  el.lat.value = "";
  el.lng.value = "";
  setCommittedPlaceDisplay("Nearby");
  /* Defer closing the list so the originating click/mouseup sequence finishes (avoids desktop ghost clicks). */
  queueMicrotask(() => hideSuggestion("place"));
  updatePlaceNearbyUI();
  syncUrl();
  await requestNearbyGeolocation();
}

function setPlaceSelection(id, label, options = {}) {
  const fromHydrate = options.fromHydrate === true;
  clearNearbyGeolocationFailureMessage();
  nearMeSource = "none";
  placeNearbyMode = false;
  updatePlaceNearbyUI();
  el.placeId.value = String(id);
  setCommittedPlaceDisplay(label);
  el.lat.value = "";
  el.lng.value = "";
  if (!fromHydrate) queueMicrotask(() => hideSuggestion("place"));
  else hideSuggestion("place");
  if (fromHydrate) {
    syncUrl();
    return;
  }
  void onLocationFilterChanged();
}

function hideSuggestion(kind) {
  if (kind === "taxon") {
    if (!el.taxonSuggestions || !el.taxonInput) return;
    el.taxonSuggestions.hidden = true;
    el.taxonSuggestions.innerHTML = "";
    taxonHighlight = -1;
    el.taxonInput.setAttribute("aria-expanded", "false");
  } else if (kind === "place") {
    if (!el.placeSuggestions || !el.placeInput) return;
    el.placeSuggestions.hidden = true;
    el.placeSuggestions.innerHTML = "";
    placeHighlight = -1;
    el.placeInput.setAttribute("aria-expanded", "false");
  }
}

/** True if a UI event target is still inside the place / nearby filter (not only the text field). */
function placeFilterUiContainsTarget(node) {
  if (!(node instanceof Node)) return false;
  try {
    if (el.placeInputWrap && el.placeInputWrap.contains(node)) return true;
    if (el.placeSuggestions && el.placeSuggestions.contains(node)) return true;
    if (el.nearbyControls && el.nearbyControls.contains(node)) return true;
  } catch (ex) {
    explorerFatal(ex, "placeFilterUiContainsTarget");
  }
  return false;
}

function renderSuggestions(kind, items) {
  const list = kind === "taxon" ? el.taxonSuggestions : kind === "place" ? el.placeSuggestions : null;
  list.innerHTML = "";
  if (!items.length) {
    hideSuggestion(kind);
    return;
  }

  items.forEach((item) => {
    const li = document.createElement("li");
    li.setAttribute("role", "option");
    if (kind === "taxon") {
      li.className = "suggestions-taxon-row";
      const label = item.preferred_common_name || item.name;
      const text = document.createElement("div");
      text.className = "suggestions-taxon-text";
      text.innerHTML = `<span>${escapeHtml(label)}</span>${item.preferred_common_name ? `<div class="sci">${escapeHtml(item.name)}</div>` : ""}`;
      const actions = document.createElement("div");
      actions.className = "suggestions-taxon-actions";
      const btnPlus = document.createElement("button");
      btnPlus.type = "button";
      btnPlus.className = "suggestions-taxon-btn suggestions-taxon-btn--plus";
      btnPlus.setAttribute("aria-label", "Include this taxon");
      btnPlus.title = "Include (+)";
      btnPlus.textContent = "+";
      const btnMinus = document.createElement("button");
      btnMinus.type = "button";
      btnMinus.className = "suggestions-taxon-btn suggestions-taxon-btn--minus";
      btnMinus.setAttribute("aria-label", "Exclude this taxon");
      btnMinus.title = "Exclude (−)";
      btnMinus.textContent = "−";
      const add = (inc) => (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        appendTaxonFilter(inc, item.id, label);
      };
      btnPlus.addEventListener("mousedown", add(true));
      btnMinus.addEventListener("mousedown", add(false));
      actions.appendChild(btnPlus);
      actions.appendChild(btnMinus);
      li.appendChild(text);
      li.appendChild(actions);
    } else if (kind === "place") {
      if (item === NEARBY_SUGGESTION) {
        li.innerHTML = `<span>Nearby</span>`;
        li.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          void setNearbySelection();
        });
      } else {
        const label = item.display_name || item.name;
        li.innerHTML = `<span>${escapeHtml(label)}</span>`;
        li.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          setPlaceSelection(item.id, label);
        });
      }
    }
    list.appendChild(li);
  });

  list.hidden = false;
}

function wireAutocomplete() {
  el.taxonInput.addEventListener("input", () => {
    if (taxonDebounce) clearTimeout(taxonDebounce);
    const q = el.taxonInput.value.trim();
    if (q.length < 2) return hideSuggestion("taxon");
    taxonDebounce = setTimeout(async () => {
      try {
        const res = await inatFetch(`taxa/autocomplete?q=${encodeURIComponent(q)}&per_page=12`);
        const data = res.ok ? await res.json() : { results: [] };
        renderSuggestions("taxon", data.results || []);
      } catch (ex) {
        explorerFatal(ex, "wireAutocomplete:taxon");
      }
    }, 280);
  });

  const showPlaceSuggestionsForQuery = (q) => {
    if (placeDebounce) clearTimeout(placeDebounce);
    if (q.length < 2) {
      hideSuggestion("place");
      return;
    }
    placeDebounce = setTimeout(async () => {
      try {
        const results = await fetchPlacesForAutocomplete(q);
        renderSuggestions("place", [NEARBY_SUGGESTION, ...results]);
      } catch (ex) {
        explorerFatal(ex, "wireAutocomplete:place");
      }
    }, 280);
  };

  el.placeInput.addEventListener("input", () => {
    if (placeInputCommitted && el.placeInput.value !== placeInputCommitted) {
      el.placeId.value = "";
      el.lat.value = "";
      el.lng.value = "";
      nearMeSource = "none";
      placeNearbyMode = false;
      placeInputCommitted = "";
      updatePlaceNearbyUI();
      syncPlaceClearButton();
      void onLocationFilterChanged();
    }
    const q = el.placeInput.value.trim();
    showPlaceSuggestionsForQuery(q);
  });

  el.placeInput.addEventListener("focus", () => {
    if (placeInputCommitted && el.placeInput.value === placeInputCommitted) {
      hideSuggestion("place");
      return;
    }
    const q = el.placeInput.value.trim();
    if (q.length >= 2) showPlaceSuggestionsForQuery(q);
    else renderSuggestions("place", [NEARBY_SUGGESTION]);
  });

  document.addEventListener("click", (e) => {
    try {
      const t = e.target;
      if (!(t instanceof Node)) return;
      if (
        el.taxonInput &&
        el.taxonSuggestions &&
        !el.taxonInput.contains(t) &&
        !el.taxonSuggestions.contains(t)
      ) {
        hideSuggestion("taxon");
      }
      if (!placeFilterUiContainsTarget(t)) hideSuggestion("place");
    } catch (ex) {
      explorerFatal(ex, "wireAutocomplete:document click");
    }
  });

  el.taxonInput.addEventListener("keydown", (e) => {
    const items = el.taxonSuggestions.querySelectorAll("li");
    if (!items.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      taxonHighlight = Math.min(taxonHighlight + 1, items.length - 1);
      items[taxonHighlight].scrollIntoView({ block: "nearest" });
      items.forEach((li, i) => li.setAttribute("aria-selected", i === taxonHighlight ? "true" : "false"));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      taxonHighlight = Math.max(taxonHighlight - 1, 0);
      items[taxonHighlight].scrollIntoView({ block: "nearest" });
      items.forEach((li, i) => li.setAttribute("aria-selected", i === taxonHighlight ? "true" : "false"));
    } else if (e.key === "Enter" && taxonHighlight >= 0) {
      e.preventDefault();
      const plus = items[taxonHighlight].querySelector(".suggestions-taxon-btn--plus");
      if (plus) plus.dispatchEvent(new MouseEvent("mousedown"));
    } else if (e.key === "Escape") {
      hideSuggestion("taxon");
    }
  });

  el.placeInput.addEventListener("keydown", (e) => {
    const items = el.placeSuggestions.querySelectorAll("li");
    if (!items.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      placeHighlight = Math.min(placeHighlight + 1, items.length - 1);
      items[placeHighlight].scrollIntoView({ block: "nearest" });
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      placeHighlight = Math.max(placeHighlight - 1, 0);
      items[placeHighlight].scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter" && placeHighlight >= 0) {
      e.preventDefault();
      items[placeHighlight].dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    } else if (e.key === "Escape") {
      hideSuggestion("place");
    }
  });
}

function applyGeoPosition(pos) {
  clearNearbyGeolocationFailureMessage();
  placeNearbyMode = true;
  el.placeId.value = "";
  setCommittedPlaceDisplay("Nearby");
  updatePlaceNearbyUI();
  el.lat.value = String(pos.coords.latitude);
  el.lng.value = String(pos.coords.longitude);
}

function requestGeolocationPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Geolocation is not available in this browser."));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: false,
      timeout: 12000,
      maximumAge: 600000,
    });
  });
}

async function requestNearbyGeolocation() {
  try {
    const pos = await requestGeolocationPosition();
    applyGeoPosition(pos);
    nearMeSource = "button";
    await onLocationFilterChanged();
  } catch (err) {
    const msg = formatGeolocationFailureMessage(err);
    showNearbyGeolocationFailureMessage(msg);
    nearMeSource = "none";
    placeNearbyMode = false;
    el.lat.value = "";
    el.lng.value = "";
    setCommittedPlaceDisplay("");
    updatePlaceNearbyUI();
    syncUrl();
  }
}

async function resolveNearMeFromUrl() {
  try {
    const pos = await requestGeolocationPosition();
    applyGeoPosition(pos);
    nearMeSource = "url";
    stripSavedMapViewFromUrl();
    syncUrl();
  } catch (err) {
    const msg = formatGeolocationFailureMessage(err);
    showNearbyGeolocationFailureMessage(msg);
    nearMeSource = "none";
    placeNearbyMode = false;
    el.lat.value = "";
    el.lng.value = "";
    setCommittedPlaceDisplay("");
    updatePlaceNearbyUI();
    syncUrl();
  }
}

/**
 * When the URL has `near_me=1` without coordinates (`nearMeSource === "url"`), wait for geolocation
 * before the first Observations/Species/Stats/Map fetch so we do not issue a no-geo request and
 * then a second narrowed request.
 * @param {string} contextLabel — error context only (e.g. "boot", "bfcache")
 */
async function resolvePendingNearMeUrlIfNeeded(contextLabel) {
  if (nearMeSource !== "url") return;
  const geoCapMs = 15000;
  try {
    await Promise.race([
      resolveNearMeFromUrl(),
      new Promise((_, rej) =>
        setTimeout(() => rej(Object.assign(new Error("near_me_geo_cap"), { code: "NEAR_ME_GEO_CAP" })), geoCapMs)
      ),
    ]);
  } catch (e) {
    if (
      e &&
      e.code === "NEAR_ME_GEO_CAP" &&
      nearMeSource === "url" &&
      (!el.lat.value.trim() || !el.lng.value.trim())
    ) {
      showNearbyGeolocationFailureMessage(
        "Nearby in the link needs your current position, but the browser did not return a location in time. Allow location for this site, try again, or pick a named place.",
      );
      nearMeSource = "none";
      placeNearbyMode = false;
      el.lat.value = "";
      el.lng.value = "";
      setCommittedPlaceDisplay("");
      updatePlaceNearbyUI();
      syncUrl();
    } else {
      explorerFatal(e, `resolvePendingNearMeUrlIfNeeded:${contextLabel}`);
    }
  }
}

function wirePlaceField() {
  if (el.btnClearPlace) {
    el.btnClearPlace.addEventListener("click", () => {
      clearPlaceFilter();
    });
  }
}

function wireTabs() {
  el.tabs.forEach((tab) => {
    tab.addEventListener("click", async () => {
      const view = tab.dataset.view;
      if (!view || view === currentView) return;
      await switchView(view);
    });
  });
}

/**
 * Delegated clicks for observation-card Agree, Mark reviewed, and Favorite (authenticated iNat API writes).
 * Also suppresses pointer-driven focus on stacked card controls: the observations panel scrolls (`overflow-y: auto`),
 * and focusing a button from a mouse/touch press triggers the UA “scroll focused element into view” step, which
 * jumps the panel. Keyboard users still reach these controls via Tab (focus moves without pointerdown default).
 */
function wireObservationAgreeClicks() {
  if (!el.resultsGrid) return;
  const pointerFocusScrollSuppressionSelector =
    "button.card-fave, button.card-mark-reviewed, button.card-agree, button.card-media-carousel__dot-slot";
  el.resultsGrid.addEventListener(
    "pointerdown",
    (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      const target = e.target;
      if (!(target instanceof Element)) return;
      const hit = target.closest(pointerFocusScrollSuppressionSelector);
      if (!hit || !el.resultsGrid.contains(hit)) return;
      e.preventDefault();
    },
    { passive: false }
  );
  el.resultsGrid.addEventListener("click", (e) => {
    const faveRaw = e.target && e.target.closest && e.target.closest("button.card-fave");
    const faveBtn = faveRaw instanceof HTMLButtonElement ? faveRaw : null;
    if (faveBtn && !faveBtn.disabled) {
      e.preventDefault();
      e.stopPropagation();
      const fid = faveBtn.getAttribute("data-fave-obs-id");
      if (!fid) return;
      const iconEl = faveBtn.querySelector("i.fa");
      const currentlyFaved = Boolean(
        iconEl && iconEl.classList.contains("fa-star") && !iconEl.classList.contains("fa-star-o"),
      );
      void submitObservationFavoriteToggle(faveBtn, fid, currentlyFaved);
      return;
    }

    const reviewRaw = e.target && e.target.closest && e.target.closest("button.card-mark-reviewed");
    const reviewBtn = reviewRaw instanceof HTMLButtonElement ? reviewRaw : null;
    if (reviewBtn && !reviewBtn.disabled) {
      e.preventDefault();
      e.stopPropagation();
      const rid = reviewBtn.getAttribute("data-review-obs-id");
      if (!rid) return;
      void submitObservationMarkReviewed(reviewBtn, rid);
      return;
    }

    const raw = e.target && e.target.closest && e.target.closest("button.card-agree");
    const btn = raw instanceof HTMLButtonElement ? raw : null;
    if (!btn || btn.disabled) return;
    e.preventDefault();
    e.stopPropagation();
    const obsId = btn.getAttribute("data-agree-obs-id");
    const taxonId = btn.getAttribute("data-agree-taxon-id");
    if (!obsId || !taxonId) return;
    void submitObservationAgree(btn, obsId, taxonId);
  });
}

/** Bottom-of-Filters Log in / Log out and panel open/close. */
function wireExplorerAuthDock() {
  if (!el.btnExplorerAuthToggle) return;
  el.btnExplorerAuthToggle.addEventListener("click", () => {
    if (explorerIsSignedIn()) {
      clearStoredInatApiJwt();
      if (el.inatApiToken) el.inatApiToken.value = "";
      if (el.filterMyReview) el.filterMyReview.value = "all";
      if (el.filterFavedByMe) el.filterFavedByMe.checked = false;
      closeExplorerAuthPanel();
      void (async () => {
        await refreshInatAuthUser();
        syncUrl();
        refreshResultPanelsIfMetaChanged();
      })();
      return;
    }
    if (explorerAuthPanelIsOpen()) {
      closeExplorerAuthPanel();
      return;
    }
    void openExplorerAuthPanel({});
  });
  if (el.btnExplorerAuthPanelClose) {
    el.btnExplorerAuthPanelClose.addEventListener("click", () => closeExplorerAuthPanel());
  }
}

/** Filters tab: store JWT, verify with `GET /users/me`, refresh observation cards when auth changes. */
function wireExplorerApiAuth() {
  if (el.btnInatApiTokenApply && el.inatApiToken) {
    el.btnInatApiTokenApply.addEventListener("click", () => {
      const pasted = el.inatApiToken.value;
      const parsed = parseInatApiTokenPaste(pasted);
      if (parsed.error) {
        renderInatApiAuthStatusEl(parsed.error, "error");
        return;
      }
      const saved = persistParsedInatApiJwt(parsed.token);
      if (!saved.ok) {
        renderInatApiAuthStatusEl(saved.error || "Could not save token.", "error");
        return;
      }
      el.inatApiToken.value = "";
      void (async () => {
        await refreshInatAuthUser();
        refreshResultPanelsIfMetaChanged();
      })();
    });
  }
  if (el.btnInatApiTokenClear) {
    el.btnInatApiTokenClear.addEventListener("click", () => {
      clearStoredInatApiJwt();
      if (el.inatApiToken) el.inatApiToken.value = "";
      if (el.filterMyReview) el.filterMyReview.value = "all";
      if (el.filterFavedByMe) el.filterFavedByMe.checked = false;
      void (async () => {
        await refreshInatAuthUser();
        syncUrl();
        refreshResultPanelsIfMetaChanged();
      })();
    });
  }
}

function wireInfiniteScroll() {
  const opts = { rootMargin: "120px" };
  let obsMoreTimer = 0;
  let speciesMoreTimer = 0;

  const sentinelStillVisible = (rootEl, sentinelEl) => {
    if (!sentinelEl) return false;
    const sr = sentinelEl.getBoundingClientRect();
    if (rootEl) {
      const rr = rootEl.getBoundingClientRect();
      return sr.top < rr.bottom && sr.bottom > rr.top;
    }
    return sr.top < window.innerHeight && sr.bottom > 0;
  };

  const obsObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      if (!(currentView === "observations" && obsHasMore && !obsLoading)) continue;
      if (obsMoreTimer) clearTimeout(obsMoreTimer);
      obsMoreTimer = window.setTimeout(() => {
        obsMoreTimer = 0;
        if (!(currentView === "observations" && obsHasMore && !obsLoading)) return;
        if (!sentinelStillVisible(el.panelObs, el.obsSentinel)) return;
        void runObservationSearch(false);
      }, 160);
    }
  }, el.panelObs ? { ...opts, root: el.panelObs } : opts);
  const speciesObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      if (!(currentView === "species" && speciesHasMore && !speciesLoading)) continue;
      if (speciesMoreTimer) clearTimeout(speciesMoreTimer);
      speciesMoreTimer = window.setTimeout(() => {
        speciesMoreTimer = 0;
        if (!(currentView === "species" && speciesHasMore && !speciesLoading)) return;
        if (!sentinelStillVisible(el.panelSpecies, el.speciesSentinel)) return;
        void runSpeciesSearch(false);
      }, 160);
    }
  }, el.panelSpecies ? { ...opts, root: el.panelSpecies } : opts);

  obsObserver.observe(el.obsSentinel);
  speciesObserver.observe(el.speciesSentinel);
}

/** Update the URL from filter controls without calling the iNaturalist search APIs (those run when opening Observations / Species / Map). */
function scheduleUrlSync() {
  if (urlSyncDebounce != null) clearTimeout(urlSyncDebounce);
  urlSyncDebounce = setTimeout(() => {
    urlSyncDebounce = null;
    syncUrl();
  }, 120);
}

function refreshResultPanelsIfMetaChanged() {
  if (currentView === "observations") void runObservationSearch(true);
  else if (currentView === "species") void runSpeciesSearch(true);
  else if (currentView === "stats") void runStatsSearch();
  else if (currentView === "map") {
    lastMapFilterKey = null;
    void runMapSearch(true);
  } else scheduleUrlSync();
}

function wireFilterExtras() {
  const onChange = () => {
    scheduleUrlSync();
  };
  el.mediaPhotos.addEventListener("change", onChange);
  el.mediaSounds.addEventListener("change", onChange);
  el.uploadedDays.addEventListener("change", onChange);
  if (el.observedDays) {
    el.observedDays.addEventListener("change", () => {
      lastMapFilterKey = null;
      onChange();
      queueMicrotask(() => refreshResultPanelsIfMetaChanged());
    });
  }
  el.popularOnly.addEventListener("change", onChange);
  el.radiusKm.addEventListener("input", () => {
    void onLocationFilterChanged();
    scheduleUrlSync();
  });
  el.radiusKm.addEventListener("blur", () => {
    const t = el.radiusKm.value.trim();
    if (t === "") el.radiusKm.value = "25";
    else el.radiusKm.value = String(clampRadiusKm(t));
    void onLocationFilterChanged();
    syncUrl();
  });
  el.qualityGrade.addEventListener("change", onChange);
  el.sortMode.addEventListener("change", () => {
    onChange();
    lastMapFilterKey = null;
    queueMicrotask(() => refreshResultPanelsIfMetaChanged());
  });

  if (el.filterMyReview) {
    el.filterMyReview.addEventListener("change", () => {
      if (el.filterMyReview.value === "unreviewed" && (!inatAuthUser || !inatApiJwtAuthorizationValue())) {
        el.filterMyReview.value = "all";
        void openExplorerAuthPanel({
          reason: "Sign in with an API token to use the “Unreviewed by me” filter.",
        });
        return;
      }
      lastMapFilterKey = null;
      scheduleUrlSync();
      queueMicrotask(() => refreshResultPanelsIfMetaChanged());
    });
  }

  if (el.filterFavedByMe) {
    el.filterFavedByMe.addEventListener("change", () => {
      if (el.filterFavedByMe.checked && (!inatAuthUser || !inatApiJwtAuthorizationValue())) {
        el.filterFavedByMe.checked = false;
        void openExplorerAuthPanel({
          reason: "Sign in with an API token to use the “Favorited by me” filter.",
        });
        return;
      }
      lastMapFilterKey = null;
      scheduleUrlSync();
      queueMicrotask(() => refreshResultPanelsIfMetaChanged());
    });
  }

  if (el.handLayoutLeft && el.handLayoutRight) {
    const onHandLayout = () => {
      syncExplorerHandLayoutClass();
      scheduleUrlSync();
    };
    el.handLayoutLeft.addEventListener("change", onHandLayout);
    el.handLayoutRight.addEventListener("change", onHandLayout);
  }

  const lowerLogin = (e) => {
    e.target.value = e.target.value.toLowerCase();
  };
  const onLoginInput = (e) => {
    lowerLogin(e);
    scheduleUrlSync();
  };
  el.userLogin.addEventListener("input", onLoginInput);
  el.unobservedInput.addEventListener("input", onLoginInput);

  const onMeta = () => {
    queueMicrotask(() => refreshResultPanelsIfMetaChanged());
  };
  el.metaFaves.addEventListener("change", onMeta);
  el.metaSpeciesCount.addEventListener("change", onMeta);
  el.metaLocation.addEventListener("change", onMeta);
  el.metaNativeStatus.addEventListener("change", onMeta);
  if (el.metaConservationStatus) el.metaConservationStatus.addEventListener("change", onMeta);
  el.metaGrade.addEventListener("change", onMeta);
  if (el.metaObsDate) el.metaObsDate.addEventListener("change", onMeta);
  if (el.metaPhotoPage) el.metaPhotoPage.addEventListener("change", onMeta);
  el.metaSciName.addEventListener("change", onMeta);
  if (el.metaObserver) el.metaObserver.addEventListener("change", onMeta);
  if (el.metaFavoriteControl) el.metaFavoriteControl.addEventListener("change", onMeta);
  if (el.metaIdentifyControls) {
    el.metaIdentifyControls.addEventListener("change", () => {
      if (el.metaIdentifyControls.checked && !explorerIsSignedIn()) {
        el.metaIdentifyControls.checked = false;
        queueMicrotask(() => refreshResultPanelsIfMetaChanged());
        void openExplorerAuthPanel({
          reason:
            "Sign in with an API token to use “Agree & Mark reviewed” on observation cards.",
        });
        return;
      }
      queueMicrotask(() => refreshResultPanelsIfMetaChanged());
    });
  }

  const onEstablishmentChange = () => {
    lastMapFilterKey = null;
    scheduleUrlSync();
    queueMicrotask(() => refreshResultPanelsIfMetaChanged());
  };
  if (el.filterEstEndemic) el.filterEstEndemic.addEventListener("change", onEstablishmentChange);
  if (el.filterEstNative) el.filterEstNative.addEventListener("change", onEstablishmentChange);
  if (el.filterEstIntroduced) el.filterEstIntroduced.addEventListener("change", onEstablishmentChange);
  if (el.filterEstInvasive) el.filterEstInvasive.addEventListener("change", onEstablishmentChange);
}

function wireButtons() {
  if (el.searchForm) {
    el.searchForm.addEventListener("submit", (e) => {
      e.preventDefault();
    });
  }
  el.btnReset.addEventListener("click", () => {
    el.taxonInput.value = "";
    taxonIncludeFilters = [];
    taxonExcludeFilters = [];
    renderTaxonSelectedStack();
    el.placeId.value = "";
    el.lat.value = "";
    el.lng.value = "";
    el.radiusKm.value = "25";
    placeNearbyMode = false;
    nearMeSource = "none";
    placeInputCommitted = "";
    setCommittedPlaceDisplay("");
    updatePlaceNearbyUI();
    el.userLogin.value = "";
    el.unobservedInput.value = "";
    el.qualityGrade.value = "";
    el.sortMode.value = "recent";
    if (el.filterMyReview) el.filterMyReview.value = "all";
    if (el.filterFavedByMe) el.filterFavedByMe.checked = false;
    el.mediaPhotos.checked = true;
    el.mediaSounds.checked = false;
    el.uploadedDays.value = "";
    if (el.observedDays) el.observedDays.value = "";
    el.popularOnly.checked = false;
    if (el.metaIdentifyControls) el.metaIdentifyControls.checked = false;
    if (el.metaFavoriteControl) el.metaFavoriteControl.checked = true;
    el.metaFaves.checked = true;
    el.metaSpeciesCount.checked = true;
    if (el.metaObserver) el.metaObserver.checked = false;
    el.metaLocation.checked = false;
    el.metaNativeStatus.checked = false;
    if (el.metaConservationStatus) el.metaConservationStatus.checked = false;
    el.metaGrade.checked = false;
    if (el.metaObsDate) el.metaObsDate.checked = false;
    if (el.metaPhotoPage) el.metaPhotoPage.checked = false;
    el.metaSciName.checked = false;
    if (el.handLayoutRight) el.handLayoutRight.checked = true;
    if (el.handLayoutLeft) el.handLayoutLeft.checked = false;
    syncExplorerHandLayoutClass();
    setEstablishmentCheckboxes({ endemic: true, native: true, introduced: true, invasive: true });
    el.resultsGrid.innerHTML = "";
    el.speciesGrid.innerHTML = "";
    obsCardCount = 0;
    speciesCardCount = 0;
    obsListCursorId = null;
    obsListCursorAscId = null;
    obsSeenIds.clear();
    destroyLeafletMap();
    lastMapFilterKey = null;
    clearErrors();
    speciesPage = 1;
    obsHasMore = false;
    speciesHasMore = false;
    currentView = "filters";
    setActiveTabUI();
    history.replaceState(null, "", window.location.pathname);
    noteExplorerLocationHrefApplied();
  });
}

/* ── Species detail view ── */

const HOUR_LABELS = Array.from({ length: 24 }, (_, i) => {
  if (i === 0) return "12a";
  if (i < 12) return `${i}a`;
  if (i === 12) return "12p";
  return `${i - 12}p`;
});

/** Sample recent observations (parallel page fetches) and tally local hour-of-day for the bar chart. */
async function sampleHourOfDayFromObservations(baseParams, maxSamples = 150, maxPages = 2) {
  const hourCounts = Array.from({ length: 24 }, () => 0);
  let sampled = 0;
  const pagePromises = [];
  for (let page = 1; page <= maxPages; page++) {
    const hp = new URLSearchParams(baseParams);
    hp.set("per_page", "200");
    hp.set("page", String(page));
    hp.set("order_by", "created_at");
    hp.set("order", "desc");
    pagePromises.push(
      (async () => {
        const r = await inatObservationQueryFetchWithRetry("observations", hp, observationListAuthFetchOptions());
        return {
          page,
          ok: r.ok,
          json: r.ok ? await r.json() : null,
        };
      })(),
    );
  }
  const pages = await Promise.all(pagePromises);
  pages.sort((a, b) => a.page - b.page);
  outer: for (const { ok, json } of pages) {
    if (!ok || !json) break;
    const results = json.results || [];
    if (!results.length) break;
    for (const obs of results) {
      if (sampled >= maxSamples) break outer;
      let hour = obs.observed_on_details?.hour;
      if (hour == null || hour === "") {
        const t = obs.time_observed_at;
        if (!t) continue;
        const m = String(t).match(/T(\d{2}):/);
        if (!m) continue;
        hour = parseInt(m[1], 10);
      } else {
        hour = Number(hour);
      }
      if (!Number.isInteger(hour) || hour < 0 || hour > 23) continue;
      hourCounts[hour] += 1;
      sampled++;
    }
  }
  return { hourCounts, sampled };
}

function formatCount(n) {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K`;
  return String(n);
}

function renderBarChart(data, labels, opts = {}) {
  const max = Math.max(...data, 1);
  const labelStep = opts.labelStep || 1;
  const chart = document.createElement("div");
  chart.className = "bar-chart";
  if (data.length > 16) chart.classList.add("bar-chart--dense");
  if (opts.extraChartClass) chart.classList.add(opts.extraChartClass);
  data.forEach((val, i) => {
    const col = document.createElement("div");
    col.className = "bar-col";
    col.title = `${labels[i]}: ${val.toLocaleString()}`;
    const count = document.createElement("span");
    count.className = "bar-count";
    count.textContent = val > 0 ? formatCount(val) : "";
    const fill = document.createElement("div");
    fill.className = "bar-fill";
    fill.style.height = `${(val / max) * 100}%`;
    const label = document.createElement("span");
    label.className = "bar-label";
    label.textContent = (i % labelStep === 0) ? labels[i] : "";
    col.appendChild(count);
    col.appendChild(fill);
    col.appendChild(label);
    chart.appendChild(col);
  });
  return chart;
}

function buildSearchUrlWithSpecies(taxonId, label) {
  const u = new URL(window.location.href);
  const q = new URLSearchParams(u.search);
  q.delete("taxon_id");
  q.delete("taxon_inc");
  q.delete("taxon_exc");
  const tid = Number(taxonId);
  const lab = typeof label === "string" && label.trim() ? label.trim() : `Taxon ${tid}`;
  if (Number.isFinite(tid) && tid > 0) {
    q.set("taxon_inc", `${tid}|${encodeURIComponent(lab)}`);
  }
  q.set("view", "observations");
  q.delete("mlat");
  q.delete("mlng");
  q.delete("zoom");
  u.search = q.toString();
  return u.toString();
}

async function loadDetailFromTaxonId(taxonId) {
  el.detailContent.innerHTML = `<p class="detail-loading">Loading species…</p>`;
  try {
    const res = await inatFetch(`taxa/${taxonId}`);
    if (!res.ok) throw new Error(`Request failed (${res.status})`);
    const data = await res.json();
    const taxon = data.results?.[0];
    if (!taxon) throw new Error("Species not found.");
    await showSpeciesDetail(taxon, null);
  } catch (err) {
    explorerFatal(err, "loadDetailFromTaxonId");
  }
}

async function showSpeciesDetail(taxon, obsCount) {
  detailTaxonId = taxon.id;
  currentView = "detail";
  setActiveTabUI();
  syncUrl();

  const name = taxon.preferred_common_name || taxon.name || "Unknown";
  const sciName = taxon.name || "";
  const rawHero = taxon.default_photo?.url || taxon.default_photo?.medium_url || "";
  const heroMedium = observationCardPhotoDisplayUrl(rawHero);
  const heroLarge = largePhotoUrl(heroMedium);
  const heroSrcset =
    heroMedium && heroLarge && heroLarge !== heroMedium ? ` srcset="${escapeHtml(heroLarge)} 2x"` : "";
  const heroImg = heroMedium
    ? wrapExplorerImagePinchShell(
        `<img class="detail-hero-photo card-photo" src="${escapeHtml(heroMedium)}"${heroSrcset} alt="${escapeHtml(name)}" loading="lazy" decoding="async" />`,
      )
    : "";
  const inatAppUrl = inaturalistTaxonWebUrl(taxon.id);
  const searchUrl = buildSearchUrlWithSpecies(taxon.id, taxon.preferred_common_name || taxon.name);

  el.detailContent.innerHTML = `
    <div class="detail-hero">
      ${heroImg}
      <div class="detail-hero-info">
        <h2>${escapeHtml(name)}</h2>
        ${sciName && sciName !== name ? `<p class="sci-name">${escapeHtml(sciName)}</p>` : ""}
        <div class="detail-links">
          <a href="${escapeHtml(inatAppUrl)}" target="_blank" rel="noopener noreferrer">View on iNaturalist &rarr;</a>
          <a href="${escapeHtml(searchUrl)}">Search observations of this species &rarr;</a>
        </div>
      </div>
    </div>
    <div class="detail-charts">
      <div class="detail-section" id="detail-month-section">
        <h3>Observations by month</h3>
        <p class="detail-loading">Loading…</p>
      </div>
      <div class="detail-section detail-section--hour" id="detail-hour-section">
        <h3>Observations by hour of day</h3>
        <p class="detail-loading">Loading…</p>
      </div>
    </div>
  `;

  const kcDetail = await ensureKingCountyNoxiousData();
  const hourSampleParams = await commonParams({ establishmentMode: "list", kingCountyTaxonIdsCsv: joinKingCountyTaxonIdsCsv(kcDetail) });
  hourSampleParams.set("taxon_id", String(taxon.id));

  const monthSection = document.getElementById("detail-month-section");
  const hourSection = document.getElementById("detail-hour-section");

  try {
    const monthParams = await monthOfYearHistogramParams(taxon.id);
    const monthRes = await inatObservationQueryFetchWithRetry(
      "observations/histogram",
      monthParams,
      observationListAuthFetchOptions(),
    );
    if (monthRes.ok) {
      const monthData = await monthRes.json();
      const moy = monthData.results?.month_of_year || {};
      const monthCounts = Array.from({ length: 12 }, (_, i) => moy[i + 1] || 0);
      monthSection.innerHTML = `<h3>Observations by month</h3>`;
      monthSection.appendChild(renderBarChart(monthCounts, MONTH_NAMES));
    } else {
      monthSection.querySelector(".detail-loading").textContent = "Could not load data.";
    }
  } catch (ex) {
    explorerFatal(ex, "showSpeciesDetail:month histogram");
  }

  try {
    const { hourCounts, sampled } = await sampleHourOfDayFromObservations(hourSampleParams);
    if (sampled > 0) {
      hourSection.innerHTML = `<h3>Observations by hour of day</h3><p class="detail-hour-note">Based on ${sampled} recent observations with time data</p>`;
      hourSection.appendChild(renderBarChart(hourCounts, HOUR_LABELS, { labelStep: 2, extraChartClass: "bar-chart--hour" }));
    } else {
      hourSection.innerHTML = `<h3>Observations by hour of day</h3><p style="font-size:0.85rem;color:var(--muted)">No time-of-day data available.</p>`;
    }
  } catch (ex) {
    explorerFatal(ex, "showSpeciesDetail:hour chart");
  }
}

async function boot() {
  installExplorerImagePinchZoom(document.querySelector("main") || document.body);
  readUrl();
  const pendingNearMeUrl = nearMeSource === "url";
  if (pendingNearMeUrl) {
    setActiveTabUI();
  }
  await hydrateSelections();
  wireAutocomplete();
  wirePlaceField();
  wireTabs();
  wireInfiniteScroll();
  wireObservationAgreeClicks();
  wireFilterExtras();
  wireExplorerAuthDock();
  wireExplorerApiAuth();
  wireButtons();
  if (el.btnRefreshMap) {
    el.btnRefreshMap.addEventListener("click", () => {
      void refreshActiveView();
    });
  }
  if (el.btnRefreshStats) {
    el.btnRefreshStats.addEventListener("click", () => {
      void refreshActiveView();
    });
  }
  if (el.btnRefreshDetail) {
    el.btnRefreshDetail.addEventListener("click", () => {
      void refreshActiveView();
    });
  }

  await resolvePendingNearMeUrlIfNeeded("boot");
  await refreshInatAuthUser();
  await switchView(currentView);
}

/**
 * When the browser restores this page from the back-forward cache (mobile Safari / WebView),
 * JavaScript state and the DOM can still reflect the *previous* visit while `location` already
 * matches the new shared link. Re-read the URL and reload the active view so the UI matches the address bar.
 *
 * On many mobile browsers, `pageshow` with `persisted` also fires after an app switch even when the
 * URL never changed; comparing a stable routing key (sorted query keys) to `lastExplorerPathSearch`
 * avoids a redundant full resync that would clear the observations grid. A second check compares
 * against the stable form of `lastExplorerLocationHref` for engines that tweak `pathname+search`
 * serialization without changing the logical query.
 */
async function resyncAppFromCurrentUrlAfterBfcache() {
  readUrl();
  const pendingNearMeUrl = nearMeSource === "url";
  if (pendingNearMeUrl) {
    setActiveTabUI();
  }
  await hydrateSelections();
  lastMapFilterKey = null;
  await resolvePendingNearMeUrlIfNeeded("bfcache");
  await switchView(currentView);
}

window.addEventListener("pageshow", (e) => {
  if (!e.persisted) return;
  const stable = explorerStableRoutingKeyFromHref(window.location.href);
  if (stable === lastExplorerPathSearch) {
    noteExplorerLocationHrefApplied();
    return;
  }
  if (stable === explorerStableRoutingKeyFromHref(lastExplorerLocationHref)) {
    noteExplorerLocationHrefApplied();
    return;
  }
  void resyncAppFromCurrentUrlAfterBfcache().catch((ex) => {
    console.error("resyncAppFromCurrentUrlAfterBfcache", ex);
  });
});

/** Resolved when initial `readUrl` + wiring + first `switchView` complete; used by Playwright e2e. */
window.__EXPLORER_BOOT__ = boot().catch((ex) => explorerFatal(ex, "boot"));
