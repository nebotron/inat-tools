const API = "https://api.inaturalist.org/v1";
const OBS_PER_PAGE = 60;

/** Opens the taxon in the iNaturalist mobile app when installed (falls back to website on desktop). */
function inaturalistTaxonAppUrl(taxonId) {
  const id = taxonId != null ? String(taxonId).trim() : "";
  if (!id) return "https://www.inaturalist.org/";
  return `inaturalist://taxa/${id}`;
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
  } catch {
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
  } catch {
    /* ignore */
  }
  return 4;
}

let currentView = "filters";
let obsPage = 1;
let speciesPage = 1;
let obsHasMore = false;
let speciesHasMore = false;
let obsLoading = false;
let speciesLoading = false;
let mapSearchSeq = 0;
let mapActiveRequests = 0;
let totalObs = 0;
let totalSpecies = 0;
/** Avoid `querySelectorAll('.card')` on large grids (expensive on scroll). */
let obsCardCount = 0;
let speciesCardCount = 0;

let map = null;
let pinsLayer = null;
let heatGridLayer = null;
let pendingHeatLayer = null;
let mapMoveTimer = null;
let currentHeatUrl = null;
let mapMode = null;
let lastMapFilterKey = null;

/** "none" | fixed lat/lng in URL; "button" | "url" = near me, share as `near_me` not coordinates */
let nearMeSource = "none";

/** True when the user is filtering by nearby (radius + optional GPS), not by a named place. */
let placeNearbyMode = false;

/** Last committed label shown in the place field (cleared when the user edits the field). */
let placeInputCommitted = "";

let detailTaxonId = null;

const el = {
  taxonInput: document.getElementById("taxon-input"),
  taxonId: document.getElementById("taxon-id"),
  taxonSuggestions: document.getElementById("taxon-suggestions"),
  taxonSelected: document.getElementById("taxon-selected"),
  placeInputWrap: document.getElementById("place-input-wrap"),
  placeInput: document.getElementById("place-input"),
  placeId: document.getElementById("place-id"),
  placeSuggestions: document.getElementById("place-suggestions"),
  btnClearPlace: document.getElementById("btn-clear-place"),
  userLogin: document.getElementById("user-login"),
  unobservedInput: document.getElementById("unobserved-input"),
  radiusKm: document.getElementById("radius-km"),
  nearbyControls: document.getElementById("nearby-controls"),
  lat: document.getElementById("lat"),
  lng: document.getElementById("lng"),
  filterNativeStatus: document.getElementById("filter-native-status"),
  qualityGrade: document.getElementById("quality-grade"),
  sortMode: document.getElementById("sort-mode"),
  mediaPhotos: document.getElementById("media-photos"),
  mediaSounds: document.getElementById("media-sounds"),
  uploadedDays: document.getElementById("uploaded-days"),
  popularOnly: document.getElementById("popular-only"),
  metaFaves: document.getElementById("meta-faves"),
  metaSpeciesCount: document.getElementById("meta-species-count"),
  metaLocation: document.getElementById("meta-location"),
  metaNativeStatus: document.getElementById("meta-native-status"),
  metaGrade: document.getElementById("meta-grade"),
  metaSciName: document.getElementById("meta-sci-name"),
  monthsGrid: document.getElementById("months-grid"),
  btnReset: document.getElementById("btn-reset"),
  btnCopyLink: document.getElementById("btn-copy-link"),
  tabs: document.querySelectorAll(".tab"),
  panelFilters: document.getElementById("panel-filters"),
  panelObs: document.getElementById("panel-observations"),
  panelSpecies: document.getElementById("panel-species"),
  panelMap: document.getElementById("panel-map"),
  resultsGrid: document.getElementById("results-grid"),
  speciesGrid: document.getElementById("species-grid"),
  obsError: document.getElementById("error-banner-obs"),
  speciesError: document.getElementById("error-banner-species"),
  searchSummaryObs: document.getElementById("search-summary-obs"),
  searchSummarySpecies: document.getElementById("search-summary-species"),
  mapError: document.getElementById("error-banner-map"),
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
  const line = `${formatCountLabel(totalObs, "observation", "observations")} · ${formatCountLabel(totalSpecies, "species", "species")}`;
  if (el.searchSummaryObs) el.searchSummaryObs.textContent = line;
  if (el.searchSummarySpecies) el.searchSummarySpecies.textContent = line;
  setSearchSummaryVisibility();
}

function setSearchSummaryVisibility() {
  const obsOn = currentView === "observations";
  const speciesOn = currentView === "species";
  if (el.searchSummaryObs) {
    el.searchSummaryObs.hidden = !obsOn || !el.searchSummaryObs.textContent.trim();
  }
  if (el.searchSummarySpecies) {
    el.searchSummarySpecies.hidden = !speciesOn || !el.searchSummarySpecies.textContent.trim();
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
  const res = await fetch(`${API}/search?${p.toString()}`);
  if (!res.ok) return [];
  const data = await res.json();
  const rows = data.results || [];
  return rows
    .filter((row) => row && row.type === "Place" && row.record && row.record.id != null)
    .map((row) => row.record);
}

/**
 * Navigate explicitly from a tap/click so the destination URL matches this card.
 * Relying on default anchor navigation alone can mis-resolve universal
 * links to the iNaturalist app (opening the previous observation).
 */
function navigateFromCardClick(e, url) {
  if (e.defaultPrevented) return;
  if (e.button !== 0) return;
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  e.stopPropagation();
  window.location.assign(url);
}

function mediumPhotoUrl(url) {
  if (!url) return "";
  return url.replace(/\/square\./, "/medium.");
}

function showError(panel, msg) {
  const node = panel === "species" ? el.speciesError : panel === "map" ? el.mapError : el.obsError;
  node.textContent = msg;
  node.hidden = !msg;
}

function clearErrors() {
  showError("obs", "");
  showError("species", "");
  showError("map", "");
}

function initMonths() {
  el.monthsGrid.innerHTML = "";
  for (let m = 1; m <= 12; m += 1) {
    const label = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.dataset.month = String(m);
    box.addEventListener("change", () => {
      scheduleUrlSync();
    });
    label.appendChild(box);
    label.appendChild(document.createTextNode(MONTH_NAMES[m - 1]));
    el.monthsGrid.appendChild(label);
  }
}

function getMonths() {
  return Array.from(el.monthsGrid.querySelectorAll('input[type="checkbox"]:checked'))
    .map((x) => x.dataset.month)
    .sort((a, b) => Number(a) - Number(b));
}

function setMonths(csv) {
  const keep = new Set((csv || "").split(",").map((x) => x.trim()).filter(Boolean));
  el.monthsGrid.querySelectorAll('input[type="checkbox"]').forEach((box) => {
    box.checked = keep.has(box.dataset.month);
  });
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
    return { faves: true, speciesCount: true, location: false, nativeStatus: false, grade: false, sciName: false };
  }
  const raw = q.get("cardmeta") ?? "";
  if (!raw) {
    return { faves: false, speciesCount: false, location: false, nativeStatus: false, grade: false, sciName: false };
  }
  const set = new Set(
    raw
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean)
  );
  return {
    faves: set.has("fav"),
    speciesCount: set.has("spc"),
    location: set.has("loc"),
    nativeStatus: set.has("nat"),
    grade: set.has("grd"),
    sciName: set.has("sci"),
  };
}

function applyCardMetaFromQuery(q) {
  const o = parseCardMetaQuery(q);
  el.metaFaves.checked = o.faves;
  el.metaSpeciesCount.checked = o.speciesCount;
  el.metaLocation.checked = o.location;
  el.metaNativeStatus.checked = o.nativeStatus;
  el.metaGrade.checked = o.grade;
  el.metaSciName.checked = o.sciName;
}

function formatCardMetaQuery() {
  const fav = el.metaFaves.checked;
  const spc = el.metaSpeciesCount.checked;
  const loc = el.metaLocation.checked;
  const nat = el.metaNativeStatus.checked;
  const grd = el.metaGrade.checked;
  const sci = el.metaSciName.checked;
  if (fav && spc && !loc && !nat && !grd && !sci) return null;
  if (!fav && spc && !loc && !nat && !grd && !sci) return null;
  const parts = [];
  if (fav) parts.push("fav");
  if (spc) parts.push("spc");
  if (loc) parts.push("loc");
  if (nat) parts.push("nat");
  if (grd) parts.push("grd");
  if (sci) parts.push("sci");
  return parts.join(",");
}

function getEstablishmentFilter() {
  const sel = el.filterNativeStatus;
  const v = sel && sel.value ? sel.value : "any";
  if (v === "native" || v === "introduced" || v === "invasive") return v;
  return "any";
}

/**
 * @param {object} [options]
 * @param {"list"|"species_counts"} [options.establishmentMode]
 * @param {string} [options.kingCountyTaxonIdsCsv] comma-separated iNat taxon IDs from the King County list (precomputed when async context has already loaded KC data)
 */
function commonParams(options = {}) {
  const establishmentMode = options.establishmentMode || "list";
  const kcCsv = options.kingCountyTaxonIdsCsv != null ? options.kingCountyTaxonIdsCsv : "";
  const ef = getEstablishmentFilter();

  const p = new URLSearchParams();
  const userTid = el.taxonId.value.trim();

  if (ef === "native") {
    p.set("native", "true");
    if (userTid) p.set("taxon_id", userTid);
  } else if (ef === "introduced") {
    p.set("introduced", "true");
    if (userTid) p.set("taxon_id", userTid);
    if (kcCsv) p.set("without_taxon_id", kcCsv);
  } else if (ef === "invasive") {
    if (kcCsv) {
      p.set("taxon_id", kcCsv);
    } else if (userTid) {
      p.set("taxon_id", userTid);
    } else {
      p.set("invasive", "true");
    }
    if (establishmentMode === "species_counts") {
      p.set("introduced", "true");
    } else if (kcCsv || userTid) {
      p.set("invasive", "true");
    }
  } else if (userTid) {
    p.set("taxon_id", userTid);
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

  const uid = el.unobservedInput.value.trim().toLowerCase();
  if (uid) p.set("unobserved_by_user_id", uid);

  const months = getMonths();
  if (months.length) p.set("month", months.join(","));

  if (el.qualityGrade.value) p.set("quality_grade", el.qualityGrade.value);

  const photosOn = el.mediaPhotos.checked;
  const soundsOn = el.mediaSounds.checked;
  if (photosOn && soundsOn) {
    p.set("photos", "true");
    p.set("sounds", "true");
  } else if (photosOn) p.set("photos", "true");
  else if (soundsOn) p.set("sounds", "true");

  const days = parseInt(el.uploadedDays.value, 10);
  if (!Number.isNaN(days) && days >= 1) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - days);
    d.setUTCHours(0, 0, 0, 0);
    p.set("created_d1", d.toISOString());
  }

  if (el.popularOnly.checked) p.set("popular", "true");

  return p;
}

function joinKingCountyTaxonIdsCsv(kc) {
  if (!kc || !kc.allIds || kc.allIds.size === 0) return "";
  return [...kc.allIds].sort((a, b) => a - b).join(",");
}

async function observationParams(page) {
  const kc = await ensureKingCountyNoxiousData();
  const p = commonParams({ establishmentMode: "list", kingCountyTaxonIdsCsv: joinKingCountyTaxonIdsCsv(kc) });
  p.set("page", String(page));
  p.set("per_page", String(OBS_PER_PAGE));
  if (el.sortMode.value === "faves") {
    p.set("order_by", "votes");
    p.set("order", "desc");
  } else {
    p.set("order_by", "created_at");
    p.set("order", "desc");
  }
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

/**
 * API returns `order_by=votes` desc; only re-sort a page when ties need breaking by upload time.
 */
function sortObservationResultsForDisplay(results) {
  if (el.sortMode.value !== "faves" || !results.length) return results;
  const counts = results.map((o) => Number(o.faves_count) || 0);
  if (new Set(counts).size === counts.length) return results;
  return [...results].sort((a, b) => {
    const fa = Number(a.faves_count) || 0;
    const fb = Number(b.faves_count) || 0;
    if (fb !== fa) return fb - fa;
    return observationCreatedAtMs(b) - observationCreatedAtMs(a);
  });
}

async function speciesParams(page) {
  const kc = await ensureKingCountyNoxiousData();
  const p = commonParams({ establishmentMode: "species_counts", kingCountyTaxonIdsCsv: joinKingCountyTaxonIdsCsv(kc) });
  p.set("page", String(page));
  p.set("per_page", String(SPECIES_PER_PAGE));
  p.set("order", "desc");
  p.set("order_by", "count");
  return p;
}

async function observationCountParams() {
  const p = await observationParams(1);
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
  const p = commonParams({ establishmentMode: "species_counts", kingCountyTaxonIdsCsv: joinKingCountyTaxonIdsCsv(kc) });
  p.set("taxon_id", String(taxonId));
  p.set("order_by", "count");
  p.set("order", "desc");
  return p;
}

/**
 * Params for `GET /observations/histogram` month-of-year for species detail.
 * Matches the species_counts scope for this taxon, but drops `month` — otherwise
 * the chart only shows selected months (from the Filters grid) and looks wrong.
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

function getCardMetaOptions() {
  return {
    faves: el.metaFaves.checked,
    speciesCount: el.metaSpeciesCount.checked,
    location: el.metaLocation.checked,
    nativeStatus: el.metaNativeStatus.checked,
    grade: el.metaGrade.checked,
    sciName: el.metaSciName.checked,
  };
}

function formatQualityGradeLabel(qg) {
  const g = String(qg || "").trim().toLowerCase();
  if (g === "research") return "Research grade";
  if (g === "needs_id") return "Needs ID";
  if (g === "casual") return "Casual";
  return "";
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
    const p = commonParams({ establishmentMode: "list", kingCountyTaxonIdsCsv: kcCsv });
    p.set("taxon_id", slice.join(","));
    p.set("per_page", "200");
    p.set("page", "1");
    p.set("order_by", "created_at");
    p.set("order", "desc");
    try {
      const res = await fetch(`${API}/observations?${p.toString()}`);
      if (!res.ok) continue;
      const data = await res.json();
      const want = new Set(slice);
      for (const obs of data.results || []) {
        const t = obs.taxon;
        if (!t || t.id == null) continue;
        const tid = Number(t.id);
        if (want.has(tid) && !map.has(tid)) map.set(tid, t);
      }
    } catch {
      /* ignore */
    }
  }

  const missing = uniq.filter((id) => !map.has(id));
  for (const tid of missing) {
    const p = commonParams({ establishmentMode: "list", kingCountyTaxonIdsCsv: kcCsv });
    p.set("taxon_id", String(tid));
    p.set("per_page", "1");
    p.set("page", "1");
    try {
      const res = await fetch(`${API}/observations?${p.toString()}`);
      if (!res.ok) continue;
      const data = await res.json();
      const obs = (data.results || [])[0];
      const t = obs && obs.taxon;
      if (t && t.id != null) map.set(tid, t);
    } catch {
      /* ignore */
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
  if (o.location) {
    const loc = observationLocationLine(obs);
    if (loc) parts.push(`<p class="card-meta-line">${escapeHtml(loc)}</p>`);
  }
  if (o.nativeStatus) {
    const segs = nativeStatusMetaSegments(obs, kcData);
    const h = renderMetaSegmentsHtml(segs);
    if (h) parts.push(h);
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
  if (o.sciName) {
    const taxon = row.taxon || {};
    const sci = typeof taxon.name === "string" ? taxon.name.trim() : "";
    if (sci) parts.push(`<p class="card-meta-line card-meta-line--sci"><em>${escapeHtml(sci)}</em></p>`);
  }
  return parts;
}

function renderCard({ href, name, imageUrl, metaLines = [], metaParts = null, onClick }) {
  const card = document.createElement("article");
  card.className = "card";
  const metaBlock = metaParts != null
    ? metaParts.join("")
    : metaLines.length
      ? metaLines.map((line) => `<p class="card-meta-line">${escapeHtml(line)}</p>`).join("")
      : "";
  const imgBlock = imageUrl ? `<img src="${imageUrl}" alt="" loading="lazy" />` : `<div class="no-photo">No photo</div>`;
  if (onClick) {
    card.innerHTML = `
      <a href="${href}" class="card-link" role="button" style="cursor:pointer">
        ${imgBlock}
      </a>
      <div class="card-bottom">
        ${metaBlock}
        <p class="card-title-overlay">${escapeHtml(name)}</p>
      </div>
    `;
    card.querySelector("a.card-link").addEventListener("click", (e) => { e.preventDefault(); onClick(); });
  } else {
    card.innerHTML = `
      <a href="${href}" class="card-link" rel="noopener noreferrer">
        ${imgBlock}
      </a>
      <div class="card-bottom">
        ${metaBlock}
        <p class="card-title-overlay">${escapeHtml(name)}</p>
      </div>
    `;
    card.querySelector("a.card-link").addEventListener("click", (e) => navigateFromCardClick(e, href));
  }
  return card;
}

async function runObservationSearch(reset) {
  if (obsLoading) return;
  obsLoading = true;
  showError("obs", "");
  try {
    if (reset) {
      obsPage = 1;
      totalObs = 0;
      totalSpecies = 0;
      obsHasMore = false;
      obsCardCount = 0;
      el.resultsGrid.innerHTML = "";
    }

    const listUrl = `${API}/observations?${(await observationParams(obsPage)).toString()}`;
    const listPromise = fetch(listUrl);

    const res = await listPromise;
    if (!res.ok) throw new Error(`Request failed (${res.status})`);
    const data = await res.json();
    const results = sortObservationResultsForDisplay(data.results || []);
    totalObs = data.total_results || 0;

    if (reset) {
      void (async () => {
        try {
          const sRes = await fetch(`${API}/observations/species_counts?${(await speciesCountParams()).toString()}`);
          if (!sRes.ok) return;
          const sData = await sRes.json();
          totalSpecies = sData.total_results || 0;
          updateSearchSummaryElements();
        } catch {
          /* ignore */
        }
      })();
    }

    const metaOpts = getCardMetaOptions();
    let kcData = null;
    if (metaOpts.nativeStatus) {
      kcData = await ensureKingCountyNoxiousData();
    }

    const frag = document.createDocumentFragment();
    for (const obs of results) {
      const name = obs.taxon?.preferred_common_name || obs.taxon?.name || obs.species_guess || "Unknown";
      const imageUrl = obs.photos?.[0]?.url ? mediumPhotoUrl(obs.photos[0].url) : "";
      frag.appendChild(renderCard({
        href: `https://www.inaturalist.org/observations/${obs.id}`,
        name,
        imageUrl,
        metaParts: observationMetaHtmlParts(obs, kcData),
      }));
    }
    el.resultsGrid.appendChild(frag);
    obsCardCount += results.length;

    const loaded = obsCardCount;
    obsHasMore = loaded < totalObs && results.length > 0;
    if (obsHasMore) obsPage += 1;
    updateSearchSummaryElements();
    syncUrl();
  } catch (err) {
    showError("obs", err.message || "Could not load observations.");
  } finally {
    obsLoading = false;
  }
}

async function runSpeciesSearch(reset) {
  if (speciesLoading) return;
  speciesLoading = true;
  showError("species", "");
  try {
    if (reset) {
      speciesPage = 1;
      totalSpecies = 0;
      totalObs = 0;
      speciesHasMore = false;
      speciesCardCount = 0;
      el.speciesGrid.innerHTML = "";
    }

    const listUrl = `${API}/observations/species_counts?${(await speciesParams(speciesPage)).toString()}`;
    const listPromise = fetch(listUrl);

    const res = await listPromise;
    if (!res.ok) throw new Error(`Request failed (${res.status})`);
    const data = await res.json();
    const results = data.results || [];
    totalSpecies = data.total_results || 0;

    if (reset) {
      void (async () => {
        try {
          const oRes = await fetch(`${API}/observations?${(await observationCountParams()).toString()}`);
          if (!oRes.ok) return;
          const oData = await oRes.json();
          totalObs = oData.total_results || 0;
          updateSearchSummaryElements();
        } catch {
          /* ignore */
        }
      })();
    }

    const metaOpts = getCardMetaOptions();
    let kcData = null;
    let obsTaxonById = null;
    if (metaOpts.nativeStatus) {
      kcData = await ensureKingCountyNoxiousData();
      const ids = results.map((r) => r.taxon && r.taxon.id).filter((id) => id != null);
      obsTaxonById = await fetchObservationTaxonById(ids);
    }

    const frag = document.createDocumentFragment();
    for (const row of results) {
      const taxon = row.taxon || {};
      const name = taxon.preferred_common_name || taxon.name || "Unknown";
      const imageUrl = mediumPhotoUrl(taxon.default_photo?.url || taxon.default_photo?.medium_url || "");
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
    showError("species", err.message || "Could not load species.");
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

function ensureMap() {
  if (map || !window.L) return;
  map = L.map(el.mapContainer);

  const { lat, lng, zoom } = readInitialMapViewFromUrl();
  map.setView([lat, lng], zoom);
 
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  pinsLayer = L.layerGroup().addTo(map);
  map.on("moveend zoomend", () => {
    if (currentView !== "map") return;
    syncUrl();
    clearTimeout(mapMoveTimer);
    mapMoveTimer = setTimeout(() => {
      runMapSearch(false);
    }, 400);
  });
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
      const res = await fetch(`${API}/places/${placeId}`);
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
    } catch {
      /* ignore */
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
  const kc = await ensureKingCountyNoxiousData();
  const p = commonParams({ establishmentMode: "list", kingCountyTaxonIdsCsv: joinKingCountyTaxonIdsCsv(kc) });
  p.delete("place_id");
  p.delete("lat");
  p.delete("lng");
  p.delete("radius");
  p.delete("geo");
  const b = map.getBounds();
  p.set("nelat", String(b.getNorth()));
  p.set("nelng", String(b.getEast()));
  p.set("swlat", String(b.getSouth()));
  p.set("swlng", String(b.getWest()));
  p.set("geo", "true");
  return p;
}

function decodeUtfGridIndex(ch) {
  let code = ch.charCodeAt(0);
  if (code >= 93) code -= 1;
  if (code >= 35) code -= 1;
  return code - 32;
}

function installHeatGridLayer(url, onReady) {
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
    heatGridLayer = L.tileLayer(url, heatLayerOpts).addTo(map);
    heatGridLayer.once("load", () => { if (onReady) onReady(); });
    return;
  }

  const newHeat = L.tileLayer(url, { ...heatLayerOpts, opacity: 0 }).addTo(map);
  pendingHeatLayer = newHeat;
  let swapped = false;
  const swap = () => {
    if (swapped || pendingHeatLayer !== newHeat) return;
    swapped = true;
    pendingHeatLayer = null;
    newHeat.setOpacity(0.5);
    if (map.hasLayer(oldHeat)) map.removeLayer(oldHeat);
    heatGridLayer = newHeat;
    if (onReady) onReady();
  };
  newHeat.once("load", swap);
  setTimeout(swap, 4000);
}

async function mapFilterKey() {
  const kc = await ensureKingCountyNoxiousData();
  const p = commonParams({ establishmentMode: "list", kingCountyTaxonIdsCsv: joinKingCountyTaxonIdsCsv(kc) });
  p.delete("place_id");
  p.delete("lat");
  p.delete("lng");
  p.delete("radius");
  p.delete("geo");
  p.sort();
  return p.toString();
}

async function runMapSearch(forceRecheck) {
  ensureMap();

  const filterKey = await mapFilterKey();
  const filtersChanged = filterKey !== lastMapFilterKey;
  lastMapFilterKey = filterKey;

  const seq = ++mapSearchSeq;
  showMapSpinner();
  showError("map", "");

  try {
    const area = await mapAreaParams();
    const countParams = new URLSearchParams(area);
    countParams.set("per_page", "1");
    countParams.set("page", "1");
    const countRes = await fetch(`${API}/observations?${countParams.toString()}`);
    if (seq !== mapSearchSeq) return;
    if (!countRes.ok) throw new Error(`Request failed (${countRes.status})`);
    const countData = await countRes.json();
    if (seq !== mapSearchSeq) return;
    const totalInArea = countData.total_results || 0;

    if (totalInArea < MAP_PIN_THRESHOLD) {
      removeHeatLayer();
      currentHeatUrl = null;
      mapMode = "pins";
      const pinsParams = new URLSearchParams(area);
      pinsParams.set("per_page", String(MAP_PIN_THRESHOLD));
      pinsParams.set("page", "1");
      const pinRes = await fetch(`${API}/observations?${pinsParams.toString()}`);
      if (seq !== mapSearchSeq) return;
      if (!pinRes.ok) throw new Error(`Request failed (${pinRes.status})`);
      const pinData = await pinRes.json();
      if (seq !== mapSearchSeq) return;
      const observations = pinData.results || [];

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
      swapPinsLayer(newPins);
    } else {
      if (seq !== mapSearchSeq) return;
      mapMode = "heat";
      const kcHeat = await ensureKingCountyNoxiousData();
      const heatParams = commonParams({ establishmentMode: "list", kingCountyTaxonIdsCsv: joinKingCountyTaxonIdsCsv(kcHeat) });
      const url = `${API}/grid/{z}/{x}/{y}.png?${heatParams}`; /* density grid tiles (not colored_heatmap) */
      installHeatGridLayer(url, () => clearMapPins());
    }

    syncUrl();
  } catch (err) {
    if (seq === mapSearchSeq) {
      showError("map", err.message || "Could not load map data.");
    }
  } finally {
    hideMapSpinner();
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
  const mapOn = currentView === "map";
  const detailOn = currentView === "detail";

  el.panelFilters.hidden = !filtersOn;
  el.panelObs.hidden = !obsOn;
  el.panelSpecies.hidden = !speciesOn;
  el.panelMap.hidden = !mapOn;
  el.panelDetail.hidden = !detailOn;

  el.panelFilters.classList.toggle("hidden", !filtersOn);
  el.panelObs.classList.toggle("hidden", !obsOn);
  el.panelSpecies.classList.toggle("hidden", !speciesOn);
  el.panelMap.classList.toggle("hidden", !mapOn);
  el.panelDetail.classList.toggle("hidden", !detailOn);

  setSearchSummaryVisibility();
}

async function switchView(view) {
  currentView = view;
  setActiveTabUI();
  syncUrl();

  if (view === "observations") {
    await runObservationSearch(true);
  } else if (view === "species") {
    await runSpeciesSearch(true);
  } else if (view === "map") {
    ensureMap();
    await new Promise((r) => requestAnimationFrame(r));
    map.invalidateSize();
    /* Do not fit to place/circle when restoring from URL — that overwrote mlat/mlng/zoom on refresh. */
    if (!urlHasValidMapPosition()) await fitMapToFilterLocation();
    await runMapSearch(true);
  } else if (view === "detail" && detailTaxonId) {
    await loadDetailFromTaxonId(detailTaxonId);
  }
}

function syncUrl() {
  const u = new URL(window.location.href);
  const q = new URLSearchParams(window.location.search);

  const taxonId = el.taxonId.value.trim();
  if (taxonId) q.set("taxon_id", taxonId);
  else q.delete("taxon_id");

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

  const months = getMonths();
  if (months.length) q.set("months", months.join(","));
  else q.delete("months");

  if (el.qualityGrade.value) q.set("grade", el.qualityGrade.value);
  else q.delete("grade");
  if (el.sortMode.value != "recent") q.set("sort", el.sortMode.value);
  else q.delete("sort");

  const mediaQ = mediaQueryFromCheckboxes();
  if (mediaQ === "photos") q.delete("media");
  else q.set("media", mediaQ);
  const ud = el.uploadedDays.value.trim();
  if (ud) q.set("days", ud);
  else q.delete("days");
  if (el.popularOnly.checked) q.set("popular", "1");
  else q.delete("popular");

  const establish = el.filterNativeStatus && el.filterNativeStatus.value ? el.filterNativeStatus.value : "any";
  if (establish && establish !== "any") q.set("establish", establish);
  else q.delete("establish");

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

  if (map) {
    q.set("mlat", map.getCenter().lat);
    q.set("mlng", map.getCenter().lng);
    q.set("zoom", map.getZoom());
  }

  u.search = q.toString();
  history.replaceState(null, "", u);
}

function readUrl() {
  const q = new URLSearchParams(window.location.search);
  const v = q.get("view");
  if (["filters", "observations", "species", "map", "detail"].includes(v)) currentView = v;

  const tid = q.get("taxon_id");
  if (tid) el.taxonId.value = tid;
  el.userLogin.value = (q.get("observer") || "").toLowerCase();

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
  } else {
    nearMeSource = "none";
    el.lat.value = q.get("lat") || "";
    el.lng.value = q.get("lng") || "";
    placeNearbyMode = Boolean(el.lat.value.trim() && el.lng.value.trim());
  }
  const r = q.get("radius") || "25";
  el.radiusKm.value = String(clampRadiusKm(r));
  updatePlaceNearbyUI();

  el.unobservedInput.value = (q.get("unobserved") || "").toLowerCase();
  applyCardMetaFromQuery(q);
  setMonths(q.get("months") || "");
  el.qualityGrade.value = q.get("grade") || "";
  el.sortMode.value = q.get("sort") || "recent";
  applyMediaFromQuery(q);
  el.uploadedDays.value = q.get("days") || "";
  el.popularOnly.checked = q.get("popular") === "1";

  if (el.filterNativeStatus) {
    const es = q.get("establish");
    el.filterNativeStatus.value = es === "native" || es === "introduced" || es === "invasive" ? es : "any";
  }

  const dtid = q.get("detail_taxon");
  if (dtid) detailTaxonId = dtid;

  const pg = parseInt(q.get("page") || "1", 10);
  if (!Number.isNaN(pg) && pg > 1) {
    if (currentView === "observations") obsPage = pg;
    if (currentView === "species") speciesPage = pg;
  }
}

async function hydrateSelections() {
  const tid = el.taxonId.value.trim();
  if (tid) {
    const res = await fetch(`${API}/taxa/${tid}`);
    if (res.ok) {
      const data = await res.json();
      const taxon = data.results?.[0];
      const label = taxon?.preferred_common_name || taxon?.name || `Taxon ${tid}`;
      setTaxonSelection(tid, label);
    }
  }

  const pid = el.placeId.value.trim();
  if (pid) {
    const res = await fetch(`${API}/places/${pid}`);
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

function setTaxonSelection(id, label) {
  el.taxonId.value = String(id);
  el.taxonInput.value = "";
  el.taxonSelected.classList.remove("hidden");
  el.taxonSelected.innerHTML = `<span>${escapeHtml(label)}</span><button type="button" aria-label="Clear taxon">x</button>`;
  el.taxonSelected.querySelector("button").addEventListener("click", () => {
    el.taxonId.value = "";
    el.taxonSelected.classList.add("hidden");
    el.taxonSelected.innerHTML = "";
    scheduleUrlSync();
  });
  hideSuggestion("taxon");
  scheduleUrlSync();
}

async function setNearbySelection() {
  nearMeSource = "none";
  placeNearbyMode = true;
  el.placeId.value = "";
  el.lat.value = "";
  el.lng.value = "";
  setCommittedPlaceDisplay("Nearby");
  hideSuggestion("place");
  updatePlaceNearbyUI();
  await requestNearbyGeolocation();
}

function setPlaceSelection(id, label, options = {}) {
  const fromHydrate = options.fromHydrate === true;
  nearMeSource = "none";
  placeNearbyMode = false;
  updatePlaceNearbyUI();
  el.placeId.value = String(id);
  setCommittedPlaceDisplay(label);
  el.lat.value = "";
  el.lng.value = "";
  hideSuggestion("place");
  if (fromHydrate) {
    syncUrl();
    return;
  }
  void onLocationFilterChanged();
}

function hideSuggestion(kind) {
  if (kind === "taxon") {
    el.taxonSuggestions.hidden = true;
    el.taxonSuggestions.innerHTML = "";
    taxonHighlight = -1;
    el.taxonInput.setAttribute("aria-expanded", "false");
  } else if (kind === "place") {
    el.placeSuggestions.hidden = true;
    el.placeSuggestions.innerHTML = "";
    placeHighlight = -1;
    el.placeInput.setAttribute("aria-expanded", "false");
  }
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
      const label = item.preferred_common_name || item.name;
      li.innerHTML = `<span>${escapeHtml(label)}</span>${item.preferred_common_name ? `<div class="sci">${escapeHtml(item.name)}</div>` : ""}`;
      li.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        setTaxonSelection(item.id, label);
      });
    } else if (kind === "place") {
      if (item === NEARBY_SUGGESTION) {
        li.innerHTML = `<span>Nearby</span>`;
        li.addEventListener("mousedown", (ev) => {
          ev.preventDefault();
          void setNearbySelection();
        });
      } else {
        const label = item.display_name || item.name;
        li.innerHTML = `<span>${escapeHtml(label)}</span>`;
        li.addEventListener("mousedown", (ev) => {
          ev.preventDefault();
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
        const res = await fetch(`${API}/taxa/autocomplete?q=${encodeURIComponent(q)}&per_page=12`);
        const data = res.ok ? await res.json() : { results: [] };
        renderSuggestions("taxon", data.results || []);
      } catch {
        hideSuggestion("taxon");
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
      } catch {
        hideSuggestion("place");
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
    if (!el.taxonInput.contains(e.target) && !el.taxonSuggestions.contains(e.target)) hideSuggestion("taxon");
    if (!el.placeInput.contains(e.target) && !el.placeSuggestions.contains(e.target)) hideSuggestion("place");
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
      items[taxonHighlight].dispatchEvent(new MouseEvent("mousedown"));
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
      items[placeHighlight].dispatchEvent(new MouseEvent("mousedown"));
    } else if (e.key === "Escape") {
      hideSuggestion("place");
    }
  });
}

function applyGeoPosition(pos) {
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
  } catch {
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
    await onLocationFilterChanged();
  } catch {
    nearMeSource = "none";
    placeNearbyMode = false;
    el.lat.value = "";
    el.lng.value = "";
    setCommittedPlaceDisplay("");
    updatePlaceNearbyUI();
    syncUrl();
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

function wireInfiniteScroll() {
  const opts = { rootMargin: "120px" };
  const obsObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      if (currentView === "observations" && obsHasMore && !obsLoading) void runObservationSearch(false);
    }
  }, el.panelObs ? { ...opts, root: el.panelObs } : opts);
  const speciesObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      if (currentView === "species" && speciesHasMore && !speciesLoading) void runSpeciesSearch(false);
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
  el.sortMode.addEventListener("change", onChange);

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
  el.metaGrade.addEventListener("change", onMeta);
  el.metaSciName.addEventListener("change", onMeta);

  if (el.filterNativeStatus) {
    el.filterNativeStatus.addEventListener("change", () => {
      lastMapFilterKey = null;
      queueMicrotask(() => refreshResultPanelsIfMetaChanged());
    });
  }
}

function wireButtons() {
  el.btnReset.addEventListener("click", () => {
    el.taxonInput.value = "";
    el.taxonId.value = "";
    el.taxonSelected.hidden = true;
    el.taxonSelected.innerHTML = "";
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
    el.mediaPhotos.checked = true;
    el.mediaSounds.checked = false;
    el.uploadedDays.value = "";
    el.popularOnly.checked = false;
    el.metaFaves.checked = true;
    el.metaSpeciesCount.checked = true;
    el.metaLocation.checked = false;
    el.metaNativeStatus.checked = false;
    el.metaGrade.checked = false;
    el.metaSciName.checked = false;
    if (el.filterNativeStatus) el.filterNativeStatus.value = "any";
    el.monthsGrid.querySelectorAll('input[type="checkbox"]').forEach((x) => {
      x.checked = false;
    });
    el.resultsGrid.innerHTML = "";
    el.speciesGrid.innerHTML = "";
    obsCardCount = 0;
    speciesCardCount = 0;
    clearMapOverlays();
    currentHeatUrl = null;
    mapMode = null;
    lastMapFilterKey = null;
    clearErrors();
    obsPage = 1;
    speciesPage = 1;
    obsHasMore = false;
    speciesHasMore = false;
    currentView = "filters";
    setActiveTabUI();
    history.replaceState(null, "", window.location.pathname);
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
      fetch(`${API}/observations?${hp}`).then(async (r) => ({
        page,
        ok: r.ok,
        json: r.ok ? await r.json() : null,
      }))
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

function buildSearchUrlWithSpecies(taxonId) {
  const u = new URL(window.location.href);
  const q = new URLSearchParams(u.search);
  q.set("taxon_id", String(taxonId));
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
    const res = await fetch(`${API}/taxa/${taxonId}`);
    if (!res.ok) throw new Error(`Request failed (${res.status})`);
    const data = await res.json();
    const taxon = data.results?.[0];
    if (!taxon) throw new Error("Species not found.");
    await showSpeciesDetail(taxon, null);
  } catch (err) {
    el.detailContent.innerHTML = `<p style="color:var(--danger);padding:1rem">${escapeHtml(err.message || "Could not load species.")}</p>`;
  }
}

async function showSpeciesDetail(taxon, obsCount) {
  detailTaxonId = taxon.id;
  currentView = "detail";
  setActiveTabUI();
  syncUrl();

  const name = taxon.preferred_common_name || taxon.name || "Unknown";
  const sciName = taxon.name || "";
  const imageUrl = mediumPhotoUrl(taxon.default_photo?.url || taxon.default_photo?.medium_url || "").replace("/medium.", "/large.");
  const inatAppUrl = inaturalistTaxonAppUrl(taxon.id);
  const searchUrl = buildSearchUrlWithSpecies(taxon.id);

  el.detailContent.innerHTML = `
    <div class="detail-hero">
      ${imageUrl ? `<img src="${imageUrl}" alt="${escapeHtml(name)}" />` : ""}
      <div class="detail-hero-info">
        <h2>${escapeHtml(name)}</h2>
        ${sciName && sciName !== name ? `<p class="sci-name">${escapeHtml(sciName)}</p>` : ""}
        <div class="detail-links">
          <a href="${escapeHtml(inatAppUrl)}">View on iNaturalist &rarr;</a>
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
  const hourSampleParams = commonParams({ establishmentMode: "list", kingCountyTaxonIdsCsv: joinKingCountyTaxonIdsCsv(kcDetail) });
  hourSampleParams.set("taxon_id", String(taxon.id));

  const monthSection = document.getElementById("detail-month-section");
  const hourSection = document.getElementById("detail-hour-section");

  try {
    const monthParams = await monthOfYearHistogramParams(taxon.id);
    const monthRes = await fetch(`${API}/observations/histogram?${monthParams}`);
    if (monthRes.ok) {
      const monthData = await monthRes.json();
      const moy = monthData.results?.month_of_year || {};
      const monthCounts = Array.from({ length: 12 }, (_, i) => moy[i + 1] || 0);
      monthSection.innerHTML = `<h3>Observations by month</h3>`;
      monthSection.appendChild(renderBarChart(monthCounts, MONTH_NAMES));
    } else {
      monthSection.querySelector(".detail-loading").textContent = "Could not load data.";
    }
  } catch {
    monthSection.querySelector(".detail-loading").textContent = "Could not load data.";
  }

  try {
    const { hourCounts, sampled } = await sampleHourOfDayFromObservations(hourSampleParams);
    if (sampled > 0) {
      hourSection.innerHTML = `<h3>Observations by hour of day</h3><p class="detail-hour-note">Based on ${sampled} recent observations with time data</p>`;
      hourSection.appendChild(renderBarChart(hourCounts, HOUR_LABELS, { labelStep: 2, extraChartClass: "bar-chart--hour" }));
    } else {
      hourSection.innerHTML = `<h3>Observations by hour of day</h3><p style="font-size:0.85rem;color:var(--muted)">No time-of-day data available.</p>`;
    }
  } catch {
    hourSection.querySelector(".detail-loading").textContent = "Could not load data.";
  }
}

async function boot() {
  initMonths();
  readUrl();
  if (nearMeSource === "url") {
    await resolveNearMeFromUrl();
  }
  await hydrateSelections();
  wireAutocomplete();
  wirePlaceField();
  wireTabs();
  wireInfiniteScroll();
  wireFilterExtras();
  wireButtons();

  await switchView(currentView);
}

boot();
