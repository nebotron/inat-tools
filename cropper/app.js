/**
 * Subject square crop — static photos only. COCO-SSD (MobileNet v2 lite), padding-only framing.
 * HEIC: WebKit/Safari decode via HTMLImageElement (native). heic2any only as last resort on desktop
 * non-Safari (may fail with unsupported variants, e.g. ERR_LIBHEIF).
 */

import * as tf from "https://esm.sh/@tensorflow/tfjs@4.17.0";
/** Pin TFJS in the query string so esm.sh does not bundle a second @tensorflow/tfjs copy (duplicate globals break loading). */
import * as cocoSsd from "https://esm.sh/@tensorflow-models/coco-ssd@2.2.3?deps=@tensorflow/tfjs@4.17.0";
import JSZip from "https://esm.sh/jszip@3.10.1";
import exifr from "https://cdn.jsdelivr.net/npm/exifr@7.1.3/dist/full.esm.mjs";
import piexif from "https://esm.sh/piexifjs@1.0.4";
import {
  parseInatApiTokenPaste,
  persistParsedInatApiJwt,
  clearStoredInatApiJwt,
  getStoredInatApiJwt,
  fetchUsersMeWithStoredJwt,
  inatApiJwtAuthorizationValue,
  formatInatHttpErrorForDisplay,
  validateInatJwtFormat,
  inatFetch,
} from "../lib/inat-api-client.js";

/** Real `fetch` before any temporary patching; bare `fetch()` inside our wrapper would recurse into `window.fetch`. */
const nativeFetch = globalThis.fetch.bind(globalThis);

const MODEL_CACHE_NAME = "coco-ssd-model-v2";
/** Default COCO-SSD variant: fewer / smaller weight shards than full mobilenet_v2 (~17), better on mobile Safari. */
const COCO_SSD_BASE = "lite_mobilenet_v2";

/** Persist per-image crop mappings by filename (debounced). */
const SESSION_IDB_NAME = "subject-square-crop-session";
const SESSION_IDB_VER = 1;
const SESSION_STORE = "kv";
const SESSION_KEY = "crop-name-mappings-v1";
let sessionPersistTimer = null;
let sessionDbPromise = null;
let sessionPersistDirty = false;

function openSessionIdb() {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  if (!sessionDbPromise) {
    sessionDbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(SESSION_IDB_NAME, SESSION_IDB_VER);
      req.onerror = () => {
        sessionDbPromise = null;
        reject(req.error);
      };
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(SESSION_STORE)) db.createObjectStore(SESSION_STORE);
      };
      req.onsuccess = () => resolve(req.result);
    });
  }
  return sessionDbPromise;
}

async function clearPersistedSession() {
  try {
    const db = await openSessionIdb();
    if (!db) return;
    await new Promise((resolve, reject) => {
      const tx = db.transaction(SESSION_STORE, "readwrite");
      tx.objectStore(SESSION_STORE).delete(SESSION_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.warn("clearPersistedSession", e);
  }
}

function isIOSOrIPadOS() {
  const ua = navigator.userAgent || "";
  if (/iPhone|iPad|iPod/i.test(ua)) return true;
  if (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1) return true;
  return false;
}

/** Chrome on Android has shipped hard crashes when `navigator.share({ files })` includes several files. */
function isAndroidBrowser() {
  return typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent || "");
}

/** Cached once — `minCropSide` ran `matchMedia` every pan/zoom frame before. */
let cachedCoarsePointer = null;
function isCoarsePointerPrimaryInput() {
  if (cachedCoarsePointer != null) return cachedCoarsePointer;
  try {
    cachedCoarsePointer =
      typeof window !== "undefined" &&
      window.matchMedia &&
      window.matchMedia("(pointer: coarse)").matches;
  } catch {
    cachedCoarsePointer = false;
  }
  return cachedCoarsePointer;
}

function cropEditorBitmapDrawMaxEdge() {
  return isIOSOrIPadOS() ? CROP_EDITOR_BITMAP_DRAW_MAX_EDGE_IOS : CROP_EDITOR_BITMAP_DRAW_MAX_EDGE;
}

/**
 * Try to read pixel dimensions from container metadata only (no full decode).
 * @param {File} file
 * @returns {Promise<{ w: number, h: number } | null>}
 */
async function tryGetImagePixelSizeFromFile(file) {
  try {
    const ex = await exifr.parse(file, { ifd0: true, mergeOutput: true });
    if (!ex || typeof ex !== "object") return null;
    const w = ex.ImageWidth ?? ex.width;
    const h = ex.ImageLength ?? ex.ImageHeight ?? ex.height;
    const iw = typeof w === "number" && Number.isFinite(w) && w > 0 ? Math.round(w) : null;
    const ih = typeof h === "number" && Number.isFinite(h) && h > 0 ? Math.round(h) : null;
    if (iw && ih) return { w: iw, h: ih };
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Storage pixel size from metadata, swapped when EXIF orientation implies a 90°/270° display rotation
 * (same width/height basis as `decodeForPipeline` / `<img>` for typical JPEG/TIFF).
 * @param {number} w
 * @param {number} h
 * @param {unknown} orientation — EXIF orientation 1–8
 */
function orientedDimensionsFromExifStorage(w, h, orientation) {
  const o = Number(orientation);
  const norm = Number.isFinite(o) && o >= 1 && o <= 8 ? Math.floor(o) : 1;
  if (norm >= 5 && norm <= 8) return { w: h, h: w };
  return { w, h };
}

/**
 * Like {@link tryGetImagePixelSizeFromFile} but returns dimensions in the oriented/display sense when
 * orientation is present — used to skip full decodes during saved-crop reapply when sizes match.
 * @param {File} file
 * @returns {Promise<{ w: number, h: number } | null>}
 */
async function tryGetOrientedPixelSizeFromFile(file) {
  try {
    const ex = await exifr.parse(file, { ifd0: true, mergeOutput: true });
    if (!ex || typeof ex !== "object") return null;
    const w = ex.ImageWidth ?? ex.width;
    const h = ex.ImageLength ?? ex.ImageHeight ?? ex.height;
    const iw = typeof w === "number" && Number.isFinite(w) && w > 0 ? Math.round(w) : null;
    const ih = typeof h === "number" && Number.isFinite(h) && h > 0 ? Math.round(h) : null;
    if (!iw || !ih) return null;
    const orient = ex.Orientation ?? ex.orientation;
    return orientedDimensionsFromExifStorage(iw, ih, orient);
  } catch {
    return null;
  }
}

/**
 * Decode a still image to an `ImageBitmap` capped by longest edge (reduces RAM/GPU vs full-res prefetch).
 * @param {File} file
 */
async function createCappedImageBitmapForCropPreview(file) {
  const cap = cropEditorBitmapDrawMaxEdge();
  let dims = null;
  try {
    dims = await tryGetImagePixelSizeFromFile(file);
  } catch {
    dims = null;
  }
  if (dims && dims.w > 0 && dims.h > 0) {
    const m = Math.max(dims.w, dims.h);
    if (m <= cap) return await createImageBitmap(file);
    const s = cap / m;
    const rw = Math.max(1, Math.round(dims.w * s));
    const rh = Math.max(1, Math.round(dims.h * s));
    return await createImageBitmap(file, { resizeWidth: rw, resizeHeight: rh });
  }
  const bm = await createImageBitmap(file);
  const mx = Math.max(bm.width, bm.height);
  if (mx <= cap) return bm;
  const s = cap / mx;
  const rw = Math.max(1, Math.round(bm.width * s));
  const rh = Math.max(1, Math.round(bm.height * s));
  const out = await createImageBitmap(bm, 0, 0, bm.width, bm.height, { resizeWidth: rw, resizeHeight: rh });
  bm.close();
  return out;
}

/**
 * @param {CanvasImageSource} source
 * @param {number} maxEdge
 * @param {"low" | "medium" | "high"} [smoothing]
 * @returns {HTMLCanvasElement}
 */
function paintCropPreviewCanvasFromSource(source, maxEdge, smoothing = "medium") {
  const sw = source instanceof HTMLImageElement ? source.naturalWidth : source.width;
  const sh = source instanceof HTMLImageElement ? source.naturalHeight : source.height;
  if (!sw || !sh) throw new Error("Missing image dimensions for crop preview.");
  const bmMax = Math.max(sw, sh);
  let dw = sw;
  let dh = sh;
  if (bmMax > maxEdge) {
    const s = maxEdge / bmMax;
    dw = Math.max(1, Math.round(sw * s));
    dh = Math.max(1, Math.round(sh * s));
  }
  const c = document.createElement("canvas");
  c.className = "crop-preview-canvas";
  c.width = dw;
  c.height = dh;
  const pctx = c.getContext("2d", { willReadFrequently: false, alpha: false });
  if (!pctx) throw new Error("Could not get 2d context for crop preview.");
  pctx.imageSmoothingEnabled = true;
  pctx.imageSmoothingQuality = smoothing;
  pctx.drawImage(source, 0, 0, dw, dh);
  return c;
}

function schedulePersistSession() {
  if (typeof indexedDB === "undefined") return;
  if (!sessionPersistDirty) return;
  if (sessionPersistTimer != null) clearTimeout(sessionPersistTimer);
  sessionPersistTimer = setTimeout(() => {
    sessionPersistTimer = null;
    void persistSessionNow();
  }, 650);
}

function markSessionPersistDirty() {
  if (typeof indexedDB === "undefined") return;
  sessionPersistDirty = true;
  schedulePersistSession();
}

function clearLegacySessionIfNeeded() {
  if (typeof indexedDB === "undefined") return Promise.resolve();
  return openSessionIdb()
    .then((db) => {
      if (!db) return;
      return new Promise((resolve, reject) => {
        const tx = db.transaction(SESSION_STORE, "readwrite");
        tx.objectStore(SESSION_STORE).delete("v1");
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    })
    .catch((e) => {
      console.warn("clearLegacySessionIfNeeded", e);
    });
}

/** Run pending debounced save immediately (e.g. before tab background/close). */
function flushPendingSessionPersist() {
  if (sessionPersistTimer != null) {
    clearTimeout(sessionPersistTimer);
    sessionPersistTimer = null;
  }
  if (sessionPersistDirty) void persistSessionNow();
}

async function persistSessionNow() {
  if (typeof indexedDB === "undefined") return;
  if (!sessionPersistDirty) return;
  try {
    const db = await openSessionIdb();
    if (!db) return;
    const entries = serializeCropNameMappingsForSession();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(SESSION_STORE, "readwrite");
      const store = tx.objectStore(SESSION_STORE);
      if (!entries.length) {
        store.delete(SESSION_KEY);
      } else {
        store.put({ v: 1, savedAt: Date.now(), entries }, SESSION_KEY);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    sessionPersistDirty = false;
    setSessionPersistNotice("");
  } catch (e) {
    console.warn("persistSessionNow", e);
    setSessionPersistNotice(
      `Saved crop mappings unavailable: could not write browser storage (${e && e.message ? String(e.message) : "unknown error"}).`
    );
  }
}

async function tryRestoreSessionFromIdb() {
  if (typeof indexedDB === "undefined") return false;
  try {
    const db = await openSessionIdb();
    if (!db) return false;

    const payload = await new Promise((resolve, reject) => {
      const tx = db.transaction(SESSION_STORE, "readonly");
      const r = tx.objectStore(SESSION_STORE).get(SESSION_KEY);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    if (!payload) {
      return false;
    }
    const restoredEntries = parseCropNameMappingsFromSession(payload);
    if (!restoredEntries) {
      console.warn("tryRestoreSessionFromIdb: invalid persisted mapping payload, clearing");
      await clearPersistedSession();
      return false;
    }
    cropNameMappingByImageName.clear();
    for (const [name, mapping] of restoredEntries) cropNameMappingByImageName.set(name, mapping);
    return cropNameMappingByImageName.size > 0;
  } catch (e) {
    console.warn("tryRestoreSessionFromIdb", e);
    return false;
  }
}

/**
 * Single-flight restore of saved filename → crop mappings from IndexedDB.
 * The file-input handler must `await` this before `offerCropMappingReapply`, otherwise a fast
 * picker selection can run while the map is still empty and saved crops never reapply.
 */
const cropMappingsSessionRestorePromise = tryRestoreSessionFromIdb();

const fileInput = document.getElementById("file-input");
const fileSummary = document.getElementById("file-summary");
const previewGrid = document.getElementById("preview-grid");
/** Fixed margin around detected subject (was 10% on the removed setup slider). */
const PADDING_FRAC = 0.1;
const btnCrop = document.getElementById("btn-crop");
const btnShareInat = document.getElementById("btn-share-inat");
const progressLine = document.getElementById("progress-line");
const progressBar = document.getElementById("progress-bar");
const progressFill = document.getElementById("progress-fill");
const errorLine = document.getElementById("error-line");
const sessionPersistWarning = document.getElementById("session-persist-warning");
const uploadWarningsDialog = document.getElementById("inat-upload-warnings-dialog");
const uploadWarningsBody = document.getElementById("inat-upload-warnings-body");
const btnInatUploadWarningsUpload = document.getElementById("btn-inat-upload-warnings-upload");
const btnInatUploadWarningsBack = document.getElementById("btn-inat-upload-warnings-back");
const inatLocationPickerDialog = document.getElementById("inat-location-picker-dialog");
const inatLocationMapEl = document.getElementById("inat-location-map");
const inatLocLatInput = document.getElementById("inat-loc-lat");
const inatLocLonInput = document.getElementById("inat-loc-lon");
const btnInatLocationUseDevice = document.getElementById("btn-inat-location-use-device");
const btnInatLocationClear = document.getElementById("btn-inat-location-clear");
const btnInatLocationApply = document.getElementById("btn-inat-location-apply");
const btnInatLocationCancel = document.getElementById("btn-inat-location-cancel");
const inatCvResultsDialog = document.getElementById("inat-cv-results-dialog");
const inatCvResultsPre = document.getElementById("inat-cv-results-pre");
const btnInatCvResultsClose = document.getElementById("btn-inat-cv-results-close");
const btnInatCvResultsCopy = document.getElementById("btn-inat-cv-results-copy");
const sharePrepProgress = document.getElementById("share-prep-progress");
const sharePrepLine = document.getElementById("share-prep-line");
const sharePrepBar = document.getElementById("share-prep-bar");
const sharePrepFill = document.getElementById("share-prep-fill");
const exportFooterBar = document.getElementById("export-footer-bar");
const zipDownloadPanel = document.getElementById("zip-download-panel");
const zipDownloadLine = document.getElementById("zip-download-line");
const zipDownloadBar = document.getElementById("zip-download-bar");
const zipDownloadFill = document.getElementById("zip-download-fill");
const pageSetup = document.getElementById("page-setup");
const pageCrop = document.getElementById("page-crop");
const pageExport = document.getElementById("page-export");
const btnStartOver = document.getElementById("btn-start-over");
const inatUploadSection = document.getElementById("inat-upload-section");
const inatUploadStatus = document.getElementById("inat-upload-status");
const inatUploadTokenField = document.getElementById("inat-upload-token-field");
const inatUploadToken = document.getElementById("inat-upload-token");
const btnInatUploadTokenApply = document.getElementById("btn-inat-upload-token-apply");
const btnInatUploadTokenClear = document.getElementById("btn-inat-upload-token-clear");
const inatUploadGrouping = document.getElementById("inat-upload-grouping");
const inatUploadGroupingStrip = document.getElementById("inat-upload-grouping-strip");
const btnInatCvAll = document.getElementById("btn-inat-cv-all");
const inatUploadProgressWrap = document.getElementById("inat-upload-progress-wrap");
const inatUploadProgressLine = document.getElementById("inat-upload-progress-line");
const inatUploadProgressBar = document.getElementById("inat-upload-progress-bar");
const inatUploadProgressFill = document.getElementById("inat-upload-progress-fill");
const btnInatUploadObs = document.getElementById("btn-inat-upload-obs");
/** Set while the crop review toolbar is mounted (progress lives in `.crop-toolbar__progress`). */
let cropToolbarProgressEl = null;
/** `GET /users/me` succeeded with stored JWT — enables Upload to iNaturalist. */
let inatUploadAuthOk = false;
let inatUploadInProgress = false;
/** True while running computer vision across every observation row (blocks upload / per-row Vision). */
let inatBulkCvInProgress = false;
/** Signed-in iNaturalist user id from `users/me` (preferred for observation queries). */
let inatMeUserId = 0;
/** Login from `users/me` when `id` is missing — fallback `user_login=` on observations API. */
let inatMeLogin = "";
/** `Math.floor(Date.parse(time_observed_at) / 1000)` for the signed-in user's fetched observations. */
let inatExistingObservedSecondsSet = /** @type {Set<number>} */ (new Set());
let inatExistingObsSecondsFetchedAt = 0;
let inatObservedCollisionTimer = 0;
/** `workItems` signature when `inatPhotoObservedCollisionFlags` was last computed. */
let inatObservedCollisionSig = "";
/** Per work-item index: photo observed instant matches an existing observation (same UTC second). */
let inatPhotoObservedCollisionFlags = /** @type {boolean[] | null} */ (null);
/**
 * Each observation group: workItem indices (0..n-1) and per-group species / taxon for iNat create.
 * @type {{ indices: number[], species: string, taxonId: string }[]}
 */
let inatUploadGroups = [];
/** Last `workItems.length` used to build `inatUploadGroups` — mismatch triggers re-init. */
let inatUploadGroupsInitializedForN = -1;
let inatSpeciesDebounceTimer = 0;
/** @type {HTMLElement | null} */
let inatSpeciesSuggestActiveCard = null;
let inatSpeciesSuggestHighlight = -1;
let inatSpeciesSelectingProgrammatic = false;
let inatUploadGroupingDelegated = false;
/** Max duration (ms) for a release that still counts as a quick tap to open crop (below long-hold drag). */
const INAT_STRIP_SHORT_TAP_MAX_MS = 320;
/** Hold this long on a thumbnail to arm drag-and-drop without opening crop on release. */
const INAT_STRIP_LONG_HOLD_MS = 450;
const INAT_STRIP_TAP_SLOP_SQ = 12 * 12;
/**
 * Active primary-pointer gesture on an iNat grouping thumbnail (quick tap opens crop; long hold is for drag).
 * @type {{ photoIdx: number, downTs: number, x0: number, y0: number, pointerId: number, longArmed: boolean, dragDid: boolean, movedPastSlop: boolean } | null}
 */
let inatStripTileGesture = null;
let inatStripTileLongHoldTimer = 0;

function clearInatStripTileLongHoldTimer() {
  if (inatStripTileLongHoldTimer !== 0) {
    clearTimeout(inatStripTileLongHoldTimer);
    inatStripTileLongHoldTimer = 0;
  }
}

function inatStripTileGlobalPointerMove(e) {
  if (!inatStripTileGesture || e.pointerId !== inatStripTileGesture.pointerId) return;
  const g = inatStripTileGesture;
  const dx = e.clientX - g.x0;
  const dy = e.clientY - g.y0;
  if (!g.movedPastSlop && dx * dx + dy * dy >= INAT_STRIP_TAP_SLOP_SQ) {
    g.movedPastSlop = true;
    clearInatStripTileLongHoldTimer();
  }
}

function inatStripTileGlobalPointerEnd(e) {
  if (!inatStripTileGesture || e.pointerId !== inatStripTileGesture.pointerId) return;
  const g = inatStripTileGesture;
  const fromCancel = e.type === "pointercancel";
  clearInatStripTileLongHoldTimer();
  window.removeEventListener("pointermove", inatStripTileGlobalPointerMove, true);
  window.removeEventListener("pointerup", inatStripTileGlobalPointerEnd, true);
  window.removeEventListener("pointercancel", inatStripTileGlobalPointerEnd, true);
  inatStripTileGesture = null;

  const elapsed = performance.now() - g.downTs;
  if (!fromCancel && !g.dragDid && !g.longArmed && !g.movedPastSlop && elapsed <= INAT_STRIP_SHORT_TAP_MAX_MS) {
    openInatGroupingCropEditor(g.photoIdx);
  }
}

function resetInatStripTileGesture() {
  clearInatStripTileLongHoldTimer();
  if (inatStripTileGesture) {
    window.removeEventListener("pointermove", inatStripTileGlobalPointerMove, true);
    window.removeEventListener("pointerup", inatStripTileGlobalPointerEnd, true);
    window.removeEventListener("pointercancel", inatStripTileGlobalPointerEnd, true);
    inatStripTileGesture = null;
  }
}

/** Drop zone currently highlighted during an in-flight photo drag. */
let inatDnDDropHighlightEl = null;

/**
 * Find gap vs card photo-drop under the pointer. Uses `elementsFromPoint` so hits work when the
 * cursor is over species/location rows (siblings of `.inat-group-drop`, not inside it).
 * @param {number} clientX
 * @param {number} clientY
 * @returns {{ kind: "gap"; el: Element } | { kind: "card"; dropEl: Element; overTile: Element | null } | null}
 */
function inatResolvePhotoDnDHit(clientX, clientY) {
  const strip = inatUploadGroupingStrip;
  if (!strip) return null;
  try {
    const stack = document.elementsFromPoint(clientX, clientY);
    for (const node of stack) {
      if (!(node instanceof Element) || !strip.contains(node)) continue;
      const gapEl = node.closest(".inat-group-gap-drop");
      if (gapEl) return { kind: "gap", el: gapEl };
    }
    for (const node of stack) {
      if (!(node instanceof Element) || !strip.contains(node)) continue;
      const dropEl = node.closest(".inat-group-drop");
      if (dropEl) {
        let overTile = null;
        for (const n2 of stack) {
          if (!(n2 instanceof Element)) continue;
          const ti = n2.closest(".inat-dnd-tile");
          if (ti && dropEl.contains(ti)) {
            overTile = ti;
            break;
          }
        }
        return { kind: "card", dropEl, overTile };
      }
      const card = node.closest(".inat-group-card");
      if (card) {
        const inner = card.querySelector(".inat-group-drop");
        if (inner) {
          let overTile = null;
          for (const n2 of stack) {
            if (!(n2 instanceof Element)) continue;
            const ti = n2.closest(".inat-dnd-tile");
            if (ti && inner.contains(ti)) {
              overTile = ti;
              break;
            }
          }
          return { kind: "card", dropEl: inner, overTile };
        }
      }
    }
  } catch {
    /* elementsFromPoint can throw in rare cases */
  }
  return null;
}

/** @param {EventTarget | null} target */
function inatFallbackPhotoDnDHitFromTarget(target) {
  if (!(target instanceof Element) || !inatUploadGroupingStrip?.contains(target)) return null;
  const gap = target.closest(".inat-group-gap-drop");
  if (gap) return { kind: "gap", el: gap };
  const drop = target.closest(".inat-group-drop");
  if (drop) return { kind: "card", dropEl: drop, overTile: target.closest(".inat-dnd-tile") };
  const card = target.closest(".inat-group-card");
  if (card) {
    const inner = card.querySelector(".inat-group-drop");
    if (inner) return { kind: "card", dropEl: inner, overTile: target.closest(".inat-dnd-tile") };
  }
  return null;
}

function inatUpdatePhotoDnDHighlightFromPointer(clientX, clientY) {
  const hit = inatResolvePhotoDnDHit(clientX, clientY);
  const drop =
    hit && hit.kind === "gap" ? hit.el : hit && hit.kind === "card" ? hit.dropEl : null;
  if (inatDnDDropHighlightEl === drop) return;
  if (inatDnDDropHighlightEl) {
    inatDnDDropHighlightEl.classList.remove("inat-group-drop--over", "inat-group-gap-drop--over");
  }
  inatDnDDropHighlightEl = drop;
  if (drop) {
    drop.classList.add(drop.classList.contains("inat-group-gap-drop") ? "inat-group-gap-drop--over" : "inat-group-drop--over");
  }
}

function resetInatUploadProgressUi() {
  if (inatUploadProgressWrap) inatUploadProgressWrap.hidden = true;
  if (inatUploadProgressBar) {
    inatUploadProgressBar.hidden = true;
    inatUploadProgressBar.setAttribute("aria-valuenow", "0");
    inatUploadProgressBar.setAttribute("aria-valuetext", "0%");
  }
  if (inatUploadProgressFill) inatUploadProgressFill.style.width = "0%";
  if (inatUploadProgressLine) inatUploadProgressLine.textContent = "";
}

function showInatUploadProgressUi() {
  if (inatUploadProgressWrap) inatUploadProgressWrap.hidden = false;
  if (inatUploadProgressBar) inatUploadProgressBar.hidden = false;
}

/**
 * @param {number} fraction 0..1
 * @param {string} labelText
 */
function setInatUploadProgressUi(fraction, labelText) {
  const clamped = Math.max(0, Math.min(1, fraction));
  const pct = Math.round(clamped * 100);
  if (inatUploadProgressLine) inatUploadProgressLine.textContent = labelText;
  if (inatUploadProgressFill) inatUploadProgressFill.style.width = `${pct}%`;
  if (inatUploadProgressBar) {
    inatUploadProgressBar.setAttribute("aria-valuenow", String(pct));
    inatUploadProgressBar.setAttribute("aria-valuetext", `${pct}%`);
  }
}

const PREVIEW_MAX_EDGE = 720;
const PREVIEW_MAX_EDGE_IOS = 520;
/** Run COCO-SSD on a downscaled copy so large photos do not spike WebGL / RAM. Bboxes are mapped back to full resolution. */
const DETECTION_MAX_EDGE = 1280;
/**
 * Max CSS pixel edge for the live crop image layer. Above this, the bitmap is kept smaller and scaled up with
 * `transform: scale` so pan/zoom stays on a bounded compositor surface (full-res CSS sizes are brutal on large photos).
 */
const CROP_VIEWPORT_MAX_DISPLAY_EDGE = isIOSOrIPadOS() ? 1920 : 2560;

/**
 * When painting a prefetched `ImageBitmap` into the editor canvas, cap the longest edge so we do not allocate
 * a full 40–60MP canvas while still mapping layout in full-resolution crop coordinates.
 */
const CROP_EDITOR_BITMAP_DRAW_MAX_EDGE = 2816;
const CROP_EDITOR_BITMAP_DRAW_MAX_EDGE_IOS = 1920;

/** @type {Awaited<ReturnType<typeof cocoSsd.load>> | null} */
let model = null;
/** @type {Promise<NonNullable<typeof model>> | null} */
let modelPromise = null;
/** @type {File[]} */
let workItems = [];
let previewObjectUrls = [];
/** One blob URL per batch file (reuse when building editor — avoids duplicate `createObjectURL` on advance). */
const filePreviewUrlByKey = new Map();
/** Pre-decoded `ImageBitmap` for upcoming stills — faster than `<img>` decode when advancing the crop queue. */
const cropPreviewBitmapByKey = new Map();
let previewGeneration = 0;
/** @type {File[]} */
let lastShareInatFiles = [];
/** Parallel to `lastShareInatFiles`: original `File` from the batch (for re-encoding non-JPEG “full original” exports as JPEG for Share). */
let lastShareInatSourceFiles = [];

/** Capture time (ms) per `workItems` index — burst grouping for iNaturalist upload. */
let workItemCaptureTimesMs = null;
/** Square-crop preview URLs for grouping thumbnails (`fileCacheKey` → object URL). */
const inatGroupingThumbUrlByKey = new Map();
/** Forward (ZIP) index of photo opened from grouping for single-photo crop edit; −1 when not in that mode. */
let inatGroupEditForwardIndex = -1;

const INAT_TIME_CLUSTER_WINDOW_MS = 30_000;

/**
 * JPEG `File`s ready for `navigator.share({ files })` — built when the user taps Share (on demand).
 * `null` = not prepared since last invalidation; `[]` = prepared but nothing shareable.
 * @type {File[] | null}
 */
let shareSheetReadyFiles = null;
/** Bumps when starting a new prep so stale async work does not flip state. */
let shareSheetPrepareGen = 0;
/** True while share JPEGs are being encoded after the user taps Share. */
let shareSheetPrepRunning = false;
/** Progress text / bar while building JPEGs for Share (export page). */
let sharePrepStatusText = "";
let shareSheetBuildIndex = 0;
let shareSheetBuildTotal = 0;

/**
 * Sequential crop review (newest → oldest in `workItems` order). ZIP/export still uses `workItems`
 * oldest → newest. Offset from the **newest** slot: 0 = last array element.
 */
let cropReviewIndex = 0;
/** @type {Set<string>} */
const cropReviewDoneKeys = new Set();

/** @type {Map<string, string>} */
const previewSlotErrors = new Map();

/** @type {ReturnType<typeof setInterval> | null} */
let modelLoadElapsedTimer = null;
let modelLoadStageText = "";
let modelWeightShardTotal = 0;
let modelWeightShardsDone = 0;

/** Keys still in the background analysis queue (user may see "Analyzing…" until done). */
const analysisPendingKeys = new Set();

let cropZoomSliderIdSeq = 0;

/**
 * Per-image crop state (geometry + metadata only — no decoded bitmaps; export re-decodes from `File`).
 * When `hasCrop` is false, `savedSquareCrop` may hold `{ left, top, side }` for toggling back to square crop.
 * @type {Map<string, { left: number, top: number, side: number, w: number, h: number, hasCrop: boolean, det: object|null, savedSquareCrop?: { left: number, top: number, side: number } }>}
 */
const cropState = new Map();

/**
 * Optional cache of encoded export payloads (large batches skip this and build on demand for ZIP to save RAM).
 * Keyed by `fileCacheKey`. `refreshWorkItemsCaptureOrder()` may reorder files; filenames are applied at ZIP build time.
 * @type {Map<string, { kind: 'crop', blob: Blob, meta: Awaited<ReturnType<typeof extractMetaForEmbedding>>, sourceFile: File } | { kind: 'original', sourceFile: File, meta: Awaited<ReturnType<typeof extractMetaForEmbedding>>, mime: string } | { kind: 'fail' }>}
 */
const exportPrepCache = new Map();
/** In-flight prep so we do not duplicate work for the same key. */
const exportPrepInflight = new Map();
/** Serializes background `buildExportPayloadForKey` work so many ✓ in a row do not decode dozens of full-res images at once. */
let exportPrepBackgroundChain = Promise.resolve();

let zipDownloadInProgress = false;

/** Minimum detector score to accept a crop (fixed at 0 = any detection). */
const MIN_DETECTION_SCORE = 0;

/**
 * Persisted per-name mapping:
 * `name -> { crop: {left, top, side, w, h, hasCrop, savedSquareCrop?}, deleted, accepted }`
 * @type {Map<string, { crop: { left: number, top: number, side: number, w: number, h: number, hasCrop: boolean, savedSquareCrop?: { left: number, top: number, side: number } } | null, deleted: boolean, accepted: boolean }>}
 */
const cropNameMappingByImageName = new Map();
/** Upload-scoped mappings chosen by the user for reapply. */
let pendingReapplyMappingsByImageName = new Map();

function normalizeImageNameForMapping(name) {
  return String(name || "").trim().toLowerCase();
}

function toFiniteNumber(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function sanitizeSquareCropArea(area) {
  if (!area || typeof area !== "object") return null;
  const hasCrop = area.hasCrop !== false;
  const w = Math.max(1, Math.round(toFiniteNumber(area.w, 0)));
  const h = Math.max(1, Math.round(toFiniteNumber(area.h, 0)));
  let left = Math.round(toFiniteNumber(area.left, 0));
  let top = Math.round(toFiniteNumber(area.top, 0));
  let side = Math.round(toFiniteNumber(area.side, Math.min(w, h)));
  const maxSide = Math.max(1, Math.min(w, h));
  side = Math.max(1, Math.min(side, maxSide));
  left = Math.max(0, Math.min(left, w - side));
  top = Math.max(0, Math.min(top, h - side));
  /** `hasCrop:false` keeps original; square is retained for “toggle back to crop”. */
  const out = { left, top, side, w, h, hasCrop };
  const sq = area.savedSquareCrop;
  if (sq && typeof sq === "object") {
    const sqSide = Math.max(1, Math.min(Math.round(toFiniteNumber(sq.side, side)), maxSide));
    const sqLeft = Math.max(0, Math.min(Math.round(toFiniteNumber(sq.left, left)), w - sqSide));
    const sqTop = Math.max(0, Math.min(Math.round(toFiniteNumber(sq.top, top)), h - sqSide));
    out.savedSquareCrop = { left: sqLeft, top: sqTop, side: sqSide };
  }
  return out;
}

function mappingCropFromState(st) {
  if (!st || typeof st !== "object") return null;
  const out = sanitizeSquareCropArea({
    left: st.left,
    top: st.top,
    side: st.side,
    w: st.w,
    h: st.h,
    hasCrop: st.hasCrop !== false,
    savedSquareCrop: st.savedSquareCrop,
  });
  return out;
}

function stateFromMappingCrop(crop) {
  const area = sanitizeSquareCropArea(crop);
  if (!area) return null;
  const st = {
    left: area.left,
    top: area.top,
    side: area.side,
    w: area.w,
    h: area.h,
    hasCrop: area.hasCrop !== false,
    det: null,
  };
  if (area.savedSquareCrop) st.savedSquareCrop = { ...area.savedSquareCrop };
  return st;
}

function getMappingForFile(file, sourceMap) {
  const src = sourceMap || cropNameMappingByImageName;
  const name = normalizeImageNameForMapping(file && file.name);
  if (!name) return null;
  const m = src.get(name);
  return m && typeof m === "object" ? m : null;
}

function upsertCropNameMapping(file, cropStateValue, options) {
  const key = normalizeImageNameForMapping(file && file.name);
  if (!key) return;
  const opts = options || {};
  const prev = cropNameMappingByImageName.get(key);
  const next = {
    crop: mappingCropFromState(cropStateValue) || (prev && prev.crop ? prev.crop : null),
    deleted: Boolean(opts.deleted),
    accepted: Boolean(opts.accepted),
  };
  cropNameMappingByImageName.set(key, next);
  if (opts.persist !== false) markSessionPersistDirty();
}

function setCropStateForFileAndPersist(file, state, options) {
  const opts = options || {};
  const key = fileCacheKey(file);
  if (state && state.hasCrop !== false) {
    enforceMinCropSideOnState(state);
  }
  cropState.set(key, state);
  upsertCropNameMapping(file, state, {
    deleted: false,
    accepted: Boolean(opts.accepted),
    persist: opts.persist,
  });
}

function markMappingDeletedByFile(file, options) {
  const opts = options || {};
  const key = normalizeImageNameForMapping(file && file.name);
  if (!key) return;
  const prev = cropNameMappingByImageName.get(key);
  cropNameMappingByImageName.set(key, {
    crop: prev && prev.crop ? prev.crop : null,
    deleted: true,
    accepted: false,
  });
  if (opts.persist !== false) markSessionPersistDirty();
}

function markMappingAcceptedByFile(file, accepted, options) {
  const opts = options || {};
  const key = fileCacheKey(file);
  const st = cropState.get(key);
  if (!st) return;
  upsertCropNameMapping(file, st, {
    deleted: false,
    accepted: Boolean(accepted),
    persist: opts.persist,
  });
}

function serializeCropNameMappingsForSession() {
  const out = [];
  for (const [name, mapping] of cropNameMappingByImageName.entries()) {
    if (!name || !mapping || typeof mapping !== "object") continue;
    out.push({
      name,
      deleted: Boolean(mapping.deleted),
      accepted: Boolean(mapping.accepted),
      crop: mapping.crop ? sanitizeSquareCropArea(mapping.crop) : null,
    });
  }
  return out;
}

function parseCropNameMappingsFromSession(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (Number(payload.v) !== 1) return null;
  if (!Array.isArray(payload.entries)) return null;
  const out = [];
  for (const item of payload.entries) {
    if (!item || typeof item !== "object") continue;
    const name = normalizeImageNameForMapping(item.name);
    if (!name) continue;
    const crop = item.crop ? sanitizeSquareCropArea(item.crop) : null;
    out.push([
      name,
      {
        crop,
        deleted: Boolean(item.deleted),
        accepted: Boolean(item.accepted),
      },
    ]);
  }
  return out;
}

function remapSquareToImageDims(square, srcW, srcH, dstW, dstH) {
  if (!square || !srcW || !srcH || !dstW || !dstH) return null;
  const srcMin = Math.max(1, Math.min(srcW, srcH));
  const dstMin = Math.max(1, Math.min(dstW, dstH));
  const sideRatio = Math.max(1 / srcMin, toFiniteNumber(square.side, srcMin) / srcMin);
  const side = Math.max(1, Math.round(sideRatio * dstMin));
  const cx = (toFiniteNumber(square.left, 0) + toFiniteNumber(square.side, side) / 2) / srcW;
  const cy = (toFiniteNumber(square.top, 0) + toFiniteNumber(square.side, side) / 2) / srcH;
  const left = Math.round(cx * dstW - side / 2);
  const top = Math.round(cy * dstH - side / 2);
  return sanitizeSquareCropArea({ left, top, side, w: dstW, h: dstH, hasCrop: true });
}

async function buildReappliedStateForFile(file, mapping) {
  if (!mapping || !mapping.crop) return null;
  const mapped = stateFromMappingCrop(mapping.crop);
  if (!mapped) return null;
  let dstW = mapped.w;
  let dstH = mapped.h;

  const fastDims = await tryGetOrientedPixelSizeFromFile(file);
  if (fastDims && fastDims.w > 0 && fastDims.h > 0) {
    dstW = fastDims.w;
    dstH = fastDims.h;
    if (mapped.w === dstW && mapped.h === dstH) return mapped;
  }

  try {
    const raw = await decodeForPipeline(file);
    dstW = raw.w;
    dstH = raw.h;
    disposeDecodedBundle(raw);
  } catch {
    /* fallback to fastDims or stored mapping dimensions */
    if (fastDims && fastDims.w > 0 && fastDims.h > 0) {
      dstW = fastDims.w;
      dstH = fastDims.h;
    }
  }
  if (!dstW || !dstH) return mapped;
  if (mapped.w === dstW && mapped.h === dstH) return mapped;
  const remapped = remapSquareToImageDims(mapped, mapped.w, mapped.h, dstW, dstH);
  if (!remapped) return mapped;
  const next = {
    left: remapped.left,
    top: remapped.top,
    side: remapped.side,
    w: remapped.w,
    h: remapped.h,
    hasCrop: mapped.hasCrop !== false,
    det: null,
  };
  if (mapped.savedSquareCrop) {
    const sq = remapSquareToImageDims(mapped.savedSquareCrop, mapped.w, mapped.h, dstW, dstH);
    if (sq) next.savedSquareCrop = { left: sq.left, top: sq.top, side: sq.side };
  }
  if (next.hasCrop === false && !next.savedSquareCrop) {
    next.savedSquareCrop = { left: remapped.left, top: remapped.top, side: remapped.side };
  }
  return next;
}

/** Lets the browser paint progress updates between heavy decode steps. */
async function yieldToMainForUi() {
  await new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 0);
    }
  });
}

/**
 * Build filename → saved mapping entries for files in this batch. Mappings are applied automatically
 * after the user picks photos (no confirmation dialog).
 * @param {File[]} files
 */
function offerCropMappingReapply(files) {
  if (!Array.isArray(files) || !files.length) return new Map();
  const matches = new Map();
  for (const file of files) {
    const name = normalizeImageNameForMapping(file && file.name);
    if (!name) continue;
    const mapping = cropNameMappingByImageName.get(name);
    if (!mapping) continue;
    matches.set(name, mapping);
  }
  return matches;
}

/**
 * @param {string} bodyText
 * @returns {Promise<boolean>} `true` when the user chooses **Upload anyway**.
 */
function showInatUploadWarningsDialog(bodyText) {
  if (!uploadWarningsDialog || !uploadWarningsBody || !btnInatUploadWarningsUpload || !btnInatUploadWarningsBack) {
    return Promise.resolve(
      window.confirm(`${bodyText}\n\nOK = upload anyway, Cancel = go back and fix issues.`)
    );
  }
  uploadWarningsBody.textContent = bodyText;
  uploadWarningsDialog.hidden = false;
  const backdrop = uploadWarningsDialog.querySelector(".reapply-dialog__backdrop");
  return new Promise((resolve) => {
    const finish = (/** @type {boolean} */ upload) => {
      btnInatUploadWarningsUpload.removeEventListener("click", onUpload);
      btnInatUploadWarningsBack.removeEventListener("click", onBack);
      document.removeEventListener("keydown", onKey, true);
      if (backdrop) backdrop.removeEventListener("click", onBackDrop);
      uploadWarningsDialog.hidden = true;
      resolve(upload);
    };
    const onUpload = () => finish(true);
    const onBack = () => finish(false);
    const onBackDrop = () => finish(false);
    /** @param {KeyboardEvent} e */
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      }
    };
    btnInatUploadWarningsUpload.addEventListener("click", onUpload);
    btnInatUploadWarningsBack.addEventListener("click", onBack);
    document.addEventListener("keydown", onKey, true);
    if (backdrop) backdrop.addEventListener("click", onBackDrop);
    try {
      btnInatUploadWarningsBack.focus();
    } catch {
      /* ignore */
    }
  });
}

async function applySavedCropMappingForCurrentBatch(totalFilesForUi) {
  let applied = 0;
  let accepted = 0;
  let deleted = 0;
  const reappliedKeys = new Set();
  const reapplyFailures = [];
  if (!pendingReapplyMappingsByImageName.size || !workItems.length) {
    return { applied, accepted, deleted, reappliedKeys, reapplyFailures };
  }
  let decodeTotal = 0;
  for (const file of workItems) {
    const mapping = getMappingForFile(file, pendingReapplyMappingsByImageName);
    if (mapping && !mapping.deleted && mapping.crop) decodeTotal++;
  }
  let decodeDone = 0;
  const nextWorkItems = [];
  for (const file of workItems) {
    const dispName = (file && file.name) || "photo";
    const mapping = getMappingForFile(file, pendingReapplyMappingsByImageName);
    if (!mapping) {
      nextWorkItems.push(file);
      continue;
    }
    if (mapping.deleted) {
      deleted++;
      continue;
    }
    if (mapping.crop && decodeTotal > 0) {
      decodeDone++;
      const pct = Math.min(99, ((decodeDone - 0.5) / decodeTotal) * 100);
      setProgress(true, pct, `Applying saved crops · ${decodeDone} / ${decodeTotal}`, {
        indeterminate: false,
      });
      if (fileSummary) {
        fileSummary.textContent = `Preparing · ${totalFilesForUi} photo(s) · saved crops ${decodeDone}/${decodeTotal}`;
      }
      if (decodeDone === 1 || decodeDone === decodeTotal || (decodeDone & 3) === 0) {
        await yieldToMainForUi();
      }
    }
    let nextState = null;
    try {
      nextState = await buildReappliedStateForFile(file, mapping);
    } catch (e) {
      console.warn("applySavedCropMappingForCurrentBatch: remap failed", e);
      reapplyFailures.push({ name: dispName, err: e });
      nextState = null;
    }
    if (!nextState) {
      nextWorkItems.push(file);
      continue;
    }
    nextWorkItems.push(file);
    setCropStateForFileAndPersist(file, nextState, { accepted: Boolean(mapping.accepted), persist: false });
    const key = fileCacheKey(file);
    reappliedKeys.add(key);
    if (mapping.accepted) {
      accepted++;
    }
    /** Saved “accepted” only affects persistence metadata — each batch still goes through per-photo review. */
    cropReviewDoneKeys.delete(key);
    applied++;
  }
  workItems = nextWorkItems;
  if (reapplyFailures.length) {
    const sample = reapplyFailures
      .slice(0, 3)
      .map((f) => `${f.name}: ${errorDetailForUser(f.err, 100)}`)
      .join(" · ");
    const more =
      reapplyFailures.length > 3 ? ` (+${reapplyFailures.length - 3} more)` : "";
    showError(
      `${reapplyFailures.length} saved crop${reapplyFailures.length === 1 ? "" : "s"} could not be remapped — those photos will be analyzed normally. ${sample}${more}`,
      reapplyFailures[0] && reapplyFailures[0].err
    );
  }
  return { applied, accepted, deleted, reappliedKeys, reapplyFailures };
}

/**
 * Large batches: aggressive preview prefetch limits + do not retain export payloads in RAM after each encode.
 * Below the threshold we still skip caching full original `ArrayBuffer` exports (they duplicate whole files in RAM).
 */
function heavyBatchMode() {
  return workItems.length >= memoryPressureThreshold();
}

function fileCacheKey(file) {
  return `${file.name}\0${file.size}\0${file.lastModified}`;
}

function clearCropState() {
  bumpPrefetchToken();
  for (const bm of cropPreviewBitmapByKey.values()) {
    try {
      bm.close();
    } catch { /* ignore */ }
  }
  cropPreviewBitmapByKey.clear();
  cropState.clear();
  cropReviewIndex = 0;
  cropReviewDoneKeys.clear();
  previewSlotErrors.clear();
  analysisPendingKeys.clear();
  exportPrepCache.clear();
  exportPrepInflight.clear();
  exportPrepBackgroundChain = Promise.resolve();
  shareSheetReadyFiles = null;
  shareSheetPrepareGen++;
  shareSheetPrepRunning = false;
  sharePrepStatusText = "";
  shareSheetBuildIndex = 0;
  shareSheetBuildTotal = 0;
  setSharePrepProgress(false, 0, "", {});
  clearSessionPersistNotice();
  inatUploadGroups = [];
  inatUploadGroupsInitializedForN = -1;
  hideInatLocationPickerDialog();
  hideInatCvResultsDialog();
  hideAllInatGroupSpeciesSuggests();
  clearInatDnDDropHighlight();
  workItemCaptureTimesMs = null;
  inatGroupEditForwardIndex = -1;
  for (const u of inatGroupingThumbUrlByKey.values()) {
    try {
      URL.revokeObjectURL(u);
    } catch {
      /* ignore */
    }
    const pi = previewObjectUrls.indexOf(u);
    if (pi >= 0) previewObjectUrls.splice(pi, 1);
  }
  inatGroupingThumbUrlByKey.clear();
  resetInatObservedTimeCollisionState();
}

function invalidateShareSheetPrep() {
  shareSheetReadyFiles = null;
  shareSheetPrepareGen++;
  shareSheetPrepRunning = false;
  sharePrepStatusText = "";
  shareSheetBuildIndex = 0;
  shareSheetBuildTotal = 0;
  setSharePrepProgress(false, 0, "", {});
}

function isCropReviewFinished() {
  if (!workItems.length) return false;
  return workItems.every((f) => cropReviewDoneKeys.has(fileCacheKey(f)));
}

/** Remove analysis-pending markers for files no longer in the batch (e.g. after delete). */
function pruneAnalysisPendingKeysToWorkItems() {
  const valid = new Set(workItems.map((f) => fileCacheKey(f)));
  for (const k of [...analysisPendingKeys]) {
    if (!valid.has(k)) analysisPendingKeys.delete(k);
  }
}

/**
 * `workItems` stays forward-chronological (oldest → newest) for ZIP / export metadata.
 * Crop UI walks **newest → oldest**: `cropReviewIndex` is the offset from the **last** array slot
 * (0 = newest, length-1 = oldest).
 */
function syncCropReviewIndex() {
  if (!workItems.length) {
    cropReviewIndex = 0;
    return;
  }
  for (let i = workItems.length - 1; i >= 0; i--) {
    if (!cropReviewDoneKeys.has(fileCacheKey(workItems[i]))) {
      cropReviewIndex = workItems.length - 1 - i;
      return;
    }
  }
  cropReviewIndex = Math.max(0, workItems.length - 1);
}

/** Oldest-first index of the photo currently shown in the crop editor. */
function cropItemForwardIndex() {
  const n = workItems.length;
  if (!n) return 0;
  return Math.max(0, Math.min(n - 1 - cropReviewIndex, n - 1));
}

function updateCropReviewChrome() {
  const n = workItems.length;
  const el = cropToolbarProgressEl;
  if (!el) return;
  if (!n || !pageCrop || pageCrop.hidden) {
    el.textContent = "0 / 0";
    return;
  }
  if (isCropReviewFinished()) {
    el.textContent = `${n} / ${n}`;
    return;
  }
  /** Newest-first slot: `cropReviewIndex` 0 = newest → show as image 1 of n. */
  const pos = Math.min(cropReviewIndex + 1, n);
  el.textContent = `${pos} / ${n}`;
}

/**
 * Move crop review to another photo without accepting the current one.
 * Review order is newest → oldest (`cropReviewIndex` 0 = newest in `workItems`).
 * @param {-1 | 1} dir -1 = newer photo, +1 = older photo
 */
function navigateCropReview(dir) {
  const n = workItems.length;
  if (n <= 1 || (dir !== -1 && dir !== 1)) return;
  const next = cropReviewIndex + dir;
  if (next < 0 || next > n - 1) return;
  cropReviewIndex = next;
  renderCropEditorSlot();
  updateCropReviewChrome();
  updateButtons();
}

/**
 * Wizard pages: setup → crop (editor) → export (ZIP / Share after review).
 * @param {"setup" | "crop" | "export"} name
 */
function setCurrentPage(name) {
  if (pageSetup) pageSetup.hidden = name !== "setup";
  if (pageCrop) pageCrop.hidden = name !== "crop";
  if (pageExport) pageExport.hidden = name !== "export";
  if (name === "export") void refreshInatUploadAuthUi();
}

/**
 * Renders the single-image crop slot (no scrolling list).
 */
function renderCropEditorSlot() {
  try {
    previewGrid.replaceChildren();
    if (!workItems.length) return;

    if (isCropReviewFinished()) {
      previewGrid.replaceChildren();
      updateCropReviewChrome();
      return;
    }

    scheduleCropPreviewPrefetch();

    const idx = cropItemForwardIndex();
    const file = workItems[idx];
    const key = fileCacheKey(file);
    const err = previewSlotErrors.get(key);
    const state = cropState.get(key);

    if (err && !state) {
      const row = document.createElement("article");
      row.className = "preview-row preview-row--error";
      row.dataset.fileKey = key;
      row.setAttribute("aria-label", `Error: ${String(err).slice(0, 200)}`);
      attachBatchRowActions(row, file, { variant: "error", showNextCheck: true });
      previewGrid.appendChild(row);
      updateCropReviewChrome();
      return;
    }

    if (!state) {
      if (analysisPendingKeys.has(key)) {
        const row = buildAnalyzingPendingRow(file);
        previewGrid.appendChild(row);
        updateCropReviewChrome();
        return;
      }
      const row = document.createElement("article");
      row.className = "preview-row preview-row--error";
      row.dataset.fileKey = key;
      row.setAttribute("aria-label", "No crop data for this photo");
      attachBatchRowActions(row, file, { variant: "error", showNextCheck: true });
      previewGrid.appendChild(row);
      updateCropReviewChrome();
      return;
    }

    let row;
    if (!state.hasCrop) {
      row = buildOriginalOnlyRow(file, { showNextCheck: true, minimalChrome: true });
    } else {
      try {
        row = buildCropEditor(file, state, state.reviewNote || null, { showNextCheck: true, minimalChrome: true });
      } catch (e) {
        console.error("buildCropEditor", e);
        previewSlotErrors.set(key, String(e && e.message ? e.message : e));
        const errRow = document.createElement("article");
        errRow.className = "preview-row preview-row--error";
        errRow.dataset.fileKey = key;
        errRow.setAttribute("aria-label", "Preview failed — try again or delete");
        attachBatchRowActions(errRow, file, { variant: "error", showNextCheck: true });
        previewGrid.appendChild(errRow);
        updateCropReviewChrome();
        showError("Couldn’t show this image. Try Continue or delete the file.");
        return;
      }
    }
    previewGrid.appendChild(row);
    updateCropReviewChrome();
  } catch (e) {
    console.error("renderCropEditorSlot", e);
    const d = errorDetailForUser(e);
    showError(
      d
        ? `Couldn’t load the crop editor: ${d} Try refreshing the page — your progress may be restored.`
        : "Couldn’t load the crop editor. Try refreshing the page — your progress may be restored.",
      e
    );
  }
}

function advanceCropReview() {
  if (!workItems.length || isCropReviewFinished()) return;
  const file = workItems[cropItemForwardIndex()];
  if (!file) return;
  const confirmedKey = fileCacheKey(file);
  cropReviewDoneKeys.add(confirmedKey);
  markMappingAcceptedByFile(file, true);
  queueExportPrepForKey(confirmedKey);
  syncCropReviewIndex();
  if (isCropReviewFinished()) {
    renderCropEditorSlot();
    void (async () => {
      try {
        await rebuildInatGroupingThumbNow(file);
      } catch {
        /* ignore — export strip will still queue ensureInatGroupingThumbUrl */
      }
      setCurrentPage("export");
      updateButtons();
      schedulePersistSession();
    })();
    return;
  }
  renderCropEditorSlot();
  updateButtons();
  schedulePersistSession();
}

/**
 * After a photo is checked off, decode/crop/encode in the background when possible.
 * Large batches still run this path; `buildExportPayloadForKey` avoids retaining blobs in RAM.
 */
function queueExportPrepForKey(key) {
  if (exportPrepCache.has(key) || exportPrepInflight.has(key)) return;
  exportPrepBackgroundChain = exportPrepBackgroundChain.then(async () => {
    if (exportPrepCache.has(key) || exportPrepInflight.has(key)) return;
    const p = buildExportPayloadForKey(key)
      .catch((e) => {
        console.warn("Background export prep failed", e);
        if (workItems.some((f) => fileCacheKey(f) === key)) exportPrepCache.set(key, { kind: "fail" });
      })
      .finally(() => {
        exportPrepInflight.delete(key);
      });
    exportPrepInflight.set(key, p);
    try {
      await p;
    } catch {
      /* surfaced in catch above */
    }
  });
}

/**
 * @returns {Promise<{ kind: 'crop', blob: Blob, meta: object, sourceFile: File } | { kind: 'original', sourceFile: File, meta: object, mime: string } | { kind: 'fail' } | undefined>}
 */
async function buildExportPayloadForKey(key) {
  const file = workItems.find((f) => fileCacheKey(f) === key);
  if (!file) return;
  const state = cropState.get(key);
  const meta = await extractMetaForEmbedding(file);

  if (!state || !state.hasCrop) {
    let lastMs = meta.lastModified;
    const mime = (file.type || "").toLowerCase();
    const looksJpeg = mime === "image/jpeg" || mime === "image/jpg" || /\.jpe?g$/i.test(file.name || "");
    if (looksJpeg) {
      const fromEmb = await lastModifiedMsFromJpegBlob(file);
      if (fromEmb != null) lastMs = fromEmb;
    }
    const metaOut = { ...meta, lastModified: lastMs };
    const prep = { kind: "original", sourceFile: file, meta: metaOut, mime: file.type || "application/octet-stream" };
    /** Avoid `file.arrayBuffer()` — ZIP/Share can stream from the `File` without duplicating the whole image in RAM. */
    return prep;
  }

  const heavyBatch = heavyBatchMode();

  let source = state.source;
  let closeSource = null;
  if (!source || (typeof source.close === "function" && source.width === 0)) {
    const decoded = await decodeForPipeline(file);
    source = decoded.source;
    closeSource = decoded.close;
  }
  try {
    const crop = { left: state.left, top: state.top, side: state.side };
    let blob = await cropSourceToBlob(source, crop, CROP_EXPORT_FORMAT);
    const outSide = Math.max(1, Math.round(crop.side));
    blob = await attachMetadataToCroppedJpeg(file, blob, outSide, outSide);
    let lastMs = meta.lastModified;
    const fromEmb = await lastModifiedMsFromJpegBlob(blob);
    if (fromEmb != null) lastMs = fromEmb;
    const metaOut = { ...meta, lastModified: lastMs };
    const prep = { kind: "crop", blob, meta: metaOut, sourceFile: file };
    if (workItems.some((f) => fileCacheKey(f) === key) && !heavyBatch) {
      exportPrepCache.set(key, prep);
    }
    return prep;
  } finally {
    if (closeSource) closeSource();
  }
}

/** Wait for background prep if running; build now if missing or failed. */
async function ensureExportPrepReady(key) {
  const inflight = exportPrepInflight.get(key);
  if (inflight) {
    try {
      await inflight;
    } catch { /* buildExportPayloadForKey sets fail */ }
  }
  let prep = exportPrepCache.get(key);
  if (prep && prep.kind !== "fail") return prep;
  prep = await buildExportPayloadForKey(key);
  if (prep) return prep;
  return exportPrepCache.get(key);
}

function area(bbox) {
  return bbox[2] * bbox[3];
}

/** Union of axis-aligned boxes as `[x, y, w, h]`. */
function bboxUnionRect(bboxes) {
  if (!bboxes.length) return [0, 0, 0, 0];
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const b of bboxes) {
    const [x, y, w, h] = b;
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x + w);
    y1 = Math.max(y1, y + h);
  }
  return [x0, y0, x1 - x0, y1 - y0];
}

function topRawDetection(predictions) {
  if (!predictions.length) return null;
  return predictions.slice().sort((a, b) => b.score - a.score)[0];
}

/** Minimal fields kept on disk for reset/suggested crop — avoids storing full COCO-SSD prediction arrays per photo. */
function slimDetectionForState(det) {
  if (!det) return null;
  const bbox = det.bbox;
  if (!bbox || bbox.length < 4) return null;
  return { bbox: [bbox[0], bbox[1], bbox[2], bbox[3]] };
}

/** Merge detector output into mutable `state` (w/h/crop square). */
function applyDetectionToState(state, preds, w, h, padFrac) {
  const minScore = MIN_DETECTION_SCORE;
  const top = topRawDetection(preds);
  const picked = pickBestWildlifeCropFromPredictions(preds, w, h, padFrac, minScore);
  state.w = w;
  state.h = h;
  if (picked) {
    state.left = picked.crop.left;
    state.top = picked.crop.top;
    state.side = picked.crop.side;
    state.det = picked.det;
    delete state.noDetectionCrop;
  } else {
    const side = Math.min(w, h);
    state.left = Math.round((w - side) / 2);
    state.top = Math.round((h - side) / 2);
    state.side = side;
    state.det = slimDetectionForState(topRawDetection(preds));
    state.noDetectionCrop = true;
  }
}

function squareCropFromDetection(imgWidth, imgHeight, bbox, paddingFrac) {
  const [x, y, w, h] = bbox;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const base = Math.max(w, h);
  let side = base * (1 + paddingFrac);
  const maxSide = Math.min(imgWidth, imgHeight);
  side = Math.min(side, maxSide);
  let left = cx - side / 2;
  let top = cy - side / 2;
  left = Math.max(0, Math.min(left, imgWidth - side));
  top = Math.max(0, Math.min(top, imgHeight - side));
  return { left: Math.round(left), top: Math.round(top), side: Math.round(side) };
}

/**
 * Auto crop from detections: union every viable box so multiple subjects stay inside the square, then pad.
 * @returns {{ crop: { left: number, top: number, side: number }, det: ReturnType<typeof slimDetectionForState> } | null}
 */
function pickBestWildlifeCropFromPredictions(preds, imgW, imgH, padFrac, minScore) {
  const boxes = preds.filter((p) => p.score >= minScore).map((p) => p.bbox);
  if (!boxes.length) return null;
  const union = bboxUnionRect(boxes);
  const crop = squareCropFromDetection(imgW, imgH, union, padFrac);
  return { crop, det: slimDetectionForState({ bbox: union }) };
}

/** Suggested square for “reset”: same rules as initial analysis (padding slider applies to detection crops). */
function suggestedSquareCropFromState(state) {
  const w = state.w;
  const h = state.h;
  if (!w || !h) return null;
  const padFrac = PADDING_FRAC;
  if (state.noDetectionCrop) {
    const side = Math.min(w, h);
    return {
      left: Math.round((w - side) / 2),
      top: Math.round((h - side) / 2),
      side,
    };
  }
  const bbox = state.det && state.det.bbox;
  if (bbox && Array.isArray(bbox) && bbox.length >= 4) {
    return squareCropFromDetection(w, h, bbox, padFrac);
  }
  const side = Math.min(w, h);
  return {
    left: Math.round((w - side) / 2),
    top: Math.round((h - side) / 2),
    side,
  };
}

/**
 * Keep a square crop inside the image; `side` is both width and height in pixels.
 */
function clampSquareCropInImage(left, top, side, imgW, imgH, minSide) {
  const maxSide = Math.min(imgW, imgH);
  let s = Math.min(Math.max(minSide, side), maxSide);
  let l = left;
  let t = top;
  l = Math.max(0, Math.min(l, imgW - s));
  t = Math.max(0, Math.min(t, imgH - s));
  s = Math.min(s, imgW - l, imgH - t);
  s = Math.max(minSide, Math.min(s, maxSide));
  l = Math.max(0, Math.min(l, imgW - s));
  t = Math.max(0, Math.min(t, imgH - s));
  return { left: Math.round(l), top: Math.round(t), side: Math.round(s) };
}

/** Same geometry as `clampSquareCropInImage` but keeps subpixel values for smooth zoom preview. */
function clampSquareCropInImageFloat(left, top, side, imgW, imgH, minSide) {
  const maxSide = Math.min(imgW, imgH);
  let s = Math.min(Math.max(minSide, side), maxSide);
  let l = left;
  let t = top;
  l = Math.max(0, Math.min(l, imgW - s));
  t = Math.max(0, Math.min(t, imgH - s));
  s = Math.min(s, imgW - l, imgH - t);
  s = Math.max(minSide, Math.min(s, maxSide));
  l = Math.max(0, Math.min(l, imgW - s));
  t = Math.max(0, Math.min(t, imgH - s));
  return { left: l, top: t, side: s };
}

/** After changing crop `side`, keep the viewport center fixed (center of the current crop square in image space). */
function anchorCropCenterOnZoom(prev, nextSide, imgW, imgH, minSide) {
  const cx = prev.left + prev.side / 2;
  const cy = prev.top + prev.side / 2;
  const left = cx - nextSide / 2;
  const top = cy - nextSide / 2;
  return clampSquareCropInImageFloat(left, top, nextSide, imgW, imgH, minSide);
}

/**
 * Minimum square crop edge in image pixels — must match the zoom slider lower bound in {@link buildCropEditor}
 * so auto-detected crops are not far more “zoomed in” than the slider indicates.
 * @param {number} w
 * @param {number} h
 */
function minSquareCropSideForDims(w, h) {
  const dim = Math.min(w, h);
  if (!Number.isFinite(dim) || dim <= 0) return 32;
  const coarse = isCoarsePointerPrimaryInput();
  return Math.max(coarse ? 48 : 32, Math.round(dim * 0.02));
}

/**
 * If `state.side` is below the zoom-slider floor, expand the square (keeping it in-bounds) so preview and slider agree.
 * @param {{ left: number, top: number, side: number, w: number, h: number, hasCrop?: boolean }} state
 */
function enforceMinCropSideOnState(state) {
  if (!state || state.hasCrop === false) return;
  const w = state.w;
  const h = state.h;
  if (!w || !h) return;
  if (typeof state.left !== "number" || typeof state.top !== "number" || typeof state.side !== "number") return;
  const lo = minSquareCropSideForDims(w, h);
  if (!(state.side < lo)) return;
  const sq = clampSquareCropInImage(state.left, state.top, lo, w, h, lo);
  state.left = sq.left;
  state.top = sq.top;
  state.side = sq.side;
}

function isHeicLike(file) {
  const t = (file.type || "").toLowerCase();
  const n = file.name.toLowerCase();
  return t.includes("heic") || t.includes("heif") || n.endsWith(".heic") || n.endsWith(".heif");
}

/** Picker: raster still images only (no video or motion clips). */
function isImageFile(f) {
  const t = (f.type || "").toLowerCase();
  if (t.startsWith("video/") || t === "image/quicktime" || t === "video/quicktime") return false;
  if (t.startsWith("image/") || isHeicLike(f)) return true;
  if (/\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(f.name || "")) return false;
  return /\.(jpe?g|png|gif|webp|bmp|tif|tiff|heic|heif|avif)$/i.test(f.name || "");
}

function shouldYieldBetweenBatchItems() {
  if (isIOSOrIPadOS()) return true;
  try {
    if (navigator.maxTouchPoints > 0 && window.matchMedia("(max-width: 640px)").matches) return true;
  } catch { /* ignore */ }
  return false;
}

/** How many upcoming files to decode in the background while reviewing (reduces delay on “next”). */
const CROP_PREVIEW_PREFETCH_AHEAD = 2;
/** Large batches: fewer prefetch probes and more aggressive blob-URL eviction (mobile RAM). */
const MEMORY_PRESSURE_FILE_THRESHOLD = 28;
const CROP_PREVIEW_PREFETCH_AHEAD_LARGE = 1;
/** iOS: skip ahead-of-queue ImageBitmap prefetch — it competes with TF.js and can spike RAM. */
const CROP_PREVIEW_PREFETCH_AHEAD_IOS = 0;
/** Hard cap per pick — very large selections risk OOM during EXIF sort + analysis. */
const MAX_BATCH_FILES = 180;
let cropPreviewPrefetchToken = 0;

/**
 * Above this file count, use lighter preview prefetch and do not retain export blobs in RAM between steps.
 * Optional `?e2e-memlow=1` raises the threshold for automation only.
 */
function memoryPressureThreshold() {
  if (typeof window !== "undefined" && window.location.search.includes("e2e-memlow=1") && !isIOSOrIPadOS()) {
    return 120;
  }
  return isIOSOrIPadOS() ? Math.min(MEMORY_PRESSURE_FILE_THRESHOLD, 26) : MEMORY_PRESSURE_FILE_THRESHOLD;
}

function prefetchAheadCount() {
  if (isIOSOrIPadOS()) return CROP_PREVIEW_PREFETCH_AHEAD_IOS;
  const t = memoryPressureThreshold();
  return workItems.length >= t ? CROP_PREVIEW_PREFETCH_AHEAD_LARGE : CROP_PREVIEW_PREFETCH_AHEAD;
}

/** Bump so idle/rAF prefetch work cannot write into released ImageBitmaps after delete/navigation. */
function bumpPrefetchToken() {
  cropPreviewPrefetchToken++;
}

function isDesktopSafari() {
  const ua = navigator.userAgent || "";
  if (/Chrome|Chromium|Edg|OPR|Brave|Firefox/i.test(ua)) return false;
  return /Safari/i.test(ua) && !/Android/i.test(ua);
}

function fileToImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const done = () => { URL.revokeObjectURL(url); resolve(img); };
      if (typeof img.decode === "function") img.decode().then(done).catch(done);
      else done();
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`Could not decode "${file.name}".`)); };
    img.src = url;
  });
}

async function decodeHeicWithWasmFallback(file) {
  try {
    const bm = await createImageBitmap(file);
    return { source: bm, w: bm.width, h: bm.height, close: () => bm.close() };
  } catch { /* continue */ }
  const heic2any = (await import("https://esm.sh/heic2any@0.0.4")).default;
  const result = await heic2any({ blob: file, toType: "image/jpeg", quality: 1 });
  const blob = Array.isArray(result) ? result[0] : result;
  const jpegFile = new File([blob], file.name.replace(/\.hei[cf]$/i, ".jpg"), { type: "image/jpeg" });
  const img = await fileToImage(jpegFile);
  return { source: img, w: img.naturalWidth, h: img.naturalHeight };
}

/**
 * Decode for manual crop when auto pipeline failed; tries extra fallbacks before giving up.
 */
async function decodeForManualCrop(file) {
  try {
    return await decodeForPipeline(file);
  } catch (e) {
    console.warn("decodeForPipeline failed; trying image fallback", e);
    try {
      const img = await fileToImage(file);
      return { source: img, w: img.naturalWidth, h: img.naturalHeight };
    } catch {
      throw e;
    }
  }
}

function disposeDecodedBundle(raw) {
  if (!raw) return;
  if (typeof raw.close === "function") raw.close();
  else if (raw.source && typeof raw.source.close === "function") raw.source.close();
}

/**
 * Decode and optionally downscale for object detection only. Caller must call `close()` after `detect()`
 * when `close` is provided (releases ImageBitmap / GPU memory).
 */
async function decodeForDetectionOnly(file) {
  const raw = await decodeForPipeline(file);
  const fullW = raw.w;
  const fullH = raw.h;
  const maxEdge = Math.max(fullW, fullH);
  if (maxEdge <= DETECTION_MAX_EDGE) {
    return {
      source: raw.source,
      fullW,
      fullH,
      detW: fullW,
      detH: fullH,
      close: () => disposeDecodedBundle(raw),
    };
  }
  const scale = DETECTION_MAX_EDGE / maxEdge;
  const detW = Math.max(1, Math.round(fullW * scale));
  const detH = Math.max(1, Math.round(fullH * scale));
  const canvas = document.createElement("canvas");
  canvas.width = detW;
  canvas.height = detH;
  const ctx = canvas.getContext("2d", { willReadFrequently: false });
  if (!ctx) {
    disposeDecodedBundle(raw);
    throw new Error("Could not get canvas for detection resize.");
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "medium";
  ctx.drawImage(raw.source, 0, 0, detW, detH);
  disposeDecodedBundle(raw);
  return {
    source: canvas,
    fullW,
    fullH,
    detW,
    detH,
    close: null,
  };
}

async function decodeForPipeline(file) {
  if (isHeicLike(file)) {
    if (isIOSOrIPadOS()) {
      const img = await fileToImage(file);
      return { source: img, w: img.naturalWidth, h: img.naturalHeight };
    }
    if (isDesktopSafari()) {
      try {
        const img = await fileToImage(file);
        return { source: img, w: img.naturalWidth, h: img.naturalHeight };
      } catch { return decodeHeicWithWasmFallback(file); }
    }
    try {
      const img = await fileToImage(file);
      return { source: img, w: img.naturalWidth, h: img.naturalHeight };
    } catch { /* Chrome/Firefox on Mac usually can't decode HEIC in img */ }
    try { return await decodeHeicWithWasmFallback(file); } catch (e) {
      const detail = e && typeof e === "object" && "message" in e ? String(e.message) : String(e);
      throw new Error(`HEIC could not be decoded (${detail.slice(0, 120)}). Try Safari, or export the photo as JPEG.`);
    }
  }
  if (isIOSOrIPadOS()) {
    const img = await fileToImage(file);
    return { source: img, w: img.naturalWidth, h: img.naturalHeight };
  }
  try {
    const bm = await createImageBitmap(file);
    return { source: bm, w: bm.width, h: bm.height, close: () => bm.close() };
  } catch {
    const img = await fileToImage(file);
    return { source: img, w: img.naturalWidth, h: img.naturalHeight };
  }
}

async function getCachedDetection(file, detModel) {
  const dec = await decodeForDetectionOnly(file);
  try {
    let predsRaw = [];
    try {
      predsRaw = await detModel.detect(dec.source, 40, 0.08);
    } catch (e) {
      /** Model disposed mid-flight or GPU fault — avoid uncaught rejection / crash. */
      console.warn("detModel.detect", e);
      predsRaw = [];
    }
    const sx = dec.fullW / dec.detW;
    const sy = dec.fullH / dec.detH;
    const preds = predsRaw.map((p) => ({
      ...p,
      bbox: [p.bbox[0] * sx, p.bbox[1] * sy, p.bbox[2] * sx, p.bbox[3] * sy],
    }));
    /** Do not retain full prediction lists for hundreds of files — each image is analyzed once. */
    return { preds, fullW: dec.fullW, fullH: dec.fullH };
  } finally {
    if (typeof dec.close === "function") dec.close();
  }
}

function exifrReadOptions(file) {
  const heic = isHeicLike(file);
  return { reviveValues: true, mergeOutput: true, gps: true, tiff: true, exif: true, ifd0: true, ...(heic ? { xmp: true } : {}) };
}

function coalesceExifDate(...vals) {
  for (const v of vals) {
    if (v == null) continue;
    if (v instanceof Date && !Number.isNaN(v.getTime())) return v;
    const t = new Date(v);
    if (!Number.isNaN(t.getTime())) return t;
  }
  return null;
}

function firstDateFromExifr(ex) {
  return coalesceExifDate(ex.DateTimeOriginal, ex.CreateDate, ex.ModifyDate, ex.MediaCreateDate, ex.ContentCreateDate, ex.CreationDate, ex.MetadataDate);
}

/** Epoch ms from embedded EXIF in a JPEG `Blob` or `File`, or null. */
async function lastModifiedMsFromJpegBlob(blob) {
  try {
    const ex = await exifr.parse(blob, { reviveValues: true, mergeOutput: true, tiff: true, exif: true, ifd0: true });
    const d = firstDateFromExifr(ex);
    if (d && !Number.isNaN(d.getTime())) return d.getTime();
  } catch { /* ignore */ }
  return null;
}

async function getCaptureTime(file) {
  try {
    const ex = await exifr.parse(file, exifrReadOptions(file));
    const d = firstDateFromExifr(ex);
    if (d) return d.getTime();
  } catch { /* ignore */ }
  return file.lastModified;
}

async function sortFilesByCapture(files) {
  /** iOS: always use fast path — per-file `exifr.parse` on large picks spikes RAM and can kill the tab. */
  if (isIOSOrIPadOS() || files.length >= memoryPressureThreshold()) {
    return files
      .map((f) => ({ f, t: f.lastModified }))
      .sort((a, b) => {
        if (a.t !== b.t) return a.t - b.t;
        const an = a.f.name || "";
        const bn = b.f.name || "";
        if (an !== bn) return an < bn ? -1 : an > bn ? 1 : 0;
        if (a.f.size !== b.f.size) return a.f.size - b.f.size;
        return 0;
      })
      .map((k) => k.f);
  }
  const keyed = [];
  for (const f of files) {
    keyed.push({ f, t: await getCaptureTime(f) });
  }
  keyed.sort((a, b) => {
    if (a.t !== b.t) return a.t - b.t;
    const an = a.f.name || "";
    const bn = b.f.name || "";
    if (an !== bn) return an < bn ? -1 : an > bn ? 1 : 0;
    if (a.f.size !== b.f.size) return a.f.size - b.f.size;
    return a.f.lastModified - b.f.lastModified;
  });
  return keyed.map((k) => k.f);
}

/** Re-sort current batch by capture time so ZIP / share order matches photo timestamps. */
async function refreshWorkItemsCaptureOrder() {
  if (!workItems.length) return;
  workItems = await sortFilesByCapture(workItems);
}

function formatExifDate(d) {
  if (d == null) return null;
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return null;
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}:${pad(date.getMonth() + 1)}:${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function numLikeToFinite(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = parseFloat(v.replace(/,/g, ".").trim());
    if (Number.isFinite(n)) return n;
  }
  return NaN;
}

/**
 * EXIF GPS rational tuples: [[degNum,degDen], ...] or plain numbers after exifr revive.
 * @param {unknown} dms
 * @param {unknown} ref 'N'|'S'|'E'|'W' or undefined when values are already signed.
 */
function exifrDmsTupleToDeg(dms, ref) {
  if (!Array.isArray(dms) || dms.length < 3) return NaN;
  let deg = 0;
  for (let i = 0; i < 3; i++) {
    const part = dms[i];
    let q = NaN;
    if (typeof part === "number") q = part;
    else if (Array.isArray(part) && part.length >= 2 && part[1]) q = part[0] / part[1];
    if (!Number.isFinite(q)) return NaN;
    deg += i === 0 ? q : i === 1 ? q / 60 : q / 3600;
  }
  const r = typeof ref === "string" ? ref.trim().toUpperCase().charAt(0) : "";
  if (r === "S" || r === "W") deg = -deg;
  return deg;
}

function latLonAltitudeFromExifr(ex) {
  if (!ex || typeof ex !== "object") return { lat: undefined, lon: undefined, altitudeMeters: undefined };
  let lat = typeof ex.latitude === "number" && Number.isFinite(ex.latitude) ? ex.latitude : undefined;
  let lon = typeof ex.longitude === "number" && Number.isFinite(ex.longitude) ? ex.longitude : undefined;
  if ((lat == null || lon == null) && ex.gps && typeof ex.gps === "object") {
    const g = ex.gps;
    const gla = numLikeToFinite(g.latitude);
    const glo = numLikeToFinite(g.longitude);
    if (Number.isFinite(gla) && Number.isFinite(glo)) {
      lat = gla;
      lon = glo;
    }
  }
  if ((lat == null || lon == null) && ex.Position && typeof ex.Position === "object") {
    const la = numLikeToFinite(ex.Position.latitude);
    const lo = numLikeToFinite(ex.Position.longitude);
    if (Number.isFinite(la) && Number.isFinite(lo)) {
      lat = la;
      lon = lo;
    }
  }
  if ((lat == null || lon == null) && ex.GPSLatitude != null && ex.GPSLongitude != null) {
    if (typeof ex.GPSLatitude === "number" && typeof ex.GPSLongitude === "number") {
      lat = ex.GPSLatitude;
      lon = ex.GPSLongitude;
    } else if (Array.isArray(ex.GPSLatitude) && Array.isArray(ex.GPSLongitude)) {
      const la = exifrDmsTupleToDeg(ex.GPSLatitude, ex.GPSLatitudeRef);
      const lo = exifrDmsTupleToDeg(ex.GPSLongitude, ex.GPSLongitudeRef);
      if (Number.isFinite(la) && Number.isFinite(lo)) {
        lat = la;
        lon = lo;
      }
    }
  }
  let altitudeMeters = typeof ex.GPSAltitude === "number" && Number.isFinite(ex.GPSAltitude) ? ex.GPSAltitude : undefined;
  if (altitudeMeters == null && ex.gps && typeof ex.gps.GPSAltitude === "number") altitudeMeters = ex.gps.GPSAltitude;
  return { lat, lon, altitudeMeters };
}

async function extractMetaForEmbedding(file) {
  try {
    const ex = await exifr.parse(file, exifrReadOptions(file));
    const dt = firstDateFromExifr(ex);
    const dtStr = formatExifDate(dt) || formatExifDate(new Date(file.lastModified));
    const { lat, lon, altitudeMeters } = latLonAltitudeFromExifr(ex);
    /** Match EXIF capture time for ZIP entry mtime and File.lastModified (ms since epoch). */
    const lastModified = dt && !Number.isNaN(dt.getTime()) ? dt.getTime() : file.lastModified;
    return { dtStr, lat, lon, altitudeMeters, lastModified };
  } catch {
    return { dtStr: formatExifDate(new Date(file.lastModified)), lat: undefined, lon: undefined, altitudeMeters: undefined, lastModified: file.lastModified };
  }
}

function isJpegMimeFile(file) {
  const t = (file.type || "").toLowerCase();
  return t === "image/jpeg" || t === "image/jpg" || /\.jpe?g$/i.test(file.name);
}

function binaryStringToBlob(binary, mime) {
  const u8 = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) u8[i] = binary.charCodeAt(i) & 0xff;
  return new Blob([u8], { type: mime });
}

function blobToBinaryString(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const u8 = new Uint8Array(fr.result);
      let s = "";
      for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
      resolve(s);
    };
    fr.onerror = () => reject(fr.error);
    fr.readAsArrayBuffer(blob);
  });
}

function buildExifDictFromMeta(meta, width, height) {
  const zeroth = {};
  const exifObj = {};
  const gps = {};
  if (meta.dtStr) {
    zeroth[piexif.ImageIFD.DateTime] = meta.dtStr;
    exifObj[piexif.ExifIFD.DateTimeOriginal] = meta.dtStr;
    exifObj[piexif.ExifIFD.DateTimeDigitized] = meta.dtStr;
  }
  zeroth[piexif.ImageIFD.Orientation] = 1;
  zeroth[piexif.ImageIFD.ImageWidth] = width;
  zeroth[piexif.ImageIFD.ImageLength] = height;
  exifObj[piexif.ExifIFD.PixelXDimension] = width;
  exifObj[piexif.ExifIFD.PixelYDimension] = height;
  if (meta.lat != null && meta.lon != null && Number.isFinite(meta.lat) && Number.isFinite(meta.lon)) {
    gps[piexif.GPSIFD.GPSVersionID] = [7, 7, 27, 1];
    gps[piexif.GPSIFD.GPSLatitudeRef] = meta.lat >= 0 ? "N" : "S";
    gps[piexif.GPSIFD.GPSLatitude] = piexif.GPSHelper.degToDmsRational(Math.abs(meta.lat));
    gps[piexif.GPSIFD.GPSLongitudeRef] = meta.lon >= 0 ? "E" : "W";
    gps[piexif.GPSIFD.GPSLongitude] = piexif.GPSHelper.degToDmsRational(Math.abs(meta.lon));
  }
  if (meta.altitudeMeters != null && Number.isFinite(meta.altitudeMeters)) {
    gps[piexif.GPSIFD.GPSAltitudeRef] = meta.altitudeMeters >= 0 ? 0 : 1;
    gps[piexif.GPSIFD.GPSAltitude] = [[Math.round(Math.abs(meta.altitudeMeters) * 100), 100]];
  }
  if (Object.keys(gps).length > 0 && gps[piexif.GPSIFD.GPSVersionID] === undefined) gps[piexif.GPSIFD.GPSVersionID] = [7, 7, 27, 1];
  const exifDict = { "0th": zeroth, Exif: exifObj, Interop: {}, "1st": {}, thumbnail: null };
  if (Object.keys(gps).length > 0) exifDict.GPS = gps;
  return exifDict;
}

async function embedExifInJpeg(jpegBlob, meta, width, height) {
  const exifDict = buildExifDictFromMeta(meta, width, height);
  const exifBytes = piexif.dump(exifDict);
  const raw = await blobToBinaryString(jpegBlob);
  const out = piexif.insert(exifBytes, raw);
  return binaryStringToBlob(out, "image/jpeg");
}

async function mergeExifFromSourceJpeg(file, croppedJpegBlob, width, height, meta) {
  const origStr = await blobToBinaryString(file);
  const exifObj = piexif.load(origStr);
  delete exifObj.thumbnail;
  exifObj["1st"] = {};
  if (exifObj["0th"]) {
    exifObj["0th"][piexif.ImageIFD.Orientation] = 1;
    exifObj["0th"][piexif.ImageIFD.ImageWidth] = width;
    exifObj["0th"][piexif.ImageIFD.ImageLength] = height;
    if (meta && meta.dtStr) exifObj["0th"][piexif.ImageIFD.DateTime] = meta.dtStr;
  }
  if (!exifObj.Exif) exifObj.Exif = {};
  exifObj.Exif[piexif.ExifIFD.PixelXDimension] = width;
  exifObj.Exif[piexif.ExifIFD.PixelYDimension] = height;
  if (meta && meta.dtStr) {
    exifObj.Exif[piexif.ExifIFD.DateTimeOriginal] = meta.dtStr;
    exifObj.Exif[piexif.ExifIFD.DateTimeDigitized] = meta.dtStr;
  }
  const exifBytes = piexif.dump(exifObj);
  const raw = await blobToBinaryString(croppedJpegBlob);
  const out = piexif.insert(exifBytes, raw);
  return binaryStringToBlob(out, "image/jpeg");
}

const CROP_EXPORT_FORMAT = { mime: "image/jpeg", quality: 1, ext: "jpg" };

async function attachMetadataToCroppedJpeg(file, croppedJpegBlob, width, height) {
  const meta = await extractMetaForEmbedding(file);
  if (isJpegMimeFile(file)) {
    try {
      return await mergeExifFromSourceJpeg(file, croppedJpegBlob, width, height, meta);
    } catch (e) {
      console.warn("Could not merge JPEG EXIF from source; using rebuilt tags.", e);
    }
  }
  return embedExifInJpeg(croppedJpegBlob, meta, width, height);
}

/**
 * Encode the full decoded image as max-quality JPEG with EXIF suitable for sharing (e.g. iNaturalist).
 * Used when the ZIP export would copy a non-JPEG original — Web Share and many targets only advertise for `image/jpeg`.
 */
async function encodeFullImageToJpegBlobForShare(sourceFile) {
  const raw = await decodeForPipeline(sourceFile);
  try {
    const { source, w, h } = raw;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    let ctx = canvas.getContext("2d", { colorSpace: "srgb", willReadFrequently: false });
    if (!ctx) ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not get canvas context.");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, 0, 0, w, h);
    const jpegBlob = await new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (blob) resolve(blob);
          else reject(new Error("Could not encode JPEG."));
        },
        CROP_EXPORT_FORMAT.mime,
        CROP_EXPORT_FORMAT.quality
      );
    });
    return attachMetadataToCroppedJpeg(sourceFile, jpegBlob, w, h);
  } finally {
    disposeDecodedBundle(raw);
  }
}

function stripFileExtension(name) {
  return String(name || "").replace(/\.[^.]+$/i, "");
}

/** Exported JPEG filenames use `.jpg` (not `.jpeg`). */
function exportFilenameWithJpgExt(filename) {
  return String(filename || "").replace(/\.jpe?g$/i, ".jpg");
}

/**
 * iOS “Open in…” filters use MIME type; HEIC/PNG/`octet-stream` often hide photo apps.
 * Normalize to JPEG files with `type: image/jpeg` (we never share the ZIP — only these image files).
 */
async function normalizeExportFilesForShare(exportFiles, sourceFiles, onProgress) {
  const out = [];
  const total = exportFiles.length;
  for (let i = 0; i < exportFiles.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 0));
    const f = exportFiles[i];
    const src = sourceFiles[i];
    const mime = (f.type || "").toLowerCase();
    const nameLooksJpeg = /\.jpe?g$/i.test(f.name || "");
    const isJpegMime = mime === "image/jpeg" || mime === "image/jpg";
    if (isJpegMime || (nameLooksJpeg && mime.startsWith("image/"))) {
      const name = nameLooksJpeg ? exportFilenameWithJpgExt(f.name) : `${stripFileExtension(f.name)}.jpg`;
      out.push(new File([f], name, { type: "image/jpeg", lastModified: f.lastModified }));
      if (onProgress) onProgress({ index: i + 1, total });
      continue;
    }
    if (!src) {
      console.warn("Missing source file for share normalization; skipping.", f && f.name);
      if (onProgress) onProgress({ index: i + 1, total });
      continue;
    }
    sharePrepStatusText = `Encoding JPEG for Share… ${i + 1} / ${total}`;
    updateSharePrepUiDisplay();
    const jpegBlob = await encodeFullImageToJpegBlobForShare(src);
    const name = `${stripFileExtension(f.name)}.jpg`;
    out.push(new File([jpegBlob], name, { type: "image/jpeg", lastModified: f.lastModified }));
    if (onProgress) onProgress({ index: i + 1, total });
  }
  return out;
}

async function cropSourceToBlob(source, crop, format) {
  const { left, top, side } = crop;
  const outSide = Math.max(1, Math.round(side));
  const canvas = document.createElement("canvas");
  canvas.width = outSide;
  canvas.height = outSide;
  let ctx = canvas.getContext("2d", { colorSpace: "srgb", willReadFrequently: false });
  if (!ctx) ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not get canvas context.");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, left, top, side, side, 0, 0, outSide, outSide);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => { if (blob) resolve(blob); else reject(new Error("Could not encode image.")); }, format.mime, format.quality);
  });
}

function revokePreviewUrls() {
  bumpPrefetchToken();
  for (const u of previewObjectUrls) URL.revokeObjectURL(u);
  previewObjectUrls = [];
  filePreviewUrlByKey.clear();
  for (const u of inatGroupingThumbUrlByKey.values()) {
    try {
      URL.revokeObjectURL(u);
    } catch {
      /* ignore */
    }
  }
  inatGroupingThumbUrlByKey.clear();
  for (const bm of cropPreviewBitmapByKey.values()) {
    try {
      bm.close();
    } catch { /* ignore */ }
  }
  cropPreviewBitmapByKey.clear();
  previewGrid.replaceChildren();
}

function pushPreviewUrl(url) {
  previewObjectUrls.push(url);
  return url;
}

function getOrCreateFilePreviewUrl(file) {
  const key = fileCacheKey(file);
  let url = filePreviewUrlByKey.get(key);
  if (!url) {
    url = URL.createObjectURL(file);
    filePreviewUrlByKey.set(key, url);
    pushPreviewUrl(url);
  }
  return url;
}

/** Longest edge when decoding for iNat grouping strip thumbnails (~112px); avoids many parallel full-res buffers. */
const INAT_GROUP_THUMB_DECODE_MAX_EDGE = 512;

/** Serialize grouping-thumb encodes so opening the strip does not decode every file at once. */
let inatGroupingThumbEncodeChain = /** @type {Promise<unknown>} */ (Promise.resolve());
/** @type {Map<string, Promise<string>>} */
const inatGroupingThumbEncodeInflight = new Map();

/**
 * Decode to a drawable source for a grouping thumbnail (max edge {@link INAT_GROUP_THUMB_DECODE_MAX_EDGE}).
 * Always uses {@link decodeForPipeline} so pixel dimensions match `cropState` (detector / editor), then downscales.
 * A previous EXIF-width fast path could disagree with EXIF orientation vs. oriented decode, mapping the crop
 * outside the bitmap and leaving `alpha:false` JPEG canvases solid black.
 * @param {File} file
 * @returns {Promise<{ source: CanvasImageSource, w: number, h: number, close?: () => void }>}
 */
async function decodeSourceForInatGroupingThumb(file) {
  const cap = INAT_GROUP_THUMB_DECODE_MAX_EDGE;
  const raw = await decodeForPipeline(file);
  const maxD = Math.max(raw.w, raw.h);
  if (maxD <= cap) return raw;
  const s = cap / maxD;
  const tw = Math.max(1, Math.round(raw.w * s));
  const th = Math.max(1, Math.round(raw.h * s));
  const canvas = document.createElement("canvas");
  canvas.width = tw;
  canvas.height = th;
  const ctx = canvas.getContext("2d", { willReadFrequently: false, alpha: false });
  if (!ctx) {
    disposeDecodedBundle(raw);
    throw new Error("No canvas context.");
  }
  ctx.fillStyle = "#f8fafc";
  ctx.fillRect(0, 0, tw, th);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "medium";
  ctx.drawImage(raw.source, 0, 0, tw, th);
  disposeDecodedBundle(raw);
  return { source: canvas, w: tw, h: th };
}

/**
 * Small square JPEG object URL for iNat grouping thumbnails (uses current `cropState` square).
 * @param {File} file
 */
async function ensureInatGroupingThumbUrl(file) {
  const key = fileCacheKey(file);
  const cached = inatGroupingThumbUrlByKey.get(key);
  if (cached) return cached;
  let inflight = inatGroupingThumbEncodeInflight.get(key);
  if (inflight) return inflight;
  inflight = inatGroupingThumbEncodeChain
    .then(() => buildInatGroupingThumbObjectUrl(file))
    .finally(() => {
      inatGroupingThumbEncodeInflight.delete(key);
    });
  inatGroupingThumbEncodeInflight.set(key, inflight);
  inatGroupingThumbEncodeChain = inflight.catch(() => {});
  return inflight;
}

/**
 * @param {File} file
 * @returns {Promise<string>}
 */
async function buildInatGroupingThumbObjectUrl(file) {
  const key = fileCacheKey(file);
  const hit = inatGroupingThumbUrlByKey.get(key);
  if (hit) return hit;
  const st = cropState.get(key);
  const raw = await decodeSourceForInatGroupingThumb(file);
  try {
    const w = raw.w;
    const h = raw.h;
    const side0 = Math.min(w, h);
    const fullW = st && typeof st.w === "number" && st.w > 0 ? st.w : null;
    const fullH = st && typeof st.h === "number" && st.h > 0 ? st.h : null;
    let pick =
      st && st.hasCrop !== false && fullW && fullH
        ? {
            left: Math.max(0, Math.min(w - 1, Math.round((st.left * w) / fullW))),
            top: Math.max(0, Math.min(h - 1, Math.round((st.top * h) / fullH))),
            side: Math.max(1, Math.round((st.side * w) / fullW)),
          }
        : { left: Math.round((w - side0) / 2), top: Math.round((h - side0) / 2), side: side0 };
    let sideDraw = Math.max(1, Math.min(pick.side, w - pick.left, h - pick.top));
    /** Bad or stale `cropState` vs. decode can shrink the source rect to a few pixels → black 112² JPEG. */
    const minReasonable = Math.min(24, Math.floor(Math.min(w, h) * 0.08));
    if (sideDraw < minReasonable) {
      pick = { left: Math.round((w - side0) / 2), top: Math.round((h - side0) / 2), side: side0 };
      sideDraw = Math.max(1, Math.min(pick.side, w - pick.left, h - pick.top));
    }
    const edge = 112;
    const canvas = document.createElement("canvas");
    canvas.width = edge;
    canvas.height = edge;
    const ctx = canvas.getContext("2d", { willReadFrequently: false, alpha: false });
    if (!ctx) throw new Error("No canvas context.");
    ctx.fillStyle = "#f8fafc";
    ctx.fillRect(0, 0, edge, edge);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(raw.source, pick.left, pick.top, sideDraw, sideDraw, 0, 0, edge, edge);
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob(
        (b) => {
          if (b) resolve(b);
          else reject(new Error("Thumb encode failed."));
        },
        "image/jpeg",
        0.78
      );
    });
    const url = URL.createObjectURL(blob);
    inatGroupingThumbUrlByKey.set(key, url);
    pushPreviewUrl(url);
    return url;
  } finally {
    disposeDecodedBundle(raw);
  }
}

/**
 * Rebuild one grouping thumbnail outside the serialized encode chain (e.g. after a single-photo crop)
 * so the export strip does not wait behind other queued thumbs before showing the new crop.
 * @param {File} file
 */
async function rebuildInatGroupingThumbNow(file) {
  const key = fileCacheKey(file);
  revokeInatGroupingThumbUrlForKey(key);
  return buildInatGroupingThumbObjectUrl(file);
}

/** After crop review, drop full-res prefetch bitmaps and blob URLs — export uses small iNat thumbs and `File` objects for ZIP. */
function releaseCropPrefetchAfterReviewFinished() {
  bumpPrefetchToken();
  for (const bm of cropPreviewBitmapByKey.values()) {
    try {
      bm.close();
    } catch {
      /* ignore */
    }
  }
  cropPreviewBitmapByKey.clear();
  for (const [k, u] of [...filePreviewUrlByKey.entries()]) {
    try {
      URL.revokeObjectURL(u);
    } catch {
      /* ignore */
    }
    filePreviewUrlByKey.delete(k);
    const pi = previewObjectUrls.indexOf(u);
    if (pi >= 0) previewObjectUrls.splice(pi, 1);
  }
}

/** Drop blob URLs far from the current review index so hundreds of files do not all stay resident. */
function revokeDistantPreviewBlobUrls() {
  const pressure = memoryPressureThreshold();
  if (workItems.length < pressure) return;
  const keepRadius = workItems.length >= pressure ? 1 : 4;
  const ahead = Math.max(prefetchAheadCount(), 0);
  const fi = cropItemForwardIndex();
  const lo = Math.max(0, fi - keepRadius - ahead);
  const hi = Math.min(workItems.length - 1, fi + keepRadius);
  const keep = new Set();
  for (let i = lo; i <= hi; i++) {
    keep.add(fileCacheKey(workItems[i]));
  }
  for (const [k, u] of [...filePreviewUrlByKey.entries()]) {
    if (keep.has(k)) continue;
    try {
      URL.revokeObjectURL(u);
    } catch { /* ignore */ }
    filePreviewUrlByKey.delete(k);
    const pi = previewObjectUrls.indexOf(u);
    if (pi >= 0) previewObjectUrls.splice(pi, 1);
  }
  for (const [k, bm] of [...cropPreviewBitmapByKey.entries()]) {
    if (keep.has(k)) continue;
    try {
      bm.close();
    } catch { /* ignore */ }
    cropPreviewBitmapByKey.delete(k);
  }
}

function warmImageDecodeProbe(file) {
  const url = getOrCreateFilePreviewUrl(file);
  const probe = new Image();
  probe.decoding = "async";
  try {
    if ("fetchPriority" in probe) probe.fetchPriority = "low";
  } catch { /* ignore */ }
  probe.src = url;
  if (typeof probe.decode === "function") {
    probe.decode().catch(() => {});
  }
}

/**
 * Pre-decode the next still image as `ImageBitmap` so opening the crop editor avoids waiting on `<img>` decode.
 * Falls back to `warmImageDecodeProbe` when `createImageBitmap` is unavailable or fails (e.g. some HEIC).
 */
function warmCropPreviewBitmap(file, prefetchToken) {
  const key = fileCacheKey(file);
  if (cropPreviewBitmapByKey.has(key)) return;
  if (typeof createImageBitmap !== "function") {
    warmImageDecodeProbe(file);
    return;
  }
  void createCappedImageBitmapForCropPreview(file)
    .then((bm) => {
      if (prefetchToken !== cropPreviewPrefetchToken) {
        try {
          bm.close();
        } catch { /* ignore */ }
        return;
      }
      if (cropPreviewBitmapByKey.has(key)) {
        try {
          bm.close();
        } catch { /* ignore */ }
        return;
      }
      cropPreviewBitmapByKey.set(key, bm);
    })
    .catch(() => {
      warmImageDecodeProbe(file);
    });
}

/**
 * Decode several upcoming photos in the background so advancing the crop queue is snappier.
 */
function scheduleCropPreviewPrefetch() {
  if (!workItems.length || isCropReviewFinished()) return;
  const ahead = prefetchAheadCount();
  if (ahead <= 0) {
    revokeDistantPreviewBlobUrls();
    return;
  }
  const my = ++cropPreviewPrefetchToken;
  const run = () => {
    if (my !== cropPreviewPrefetchToken) return;
    revokeDistantPreviewBlobUrls();
    /** Prefetch older (forward) items we will open next when confirming toward the past. */
    const fi = cropItemForwardIndex();
    const start = Math.max(0, fi - ahead);
    for (let i = start; i < fi; i++) {
      const f = workItems[i];
      warmCropPreviewBitmap(f, my);
    }
  };
  requestAnimationFrame(() => {
    if (my !== cropPreviewPrefetchToken) return;
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(run, { timeout: 120 });
    } else {
      setTimeout(run, 0);
    }
  });
}

function setProgress(visible, pct, text, options) {
  const indeterminate = options && options.indeterminate;
  /** While `startModelLoadElapsedUi` runs, it owns `progressLine` text; only update the bar for shard % etc. */
  const skipTextLine = options && options.skipTextLine;
  if (progressLine) {
    progressLine.hidden = !visible;
    if (visible) progressLine.removeAttribute("hidden");
    else progressLine.setAttribute("hidden", "");
  }
  if (progressBar) {
    progressBar.hidden = !visible;
    if (visible) progressBar.removeAttribute("hidden");
    else progressBar.setAttribute("hidden", "");
  }
  if (!visible) {
    if (progressLine) progressLine.textContent = "";
    if (progressBar && progressFill) {
      progressBar.classList.remove("progress--indeterminate");
      progressFill.classList.remove("progress__fill--indeterminate");
      progressFill.style.width = "";
    }
  } else if (progressLine && !skipTextLine && text !== undefined) {
    progressLine.textContent = text;
  }
  if (progressFill && progressBar) {
    progressBar.classList.toggle("progress--indeterminate", Boolean(indeterminate));
    progressFill.classList.toggle("progress__fill--indeterminate", Boolean(indeterminate));
    if (indeterminate) {
      progressFill.style.width = "";
      progressBar.removeAttribute("aria-valuenow");
      progressBar.setAttribute("aria-valuetext", "In progress");
    } else {
      const p = Math.max(0, Math.min(100, pct));
      progressFill.style.width = `${p}%`;
      progressBar.setAttribute("aria-valuenow", String(Math.round(p)));
      progressBar.removeAttribute("aria-valuetext");
    }
  }
}

function clearModelLoadElapsedTimer() {
  if (modelLoadElapsedTimer != null) {
    clearInterval(modelLoadElapsedTimer);
    modelLoadElapsedTimer = null;
  }
}

/** Elapsed time while analysis dependencies load (can be slow on first visit). */
function startModelLoadElapsedUi() {
  clearModelLoadElapsedTimer();
  const t0 = Date.now();
  const tick = () => {
    const sec = Math.floor((Date.now() - t0) / 1000);
    const base = modelLoadStageText || "Preparing…";
    const suffix = sec >= 1 ? ` (${sec}s)` : "";
    const hint = modelWeightShardTotal === 0 && sec >= 8 ? " — first run can be slow" : "";
    progressLine.textContent = `${base}${suffix}${hint}`;
  };
  tick();
  modelLoadElapsedTimer = setInterval(tick, 500);
}

function stopModelLoadElapsedUi() {
  clearModelLoadElapsedTimer();
  if (progressLine && progressLine.hidden) progressLine.textContent = "";
}

function setModelLoadStage(text) {
  modelLoadStageText = text;
  progressLine.textContent = text.endsWith("…") ? text : `${text}…`;
}

/**
 * Show an error banner. Optional `err` adds a scrollable technical block (stack trace when available).
 * @param {string} msg
 * @param {unknown} [err]
 */
function showError(msg, err) {
  errorLine.hidden = false;
  errorLine.replaceChildren();
  const summary = document.createElement("p");
  summary.className = "error-line__summary";
  summary.textContent = msg;
  errorLine.appendChild(summary);
  const tech = errorTechnicalAppendix(err);
  if (tech) {
    const pre = document.createElement("pre");
    pre.className = "error-line__diag";
    pre.textContent = tech;
    errorLine.appendChild(pre);
  }
}

function clearError() {
  errorLine.hidden = true;
  errorLine.replaceChildren();
}

/** Non-fatal: IndexedDB session could not be saved — user may lose reload recovery. */
function setSessionPersistNotice(text) {
  if (!sessionPersistWarning) return;
  if (!text) {
    sessionPersistWarning.hidden = true;
    sessionPersistWarning.textContent = "";
    return;
  }
  sessionPersistWarning.textContent = text;
  sessionPersistWarning.hidden = false;
}

function clearSessionPersistNotice() {
  setSessionPersistNotice("");
}

/** Stack trace or other technical detail for UI (capped). Omits duplicate of `message` when it matches `msg` prefix. */
function errorStackBlock(err, maxChars) {
  const cap = maxChars != null ? maxChars : 5000;
  if (err == null) return "";
  let stack = "";
  if (typeof err === "object" && err !== null && typeof err.stack === "string") {
    stack = err.stack.trim();
  }
  if (stack) return stack.length > cap ? `${stack.slice(0, cap)}…` : stack;
  return "";
}

function errorTechnicalAppendix(err) {
  if (err == null) return "";
  const stack = errorStackBlock(err, 5000);
  if (stack) return stack;
  if (typeof err === "string") return err.length > 2000 ? `${err.slice(0, 2000)}…` : err;
  if (err instanceof Error) {
    const line = `${err.name || "Error"}: ${err.message || "(no message)"}`;
    return line;
  }
  if (typeof err === "object") {
    try {
      const j = JSON.stringify(err);
      if (j && j !== "{}") return j.length > 2000 ? `${j.slice(0, 2000)}…` : j;
    } catch {
      /* fall through */
    }
  }
  try {
    const s = String(err);
    return s === "[object Object]" ? "" : s.length > 2000 ? `${s.slice(0, 2000)}…` : s;
  } catch {
    return "";
  }
}

/** Short, user-visible detail from thrown values (Error, string, or other). */
function errorDetailForUser(err, maxLen) {
  const cap = maxLen != null ? maxLen : 400;
  if (err == null) return "";
  if (typeof err === "string") return err.length > cap ? `${err.slice(0, cap)}…` : err;
  if (err instanceof Error) {
    const m = err.message || String(err);
    return m.length > cap ? `${m.slice(0, cap)}…` : m;
  }
  try {
    const s = String(err);
    return s.length > cap ? `${s.slice(0, cap)}…` : s;
  } catch {
    return "Unknown error";
  }
}

/** Progress UI for Download ZIP on the export step (after all crops are confirmed). */
function setZipDownloadProgress(visible, pct, text, options) {
  const indeterminate = options && options.indeterminate;
  if (!zipDownloadPanel || !zipDownloadLine || !zipDownloadBar || !zipDownloadFill) return;
  zipDownloadPanel.hidden = !visible;
  zipDownloadBar.hidden = !visible;
  if (text !== undefined) zipDownloadLine.textContent = text;
  zipDownloadBar.classList.toggle("progress--indeterminate", Boolean(indeterminate));
  zipDownloadFill.classList.toggle("progress__fill--indeterminate", Boolean(indeterminate));
  if (!visible) {
    zipDownloadFill.style.width = "";
    zipDownloadBar.removeAttribute("aria-valuenow");
    zipDownloadBar.removeAttribute("aria-valuetext");
    return;
  }
  if (indeterminate) {
    zipDownloadFill.style.width = "";
    zipDownloadBar.removeAttribute("aria-valuenow");
    zipDownloadBar.setAttribute("aria-valuetext", "In progress");
  } else {
    const p = Math.max(0, Math.min(100, pct));
    zipDownloadFill.style.width = `${p}%`;
    zipDownloadBar.setAttribute("aria-valuenow", String(Math.round(p)));
    zipDownloadBar.removeAttribute("aria-valuetext");
  }
}

/** Share button prep on export page (encoding JPEGs for the share sheet). */
function setSharePrepProgress(visible, pct, text, options) {
  const indeterminate = options && options.indeterminate;
  if (!sharePrepProgress || !sharePrepLine || !sharePrepBar || !sharePrepFill) return;
  sharePrepProgress.hidden = !visible;
  sharePrepBar.hidden = !visible;
  if (text !== undefined) sharePrepLine.textContent = text;
  sharePrepBar.classList.toggle("progress--indeterminate", Boolean(indeterminate));
  sharePrepFill.classList.toggle("progress__fill--indeterminate", Boolean(indeterminate));
  if (!visible) {
    sharePrepFill.style.width = "";
    sharePrepBar.removeAttribute("aria-valuenow");
    sharePrepBar.removeAttribute("aria-valuetext");
    return;
  }
  if (indeterminate) {
    sharePrepFill.style.width = "";
    sharePrepBar.removeAttribute("aria-valuenow");
    sharePrepBar.setAttribute("aria-valuetext", "In progress");
  } else {
    const p = Math.max(0, Math.min(100, pct));
    sharePrepFill.style.width = `${p}%`;
    sharePrepBar.setAttribute("aria-valuenow", String(Math.round(p)));
    sharePrepBar.removeAttribute("aria-valuetext");
  }
}

/** Reduce long-press selection / callout on crop surface (especially iOS). */
function attachCropInteractionGuards(root) {
  const block = (e) => {
    e.preventDefault();
  };
  root.addEventListener("selectstart", block);
  root.addEventListener("contextmenu", block);
  root.addEventListener("dragstart", block);
  let touchT = 0;
  root.addEventListener(
    "touchstart",
    (e) => {
      touchT = Date.now();
    },
    { passive: true }
  );
  root.addEventListener(
    "touchend",
    (e) => {
      if (Date.now() - touchT > 320) e.preventDefault();
    },
    { passive: false }
  );
  root.addEventListener("touchcancel", () => {
    touchT = 0;
  });
}

function canShareImageFiles(files) {
  if (!files.length || typeof navigator.share !== "function") return false;
  if (typeof navigator.canShare !== "function") return true;
  try {
    return navigator.canShare({ files });
  } catch {
    return true;
  }
}

function pickShareableImageFiles(files) {
  if (!files.length) return [];
  const normalized = files.map((f) => {
    const n = f.name || "";
    if (/\.jpe?g$/i.test(n) && (!f.type || f.type === "application/octet-stream")) {
      return new File([f], n, { type: "image/jpeg", lastModified: f.lastModified });
    }
    return f;
  });
  const images = normalized.filter((f) => (f.type || "").startsWith("image/"));
  if (images.length && canShareImageFiles(images)) return images;
  if (canShareImageFiles(normalized)) return normalized;
  return images;
}

/** Download ZIP / Share only on `#page-export` after review (never while `#page-crop` is visible). */
function updateCropExportActionsVisibility() {
  const onExportPage = pageExport && !pageExport.hidden;
  const show = onExportPage && workItems.length > 0 && isCropReviewFinished();
  if (exportFooterBar) exportFooterBar.hidden = !show;
  if (inatUploadSection) inatUploadSection.hidden = !show;
  if (show) {
    releaseCropPrefetchAfterReviewFinished();
    renderInatPhotoGroupingStrip();
  } else if (inatUploadGrouping && inatUploadGroupingStrip) {
    inatUploadGrouping.hidden = true;
    inatUploadGroupingStrip.replaceChildren();
  }
}

function updateSharePrepUiDisplay() {
  const onExportPage = pageExport && !pageExport.hidden;
  const zipReady =
    workItems.length > 0 &&
    workItems.some((f) => cropState.get(fileCacheKey(f))) &&
    isCropReviewFinished();
  const sharePrepVisible =
    onExportPage &&
    zipReady &&
    typeof navigator.share === "function" &&
    shareSheetPrepRunning;
  if (!sharePrepVisible) {
    setSharePrepProgress(false, 0, "", {});
    return;
  }
  const line =
    sharePrepStatusText ||
    (shareSheetBuildTotal > 0
      ? `Preparing Share… ${shareSheetBuildIndex} / ${shareSheetBuildTotal}`
      : "Preparing Share…");
  const pct =
    shareSheetBuildTotal > 0
      ? Math.round((shareSheetBuildIndex / shareSheetBuildTotal) * 100)
      : 0;
  setSharePrepProgress(true, pct, line, { indeterminate: shareSheetBuildTotal <= 0 });
}

function updateButtons() {
  const hasExportable =
    workItems.length > 0 &&
    workItems.some((f) => {
      const st = cropState.get(fileCacheKey(f));
      return st;
    });
  const zipReady = hasExportable && isCropReviewFinished();
  btnCrop.disabled = !zipReady;
  if (btnShareInat) {
    const onExportPage = pageExport && !pageExport.hidden;
    const shareNothingReady =
      onExportPage &&
      zipReady &&
      typeof navigator.share === "function" &&
      Array.isArray(shareSheetReadyFiles) &&
      shareSheetReadyFiles.length === 0;
    /** Android Chrome: multi-file share is unsafe; we block before encoding (no background share build). */
    const shareAndroidMultiUnsafe =
      onExportPage &&
      zipReady &&
      typeof navigator.share === "function" &&
      workItems.length > 1 &&
      isAndroidBrowser();
    btnShareInat.disabled =
      !zipReady ||
      typeof navigator.share !== "function" ||
      shareSheetPrepRunning ||
      shareNothingReady ||
      shareAndroidMultiUnsafe;
    btnShareInat.title = shareSheetPrepRunning
      ? "Preparing images for share…"
      : shareNothingReady
        ? "Nothing to share — use Download ZIP"
        : shareAndroidMultiUnsafe
          ? "Chrome on Android can crash when sharing several images — use Download ZIP"
          : "Share JPEGs only";
  }
  if (btnInatUploadObs) {
    btnInatUploadObs.disabled =
      !zipReady || !inatUploadAuthOk || inatUploadInProgress || inatBulkCvInProgress;
  }
  if (btnInatCvAll) {
    btnInatCvAll.disabled =
      !zipReady || !inatUploadAuthOk || inatUploadInProgress || inatBulkCvInProgress;
  }
  updateCropExportActionsVisibility();
  updateSharePrepUiDisplay();
  if (workItems.length) schedulePersistSession();
}

function setInatUploadStatusVariant(variant) {
  if (!inatUploadStatus) return;
  inatUploadStatus.classList.remove("inat-upload-status--ok", "inat-upload-status--error", "inat-upload-status--neutral");
  if (variant === "ok") inatUploadStatus.classList.add("inat-upload-status--ok");
  else if (variant === "error") inatUploadStatus.classList.add("inat-upload-status--error");
  else inatUploadStatus.classList.add("inat-upload-status--neutral");
}

function clearInatUploadIdentityAndCollisions() {
  inatMeUserId = 0;
  inatMeLogin = "";
  resetInatObservedTimeCollisionState();
}

async function refreshInatUploadAuthUi() {
  if (!inatUploadStatus || !inatUploadTokenField) return;
  inatUploadAuthOk = false;
  updateButtons();
  const jwt = getStoredInatApiJwt();
  if (!jwt) {
    clearInatUploadIdentityAndCollisions();
    inatUploadTokenField.hidden = false;
    inatUploadStatus.textContent =
      "No API token saved. Paste the JSON or a raw JWT from iNaturalist (same storage as the observation browser), then Apply.";
    setInatUploadStatusVariant("neutral");
    updateButtons();
    return;
  }
  const format = validateInatJwtFormat(jwt);
  if (!format.ok) {
    clearInatUploadIdentityAndCollisions();
    inatUploadTokenField.hidden = false;
    inatUploadStatus.textContent = `Stored token failed the format check: ${format.error} Clear it and paste again.`;
    setInatUploadStatusVariant("error");
    updateButtons();
    return;
  }
  let res;
  try {
    res = await fetchUsersMeWithStoredJwt();
  } catch {
    clearInatUploadIdentityAndCollisions();
    inatUploadStatus.textContent = "Could not reach iNaturalist to verify the saved token.";
    setInatUploadStatusVariant("error");
    inatUploadTokenField.hidden = false;
    updateButtons();
    return;
  }
  if (!res.ok) {
    clearInatUploadIdentityAndCollisions();
    const detail = await formatInatHttpErrorForDisplay(res);
    inatUploadStatus.textContent = `Token not accepted: ${detail} Try a fresh token from iNaturalist.`;
    setInatUploadStatusVariant("error");
    inatUploadTokenField.hidden = false;
    updateButtons();
    return;
  }
  let data;
  try {
    data = await res.json();
  } catch {
    clearInatUploadIdentityAndCollisions();
    inatUploadStatus.textContent = "Unexpected response while verifying the token.";
    setInatUploadStatusVariant("error");
    inatUploadTokenField.hidden = false;
    updateButtons();
    return;
  }
  const u = data && Array.isArray(data.results) ? data.results[0] : null;
  const login = u && typeof u.login === "string" ? u.login.trim() : "";
  inatMeLogin = login;
  let uid = 0;
  if (u && u.id != null) {
    if (typeof u.id === "number" && Number.isFinite(u.id)) uid = Math.floor(u.id);
    else if (typeof u.id === "string" && /^\d+$/.test(String(u.id).trim())) uid = parseInt(String(u.id).trim(), 10);
  }
  inatMeUserId = uid > 0 ? uid : 0;
  resetInatObservedTimeCollisionState();
  inatUploadAuthOk = true;
  inatUploadTokenField.hidden = true;
  if (inatUploadToken) inatUploadToken.value = "";
  inatUploadStatus.textContent = login
    ? `Signed in as ${login}. You can upload observations below.`
    : "Signed in. You can upload observations below.";
  setInatUploadStatusVariant("ok");
  updateButtons();
  scheduleInatObservedTimeCollisionCheck(true);
}

/** @param {{ dtStr?: string, lat?: number, lon?: number, lastModified?: number }} meta */
function observedOnStringFromMeta(meta) {
  const lm = meta && typeof meta.lastModified === "number" && Number.isFinite(meta.lastModified) ? meta.lastModified : Date.now();
  const d = new Date(lm);
  if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 19).replace("T", " ");
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `${y}-${mo}-${day} ${h}:${mi}:${s}`;
}

const INAT_EXISTING_OBS_CACHE_MS = 5 * 60 * 1000;
const INAT_EXISTING_OBS_MAX_PAGES = 25;

function resetInatObservedTimeCollisionState() {
  inatPhotoObservedCollisionFlags = null;
  inatObservedCollisionSig = "";
  inatExistingObservedSecondsSet.clear();
  inatExistingObsSecondsFetchedAt = 0;
  if (inatObservedCollisionTimer) {
    window.clearTimeout(inatObservedCollisionTimer);
    inatObservedCollisionTimer = 0;
  }
}

/**
 * Populate `inatExistingObservedSecondsSet` from the signed-in user's observations (paginated).
 * Observations without `time_observed_at` are skipped (date-only times cannot match EXIF seconds reliably).
 * @param {boolean} force bypass short TTL cache
 */
async function fetchInatExistingObservationObservedSecondsIfStale(force) {
  const now = Date.now();
  if (
    !force &&
    inatExistingObsSecondsFetchedAt > 0 &&
    now - inatExistingObsSecondsFetchedAt < INAT_EXISTING_OBS_CACHE_MS
  ) {
    return;
  }
  if (!inatUploadAuthOk || (!inatMeUserId && !inatMeLogin)) {
    inatExistingObservedSecondsSet.clear();
    inatExistingObsSecondsFetchedAt = 0;
    return;
  }
  const qUser =
    inatMeUserId > 0
      ? `user_id=${inatMeUserId}`
      : `user_login=${encodeURIComponent(inatMeLogin)}`;
  const next = new Set();
  const perPage = 200;
  let gotOkPage = false;
  for (let page = 1; page <= INAT_EXISTING_OBS_MAX_PAGES; page++) {
    const res = await inatFetch(
      `observations?${qUser}&verifiable=any&per_page=${perPage}&page=${page}&order_by=observed_on&order=desc`,
      { auth: true }
    );
    if (!res.ok) break;
    gotOkPage = true;
    let data;
    try {
      data = await res.json();
    } catch {
      break;
    }
    const rows = Array.isArray(data.results) ? data.results : [];
    for (const o of rows) {
      const raw = o && o.time_observed_at;
      if (typeof raw !== "string" || !raw.trim()) continue;
      const ms = Date.parse(raw.trim());
      if (!Number.isNaN(ms)) next.add(Math.floor(ms / 1000));
    }
    if (rows.length < perPage) break;
  }
  if (gotOkPage) {
    inatExistingObservedSecondsSet = next;
    inatExistingObsSecondsFetchedAt = Date.now();
  } else if (force) {
    inatExistingObservedSecondsSet.clear();
    inatExistingObsSecondsFetchedAt = 0;
  }
}

function scheduleInatObservedTimeCollisionCheck(forceObsFetch = false) {
  if (inatObservedCollisionTimer) window.clearTimeout(inatObservedCollisionTimer);
  inatObservedCollisionTimer = window.setTimeout(() => {
    inatObservedCollisionTimer = 0;
    void runInatObservedTimeCollisionCheck(forceObsFetch);
  }, 260);
}

/**
 * Compare each batch photo's EXIF/file `lastModified` instant (same basis as upload `observed_on_string`)
 * against observed UTC seconds from the user's existing observations.
 * @param {boolean} forceObsFetch
 */
async function runInatObservedTimeCollisionCheck(forceObsFetch = false) {
  const sig = workItems.map((f) => fileCacheKey(f)).join("\0");
  if (!inatUploadAuthOk || (!inatMeUserId && !inatMeLogin) || !workItems.length || !isCropReviewFinished()) {
    inatPhotoObservedCollisionFlags = null;
    inatObservedCollisionSig = "";
    return;
  }
  try {
    await fetchInatExistingObservationObservedSecondsIfStale(forceObsFetch);
    if (workItems.map((f) => fileCacheKey(f)).join("\0") !== sig) return;
    const n = workItems.length;
    const flags = new Array(n);
    if (!inatExistingObservedSecondsSet.size) {
      for (let i = 0; i < n; i++) flags[i] = false;
    } else {
      for (let i = 0; i < n; i++) {
        const m = await extractMetaForEmbedding(workItems[i]);
        flags[i] = inatExistingObservedSecondsSet.has(Math.floor(m.lastModified / 1000));
        if (i % 4 === 3) await new Promise((r) => setTimeout(r, 0));
      }
    }
    if (workItems.map((f) => fileCacheKey(f)).join("\0") !== sig) return;
    inatPhotoObservedCollisionFlags = flags;
    inatObservedCollisionSig = sig;
    if (inatUploadGrouping && !inatUploadGrouping.hidden) renderInatPhotoGroupingStrip();
  } catch (e) {
    console.error(e);
  }
}

/** @param {any} data */
function observationIdFromCreateJson(data) {
  if (!data || typeof data !== "object") return null;
  if (typeof data.id === "number" && data.id > 0) return Math.floor(data.id);
  if (typeof data.id === "string" && /^\d+$/.test(data.id)) return parseInt(data.id, 10);
  if (Array.isArray(data) && data.length) {
    const x = data[0];
    if (x && typeof x.id === "number" && x.id > 0) return Math.floor(x.id);
    if (x && typeof x.id === "string" && /^\d+$/.test(x.id)) return parseInt(x.id, 10);
  }
  const r = data.results;
  if (Array.isArray(r) && r.length) {
    const x = r[0];
    if (x && typeof x.id === "number" && x.id > 0) return Math.floor(x.id);
  }
  return null;
}

function initInatUploadGroups() {
  const n = workItems.length;
  if (n <= 0) {
    inatUploadGroups = [];
    inatUploadGroupsInitializedForN = -1;
    return;
  }
  /** One iNaturalist observation per photo until the user merges cards by drag-and-drop. */
  inatUploadGroups = Array.from({ length: n }, (_, i) => ({
    indices: [i],
    species: "",
    taxonId: "",
  }));
  inatUploadGroupsInitializedForN = n;
}

/** Build observation groups from capture times: consecutive photos ≤30s apart stay in one group. */
function initInatUploadGroupsTimeClusteredFromCache() {
  const n = workItems.length;
  if (n <= 0) {
    inatUploadGroups = [];
    inatUploadGroupsInitializedForN = -1;
    return;
  }
  const times =
    workItemCaptureTimesMs && workItemCaptureTimesMs.length === n
      ? workItemCaptureTimesMs
      : workItems.map((f) => f.lastModified);
  const groups = [];
  let cur = /** @type {number[]} */ ([]);
  let prevMs = null;
  for (let i = 0; i < n; i++) {
    const t = times[i];
    if (cur.length && prevMs != null && t - prevMs > INAT_TIME_CLUSTER_WINDOW_MS) {
      groups.push({ indices: [...cur], species: "", taxonId: "" });
      cur = [];
    }
    cur.push(i);
    prevMs = t;
  }
  if (cur.length) groups.push({ indices: [...cur], species: "", taxonId: "" });
  inatUploadGroups = groups;
  inatUploadGroupsInitializedForN = n;
}

/**
 * Ensure every index 0..n-1 appears exactly once across groups; empty `indices` allowed (extra drop target).
 * Otherwise reset.
 */
function validateInatUploadGroupsOrInit() {
  const n = workItems.length;
  if (n <= 0) {
    inatUploadGroups = [];
    inatUploadGroupsInitializedForN = -1;
    return;
  }
  if (inatUploadGroupsInitializedForN !== n) {
    initInatUploadGroups();
    return;
  }
  const seen = new Set();
  let count = 0;
  for (const g of inatUploadGroups) {
    if (!g || !Array.isArray(g.indices)) {
      initInatUploadGroups();
      return;
    }
    for (const ix of g.indices) {
      if (!Number.isFinite(ix) || ix < 0 || ix >= n || seen.has(ix)) {
        initInatUploadGroups();
        return;
      }
      seen.add(ix);
      count++;
    }
  }
  if (count !== n) initInatUploadGroups();
}

function normalizeInatUploadGroupsRemoveEmpty() {
  if (inatUploadGroups.length <= 1) return;
  inatUploadGroups = inatUploadGroups.filter((g) => g.indices && g.indices.length > 0);
  if (inatUploadGroups.length === 0) initInatUploadGroups();
}

/**
 * Move one photo out of its group and insert a new single-photo observation at a gap (insertBeforeGroup index 0..n).
 * @param {number} photoIdx
 * @param {number} fromG
 * @param {number} fromPos
 * @param {number} insertBeforeGroup
 */
function insertPhotoAsNewGroupAtGap(photoIdx, fromG, fromPos, insertBeforeGroup) {
  validateInatUploadGroupsOrInit();
  const n = inatUploadGroups.length;
  if (insertBeforeGroup < 0 || insertBeforeGroup > n) return;
  const src = inatUploadGroups[fromG];
  if (!src || fromPos < 0 || fromPos >= src.indices.length) return;
  if (src.indices[fromPos] !== photoIdx) return;

  const groups = inatUploadGroups.map((g) => {
    const o = {
      species: g.species || "",
      taxonId: g.taxonId || "",
      indices: [...g.indices],
    };
    if (
      typeof g.manualLat === "number" &&
      Number.isFinite(g.manualLat) &&
      typeof g.manualLon === "number" &&
      Number.isFinite(g.manualLon)
    ) {
      o.manualLat = g.manualLat;
      o.manualLon = g.manualLon;
    }
    return o;
  });
  groups[fromG].indices.splice(fromPos, 1);
  const newG = { indices: [photoIdx], species: "", taxonId: "" };
  if (
    typeof src.manualLat === "number" &&
    Number.isFinite(src.manualLat) &&
    typeof src.manualLon === "number" &&
    Number.isFinite(src.manualLon)
  ) {
    newG.manualLat = src.manualLat;
    newG.manualLon = src.manualLon;
  }
  groups.splice(insertBeforeGroup, 0, newG);
  inatUploadGroups = groups.filter((g) => g.indices && g.indices.length > 0);
  if (inatUploadGroups.length === 0) initInatUploadGroups();
}

/**
 * @param {number} photoIdx
 * @param {number} fromG
 * @param {number} fromPos
 * @param {number} toG
 * @param {number | null} insertBeforePhotoIdx
 */
function movePhotoBetweenGroups(photoIdx, fromG, fromPos, toG, insertBeforePhotoIdx) {
  if (!inatUploadGroups[fromG] || !inatUploadGroups[toG]) return;
  const srcGrp = inatUploadGroups[fromG];
  const destGrp = inatUploadGroups[toG];
  const destHasManual =
    typeof destGrp.manualLat === "number" &&
    Number.isFinite(destGrp.manualLat) &&
    typeof destGrp.manualLon === "number" &&
    Number.isFinite(destGrp.manualLon) &&
    isValidObservationLatLon(destGrp.manualLat, destGrp.manualLon);
  const srcHasManual =
    typeof srcGrp.manualLat === "number" &&
    Number.isFinite(srcGrp.manualLat) &&
    typeof srcGrp.manualLon === "number" &&
    Number.isFinite(srcGrp.manualLon) &&
    isValidObservationLatLon(srcGrp.manualLat, srcGrp.manualLon);
  const movingLastFromSrc = srcGrp.indices.length === 1;
  const transferManualToDest =
    fromG !== toG && movingLastFromSrc && !destHasManual && srcHasManual
      ? { lat: srcGrp.manualLat, lon: srcGrp.manualLon }
      : null;
  inatUploadGroups[fromG].indices.splice(fromPos, 1);
  const dest = inatUploadGroups[toG].indices;
  let insertAt = dest.length;
  if (insertBeforePhotoIdx != null && insertBeforePhotoIdx !== photoIdx) {
    const i = dest.indexOf(insertBeforePhotoIdx);
    if (i >= 0) insertAt = i;
  }
  dest.splice(insertAt, 0, photoIdx);
  normalizeInatUploadGroupsRemoveEmpty();
  if (transferManualToDest) {
    destGrp.manualLat = transferManualToDest.lat;
    destGrp.manualLon = transferManualToDest.lon;
  }
}

function hideAllInatGroupSpeciesSuggests() {
  if (!inatUploadGroupingStrip) return;
  for (const ul of inatUploadGroupingStrip.querySelectorAll(".inat-group-species-suggest")) {
    ul.hidden = true;
    ul.replaceChildren();
  }
  for (const inp of inatUploadGroupingStrip.querySelectorAll(".inat-group-species")) {
    inp.setAttribute("aria-expanded", "false");
  }
  inatSpeciesSuggestActiveCard = null;
  inatSpeciesSuggestHighlight = -1;
}

/** @param {HTMLElement} card */
function hideInatGroupSpeciesSuggest(card) {
  const ul = card.querySelector(".inat-group-species-suggest");
  const inp = card.querySelector(".inat-group-species");
  if (ul) {
    ul.hidden = true;
    ul.replaceChildren();
  }
  if (inp) inp.setAttribute("aria-expanded", "false");
  if (inatSpeciesSuggestActiveCard === card) {
    inatSpeciesSuggestActiveCard = null;
    inatSpeciesSuggestHighlight = -1;
  }
}

/**
 * @param {HTMLElement} card
 * @param {any[]} results
 */
function renderInatSpeciesSuggestionsForCard(card, results) {
  const ul = card.querySelector(".inat-group-species-suggest");
  const inp = card.querySelector(".inat-group-species");
  if (!ul || !inp) return;
  ul.replaceChildren();
  inatSpeciesSuggestHighlight = -1;
  const items = Array.isArray(results) ? results : [];
  if (!items.length) {
    hideInatGroupSpeciesSuggest(card);
    return;
  }
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const id = item.id != null ? Number(item.id) : NaN;
    if (!Number.isFinite(id) || id <= 0) continue;
    const sci = typeof item.name === "string" ? item.name.trim() : "";
    const common = typeof item.preferred_common_name === "string" ? item.preferred_common_name.trim() : "";
    const label = common || sci || `Taxon ${id}`;
    const li = document.createElement("li");
    li.setAttribute("role", "option");
    li.dataset.taxonId = String(id);
    li.className = "inat-species-suggest__item";
    const main = document.createElement("div");
    main.className = "inat-species-suggest__main";
    main.textContent = label;
    li.appendChild(main);
    if (common && sci && common !== sci) {
      const sub = document.createElement("div");
      sub.className = "inat-species-suggest__sci";
      sub.textContent = sci;
      li.appendChild(sub);
    }
    li.addEventListener("mousedown", (ev) => {
      ev.preventDefault();
      const g = parseInt(card.dataset.groupIdx || "", 10);
      if (!Number.isFinite(g) || g < 0 || !inatUploadGroups[g]) return;
      inatSpeciesSelectingProgrammatic = true;
      inp.value = label;
      inatUploadGroups[g].species = label;
      inatUploadGroups[g].taxonId = String(id);
      inatSpeciesSelectingProgrammatic = false;
      hideInatGroupSpeciesSuggest(card);
    });
    ul.appendChild(li);
  }
  ul.hidden = false;
  inp.setAttribute("aria-expanded", "true");
  inatSpeciesSuggestActiveCard = card;
}

/** @param {any} data */
function firstTaxonGuessFromScoreImageJson(data) {
  const rows = data && Array.isArray(data.results) ? data.results : [];
  for (const row of rows) {
    const t = row && row.taxon;
    if (!t || typeof t !== "object") continue;
    const id = t.id != null ? Number(t.id) : NaN;
    if (!Number.isFinite(id) || id <= 0) continue;
    const sci = typeof t.name === "string" ? t.name.trim() : "";
    const common = typeof t.preferred_common_name === "string" ? t.preferred_common_name.trim() : "";
    const label = common || sci || `Taxon ${id}`;
    return { id: String(id), label };
  }
  return null;
}

/**
 * POST the first photo to iNaturalist `computervision/score_image`; returns parsed JSON.
 * @param {File} file
 */
async function fetchInatComputervisionScoreImageJsonForFile(file) {
  const meta = await extractMetaForEmbedding(file);
  const fd = new FormData();
  fd.append("image", file, file.name || "photo.jpg");
  if (
    typeof meta.lat === "number" &&
    typeof meta.lon === "number" &&
    Number.isFinite(meta.lat) &&
    Number.isFinite(meta.lon)
  ) {
    fd.append("lat", String(meta.lat));
    fd.append("lng", String(meta.lon));
  }
  const res = await inatFetch("computervision/score_image", { method: "POST", auth: true, body: fd });
  if (!res.ok) {
    const detail = await formatInatHttpErrorForDisplay(res);
    throw new Error(detail || `Computer vision failed (${res.status}).`);
  }
  try {
    return await res.json();
  } catch {
    throw new Error("Could not parse computer vision response.");
  }
}

/**
 * POST the image to iNaturalist computer vision; returns top taxon label and id.
 * @param {File} file
 */
async function fetchInatComputervisionFirstGuessForFile(file) {
  const data = await fetchInatComputervisionScoreImageJsonForFile(file);
  const guess = firstTaxonGuessFromScoreImageJson(data);
  if (!guess) throw new Error("Computer vision returned no taxon suggestions.");
  return guess;
}

/**
 * @param {number} g
 * @param {{ id: string; label: string }} guess
 */
function applyInatCvGuessToGroupUi(g, guess) {
  const card = inatUploadGroupingStrip?.querySelector(`.inat-group-card[data-group-idx="${g}"]`);
  inatSpeciesSelectingProgrammatic = true;
  if (inatUploadGroups[g]) {
    inatUploadGroups[g].species = guess.label;
    inatUploadGroups[g].taxonId = guess.id;
  }
  if (card) {
    const inp = card.querySelector(".inat-group-species");
    const hid = card.querySelector(".inat-group-taxon-id");
    if (inp) inp.value = guess.label;
    if (hid) hid.value = guess.id;
    hideInatGroupSpeciesSuggest(card);
  }
  inatSpeciesSelectingProgrammatic = false;
}

/**
 * @param {HTMLElement} card
 * @param {HTMLButtonElement} btn
 * @param {number} g
 */
async function handleInatGroupCvClick(card, btn, g) {
  clearError();
  if (inatUploadInProgress) {
    showError("Wait for the current upload to finish, then try again.");
    return;
  }
  if (inatBulkCvInProgress) {
    showError("Wait for Vision all to finish, then try again.");
    return;
  }
  if (!inatApiJwtAuthorizationValue() || !inatUploadAuthOk) {
    showError("Apply a valid API token first.");
    return;
  }
  const grp = inatUploadGroups[g];
  if (!grp || !grp.indices.length) {
    showError("Add at least one photo to this card before running computer vision.");
    return;
  }
  const ix = grp.indices[0];
  const file = workItems[ix];
  if (!file) return;
  btn.disabled = true;
  btn.setAttribute("aria-busy", "true");
  try {
    const guess = await fetchInatComputervisionFirstGuessForFile(file);
    applyInatCvGuessToGroupUi(g, guess);
  } catch (err) {
    console.error(err);
    const msg = err && typeof err === "object" && "message" in err ? String(err.message) : String(err);
    showError(msg);
  } finally {
    btn.disabled = false;
    btn.removeAttribute("aria-busy");
  }
}

/**
 * @param {HTMLElement} card
 * @param {HTMLButtonElement} btn
 * @param {number} g
 */
async function handleInatGroupCvJsonClick(card, btn, g) {
  clearError();
  if (inatUploadInProgress) {
    showError("Wait for the current upload to finish, then try again.");
    return;
  }
  if (inatBulkCvInProgress) {
    showError("Wait for Vision all to finish, then try again.");
    return;
  }
  if (!inatApiJwtAuthorizationValue() || !inatUploadAuthOk) {
    showError("Apply a valid API token first.");
    return;
  }
  const grp = inatUploadGroups[g];
  if (!grp || !grp.indices.length) {
    showError("Add at least one photo to this card before fetching computer vision.");
    return;
  }
  const ix = grp.indices[0];
  const file = workItems[ix];
  if (!file) return;
  btn.disabled = true;
  btn.setAttribute("aria-busy", "true");
  try {
    const data = await fetchInatComputervisionScoreImageJsonForFile(file);
    showInatCvResultsDialog(data);
  } catch (err) {
    console.error(err);
    const msg = err && typeof err === "object" && "message" in err ? String(err.message) : String(err);
    showError(msg);
  } finally {
    btn.disabled = false;
    btn.removeAttribute("aria-busy");
  }
}

/** Run computer vision on the first photo of every observation row (sequential, with a short delay between API calls). */
async function runInatCvForAllObservations() {
  clearError();
  if (inatUploadInProgress) {
    showError("Wait for the current upload to finish, then try again.");
    return;
  }
  if (inatBulkCvInProgress) return;
  if (!inatApiJwtAuthorizationValue() || !inatUploadAuthOk) {
    showError("Apply a valid API token first.");
    return;
  }
  validateInatUploadGroupsOrInit();
  const nonempty = inatUploadGroups.filter((g) => g && g.indices && g.indices.length > 0);
  if (!nonempty.length) {
    showError("No observation rows with photos to run computer vision on.");
    return;
  }
  inatBulkCvInProgress = true;
  updateButtons();
  if (btnInatCvAll) btnInatCvAll.setAttribute("aria-busy", "true");
  try {
    let afterFirst = false;
    for (let g = 0; g < inatUploadGroups.length; g++) {
      const grp = inatUploadGroups[g];
      if (!grp || !grp.indices.length) continue;
      if (afterFirst) await new Promise((r) => setTimeout(r, 350));
      afterFirst = true;
      const ix = grp.indices[0];
      const file = workItems[ix];
      if (!file) continue;
      const data = await fetchInatComputervisionScoreImageJsonForFile(file);
      const guess = firstTaxonGuessFromScoreImageJson(data);
      if (guess) applyInatCvGuessToGroupUi(g, guess);
    }
  } catch (err) {
    console.error(err);
    const msg = err && typeof err === "object" && "message" in err ? String(err.message) : String(err);
    showError(msg);
  } finally {
    inatBulkCvInProgress = false;
    if (btnInatCvAll) btnInatCvAll.removeAttribute("aria-busy");
    updateButtons();
  }
}

/** @param {HTMLElement} card */
function scheduleInatSpeciesAutocompleteQuery(card, q) {
  if (inatSpeciesDebounceTimer) clearTimeout(inatSpeciesDebounceTimer);
  if (q.length < 2) {
    hideInatGroupSpeciesSuggest(card);
    return;
  }
  inatSpeciesDebounceTimer = window.setTimeout(async () => {
    try {
      const res = await inatFetch(`taxa/autocomplete?q=${encodeURIComponent(q)}&per_page=12`);
      const data = res.ok ? await res.json() : { results: [] };
      renderInatSpeciesSuggestionsForCard(card, data.results || []);
    } catch {
      hideInatGroupSpeciesSuggest(card);
    }
  }, 280);
}

function clearInatDnDDropHighlight() {
  if (inatDnDDropHighlightEl) {
    try {
      inatDnDDropHighlightEl.classList.remove("inat-group-drop--over", "inat-group-gap-drop--over");
    } catch {
      /* ignore */
    }
  }
  inatDnDDropHighlightEl = null;
  if (inatUploadGroupingStrip) {
    for (const el of inatUploadGroupingStrip.querySelectorAll(".inat-group-drop--over, .inat-group-gap-drop--over")) {
      el.classList.remove("inat-group-drop--over", "inat-group-gap-drop--over");
    }
    inatUploadGroupingStrip.classList.remove("inat-upload-grouping-strip--dnd");
  }
}

function wireInatUploadGroupingDelegated() {
  if (inatUploadGroupingDelegated || !inatUploadGroupingStrip) return;
  inatUploadGroupingDelegated = true;

  inatUploadGroupingStrip.addEventListener("input", (e) => {
    const inp = /** @type {HTMLElement | null} */ (e.target && "closest" in e.target ? e.target.closest(".inat-group-species") : null);
    if (!inp) return;
    const card = inp.closest(".inat-group-card");
    if (!card) return;
    const g = parseInt(card.dataset.groupIdx || "", 10);
    if (!Number.isFinite(g) || !inatUploadGroups[g]) return;
    inatUploadGroups[g].species = inp.value;
    if (!inatSpeciesSelectingProgrammatic) inatUploadGroups[g].taxonId = "";
    scheduleInatSpeciesAutocompleteQuery(card, inp.value.trim());
  });

  inatUploadGroupingStrip.addEventListener("keydown", (e) => {
    const inp = document.activeElement;
    if (!inp || !inp.classList || !inp.classList.contains("inat-group-species")) return;
    const card = inp.closest(".inat-group-card");
    if (!card) return;
    const ul = card.querySelector(".inat-group-species-suggest");
    if (!ul || ul.hidden) return;
    const items = ul.querySelectorAll("li");
    if (!items.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      inatSpeciesSuggestHighlight = Math.min(inatSpeciesSuggestHighlight + 1, items.length - 1);
      items.forEach((li, i) => li.setAttribute("aria-selected", i === inatSpeciesSuggestHighlight ? "true" : "false"));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      inatSpeciesSuggestHighlight = Math.max(inatSpeciesSuggestHighlight - 1, 0);
      items.forEach((li, i) => li.setAttribute("aria-selected", i === inatSpeciesSuggestHighlight ? "true" : "false"));
    } else if (e.key === "Enter" && inatSpeciesSuggestHighlight >= 0) {
      e.preventDefault();
      const li = items[inatSpeciesSuggestHighlight];
      if (li) li.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    } else if (e.key === "Escape") {
      hideInatGroupSpeciesSuggest(card);
    }
  });

  inatUploadGroupingStrip.addEventListener("click", (e) => {
    const locClear = e.target && "closest" in e.target ? e.target.closest(".inat-group-loc-clear") : null;
    if (locClear instanceof HTMLButtonElement) {
      e.preventDefault();
      const card = locClear.closest(".inat-group-card");
      if (!card) return;
      const g = parseInt(card.dataset.groupIdx || "", 10);
      if (!Number.isFinite(g) || !inatUploadGroups[g]) return;
      clearInatLocationOverrideForGroup(g);
      return;
    }
    const locBtn = e.target && "closest" in e.target ? e.target.closest(".inat-group-loc-btn") : null;
    if (locBtn instanceof HTMLButtonElement && !locBtn.classList.contains("inat-group-loc-clear")) {
      e.preventDefault();
      const card = locBtn.closest(".inat-group-card");
      if (!card) return;
      const g = parseInt(card.dataset.groupIdx || "", 10);
      if (!Number.isFinite(g) || !inatUploadGroups[g]) return;
      void openInatLocationPickerForGroup(g);
      return;
    }
    const btn = e.target && "closest" in e.target ? e.target.closest(".inat-group-cv-btn") : null;
    if (btn instanceof HTMLButtonElement && !btn.classList.contains("inat-group-cv-json-btn")) {
      e.preventDefault();
      const card = btn.closest(".inat-group-card");
      if (!card) return;
      const g = parseInt(card.dataset.groupIdx || "", 10);
      if (!Number.isFinite(g) || !inatUploadGroups[g]) return;
      void handleInatGroupCvClick(card, btn, g);
      return;
    }
    const cvJson = e.target && "closest" in e.target ? e.target.closest(".inat-group-cv-json-btn") : null;
    if (cvJson instanceof HTMLButtonElement) {
      e.preventDefault();
      const card = cvJson.closest(".inat-group-card");
      if (!card) return;
      const g = parseInt(card.dataset.groupIdx || "", 10);
      if (!Number.isFinite(g) || !inatUploadGroups[g]) return;
      void handleInatGroupCvJsonClick(card, cvJson, g);
      return;
    }
  });

  inatUploadGroupingStrip.addEventListener("pointerdown", (e) => {
    if (!e.isPrimary || e.button !== 0) return;
    const tile = e.target && "closest" in e.target ? e.target.closest(".inat-dnd-tile") : null;
    if (!(tile instanceof HTMLElement) || !inatUploadGroupingStrip.contains(tile)) return;
    const ix = parseInt(tile.dataset.photoIdx || "", 10);
    if (!Number.isFinite(ix) || ix < 0 || ix >= workItems.length || !workItems[ix]) return;
    resetInatStripTileGesture();
    inatStripTileGesture = {
      photoIdx: ix,
      downTs: performance.now(),
      x0: e.clientX,
      y0: e.clientY,
      pointerId: e.pointerId,
      longArmed: false,
      dragDid: false,
      movedPastSlop: false,
    };
    window.addEventListener("pointermove", inatStripTileGlobalPointerMove, true);
    window.addEventListener("pointerup", inatStripTileGlobalPointerEnd, true);
    window.addEventListener("pointercancel", inatStripTileGlobalPointerEnd, true);
    inatStripTileLongHoldTimer = window.setTimeout(() => {
      inatStripTileLongHoldTimer = 0;
      if (!inatStripTileGesture) return;
      inatStripTileGesture.longArmed = true;
    }, INAT_STRIP_LONG_HOLD_MS);
  });

  inatUploadGroupingStrip.addEventListener("dragstart", (e) => {
    const tile = e.target && "closest" in e.target ? e.target.closest(".inat-dnd-tile") : null;
    if (tile && e instanceof DragEvent && e.dataTransfer) resetInatStripTileGesture();
    if (!tile || !(e instanceof DragEvent) || !e.dataTransfer) return;
    const idx = parseInt(tile.dataset.photoIdx || "", 10);
    if (!Number.isFinite(idx)) return;
    e.dataTransfer.setData("application/x-inat-photo-idx", String(idx));
    e.dataTransfer.setData("text/plain", String(idx));
    e.dataTransfer.effectAllowed = "move";
    tile.classList.add("inat-dnd-tile--dragging");
    inatUploadGroupingStrip.classList.add("inat-upload-grouping-strip--dnd");
    try {
      const ghostImg = tile.querySelector("img");
      if (ghostImg instanceof HTMLImageElement && ghostImg.complete && ghostImg.naturalWidth > 0) {
        const ox = Math.floor(Math.min(56, ghostImg.naturalWidth) / 2);
        const oy = Math.floor(Math.min(56, ghostImg.naturalHeight) / 2);
        e.dataTransfer.setDragImage(ghostImg, ox, oy);
      }
    } catch {
      /* setDragImage unsupported or failed */
    }
  });

  inatUploadGroupingStrip.addEventListener("dragend", (e) => {
    const tile = e.target && "closest" in e.target ? e.target.closest(".inat-dnd-tile") : null;
    if (tile) tile.classList.remove("inat-dnd-tile--dragging");
    clearInatDnDDropHighlight();
  });

  inatUploadGroupingStrip.addEventListener("dragover", (e) => {
    if (!(e instanceof DragEvent) || !e.dataTransfer) return;
    const t = e.target;
    if (!(t instanceof Node) || !inatUploadGroupingStrip.contains(t)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    inatUpdatePhotoDnDHighlightFromPointer(e.clientX, e.clientY);
  });

  inatUploadGroupingStrip.addEventListener("dragleave", (e) => {
    if (!(e instanceof DragEvent)) return;
    const strip = inatUploadGroupingStrip;
    if (!strip) return;
    const r = strip.getBoundingClientRect();
    const x = e.clientX;
    const y = e.clientY;
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return;
    if (inatDnDDropHighlightEl) {
      try {
        inatDnDDropHighlightEl.classList.remove("inat-group-drop--over", "inat-group-gap-drop--over");
      } catch {
        /* ignore */
      }
      inatDnDDropHighlightEl = null;
    }
    for (const el of strip.querySelectorAll(".inat-group-drop--over, .inat-group-gap-drop--over")) {
      el.classList.remove("inat-group-drop--over", "inat-group-gap-drop--over");
    }
  });

  inatUploadGroupingStrip.addEventListener("drop", (e) => {
    if (!(e instanceof DragEvent) || !e.dataTransfer) return;
    const photoIdx = parseInt(e.dataTransfer.getData("application/x-inat-photo-idx") || e.dataTransfer.getData("text/plain") || "", 10);
    if (!Number.isFinite(photoIdx)) return;

    const hit =
      inatResolvePhotoDnDHit(e.clientX, e.clientY) ?? inatFallbackPhotoDnDHitFromTarget(e.target);

    if (hit?.kind === "gap") {
      const gap = hit.el;
      e.preventDefault();
      clearInatDnDDropHighlight();
      const insertBeforeGroup = parseInt(gap.dataset.insertBeforeGroup || "", 10);
      if (!Number.isFinite(insertBeforeGroup)) return;

      let fromG = -1;
      let fromPos = -1;
      for (let g = 0; g < inatUploadGroups.length; g++) {
        const p = inatUploadGroups[g].indices.indexOf(photoIdx);
        if (p >= 0) {
          fromG = g;
          fromPos = p;
          break;
        }
      }
      if (fromG < 0) return;

      insertPhotoAsNewGroupAtGap(photoIdx, fromG, fromPos, insertBeforeGroup);
      hideAllInatGroupSpeciesSuggests();
      renderInatPhotoGroupingStrip();
      return;
    }

    if (hit?.kind !== "card") return;
    const drop = hit.dropEl;
    e.preventDefault();
    clearInatDnDDropHighlight();
    const card = drop.closest(".inat-group-card");
    if (!card) return;
    const toG = parseInt(card.dataset.groupIdx || "", 10);
    if (!Number.isFinite(toG) || !inatUploadGroups[toG]) return;

    let fromG = -1;
    let fromPos = -1;
    for (let g = 0; g < inatUploadGroups.length; g++) {
      const p = inatUploadGroups[g].indices.indexOf(photoIdx);
      if (p >= 0) {
        fromG = g;
        fromPos = p;
        break;
      }
    }
    if (fromG < 0) return;

    const overTile = hit.overTile;
    let insertBefore = null;
    if (overTile) {
      const cand = parseInt(overTile.dataset.photoIdx || "", 10);
      if (Number.isFinite(cand) && cand !== photoIdx) insertBefore = cand;
    }
    movePhotoBetweenGroups(photoIdx, fromG, fromPos, toG, insertBefore);
    hideAllInatGroupSpeciesSuggests();
    renderInatPhotoGroupingStrip();
  });

  document.addEventListener("click", (e) => {
    const t = /** @type {Node} */ (e.target);
    if (inatUploadGroupingStrip && !inatUploadGroupingStrip.contains(t)) hideAllInatGroupSpeciesSuggests();
  });
}

function openInatGroupingCropEditor(photoIdx) {
  inatGroupEditForwardIndex = photoIdx;
  const file = workItems[photoIdx];
  if (!file) return;
  cropReviewDoneKeys.delete(fileCacheKey(file));
  cropReviewIndex = workItems.length - 1 - photoIdx;
  setCurrentPage("crop");
  renderCropEditorSlot();
  updateCropReviewChrome();
  updateButtons();
}

async function confirmInatGroupingSingleEditAndReturn() {
  const photoIdx = inatGroupEditForwardIndex;
  const file =
    photoIdx >= 0 && photoIdx < workItems.length
      ? workItems[photoIdx]
      : null;
  if (file) {
    const k = fileCacheKey(file);
    if (cropState.has(k)) cropReviewDoneKeys.add(k);
  }
  inatGroupEditForwardIndex = -1;
  setCurrentPage("export");
  if (file) {
    try {
      await rebuildInatGroupingThumbNow(file);
    } catch {
      /* strip render will fall back to ensureInatGroupingThumbUrl */
    }
  }
  renderInatPhotoGroupingStrip();
  updateButtons();
}

let leafletScriptPromise = null;
/** @type {any} */
let inatLocationLeafletMap = null;
/** @type {any} */
let inatLocationLeafletMarker = null;
let inatLocationPickerGroupIdx = -1;

function loadLeafletLibraryOnce() {
  if (typeof globalThis !== "undefined" && globalThis.L) return Promise.resolve();
  if (leafletScriptPromise) return leafletScriptPromise;
  leafletScriptPromise = new Promise((resolve, reject) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
    link.crossOrigin = "";
    document.head.appendChild(link);
    const s = document.createElement("script");
    s.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
    s.crossOrigin = "";
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      leafletScriptPromise = null;
      reject(new Error("Could not load map library."));
    };
    document.head.appendChild(s);
  });
  return leafletScriptPromise;
}

function tearDownInatLocationLeafletUi() {
  if (inatLocationLeafletMap) {
    try {
      inatLocationLeafletMap.remove();
    } catch {
      /* ignore */
    }
  }
  inatLocationLeafletMap = null;
  inatLocationLeafletMarker = null;
}

function hideInatLocationPickerDialog() {
  if (inatLocLatInput) inatLocLatInput.oninput = null;
  if (inatLocLonInput) inatLocLonInput.oninput = null;
  tearDownInatLocationLeafletUi();
  if (inatLocationPickerDialog) inatLocationPickerDialog.hidden = true;
  inatLocationPickerGroupIdx = -1;
}

function hideInatCvResultsDialog() {
  if (inatCvResultsDialog) inatCvResultsDialog.hidden = true;
}

/**
 * @param {unknown} data
 */
function showInatCvResultsDialog(data) {
  if (!inatCvResultsDialog || !inatCvResultsPre) return;
  try {
    inatCvResultsPre.textContent = JSON.stringify(data, null, 2);
  } catch {
    inatCvResultsPre.textContent = String(data);
  }
  inatCvResultsDialog.hidden = false;
  inatCvResultsDialog.removeAttribute("hidden");
  try {
    if (btnInatCvResultsClose) btnInatCvResultsClose.focus();
  } catch {
    /* ignore */
  }
}

function formatCoordForDisplay(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(5);
}

function syncInatLocationInputsFromLatLng(lat, lon) {
  if (inatLocLatInput) inatLocLatInput.value = Number.isFinite(lat) ? String(lat) : "";
  if (inatLocLonInput) inatLocLonInput.value = Number.isFinite(lon) ? String(lon) : "";
}

function readInatLocationInputsLatLng() {
  const lat = inatLocLatInput ? parseFloat(String(inatLocLatInput.value).trim()) : NaN;
  const lon = inatLocLonInput ? parseFloat(String(inatLocLonInput.value).trim()) : NaN;
  return { lat, lon };
}

function isValidObservationLatLon(lat, lon) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -85 &&
    lat <= 85 &&
    lon >= -180 &&
    lon <= 180
  );
}

async function groupHasEmbeddedPhotoGps(grp) {
  if (!grp || !Array.isArray(grp.indices)) return false;
  for (const ix of grp.indices) {
    const file = workItems[ix];
    if (!file) continue;
    try {
      const m = await extractMetaForEmbedding(file);
      if (
        typeof m.lat === "number" &&
        typeof m.lon === "number" &&
        Number.isFinite(m.lat) &&
        Number.isFinite(m.lon)
      ) {
        return true;
      }
    } catch {
      /* ignore */
    }
  }
  return false;
}

async function openInatLocationPickerForGroup(groupIdx) {
  if (!Number.isFinite(groupIdx) || groupIdx < 0 || !inatUploadGroups[groupIdx]) return;
  inatLocationPickerGroupIdx = groupIdx;
  const grp = inatUploadGroups[groupIdx];
  if (!inatLocationPickerDialog) return;
  inatLocationPickerDialog.hidden = false;
  try {
    await loadLeafletLibraryOnce();
  } catch (e) {
    console.error(e);
    hideInatLocationPickerDialog();
    showError("Could not load the map. Check your connection and try again.", e);
    return;
  }
  const L = globalThis.L;
  if (!L || !inatLocationMapEl) {
    hideInatLocationPickerDialog();
    showError("Map is unavailable in this browser.");
    return;
  }
  tearDownInatLocationLeafletUi();
  let lat =
    typeof grp.manualLat === "number" && Number.isFinite(grp.manualLat) ? grp.manualLat : 20;
  let lon =
    typeof grp.manualLon === "number" && Number.isFinite(grp.manualLon) ? grp.manualLon : 0;
  const zoom = lat === 20 && lon === 0 ? 2 : 13;
  try {
    inatLocationLeafletMap = L.map(inatLocationMapEl, { zoomControl: true }).setView([lat, lon], zoom);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>',
    }).addTo(inatLocationLeafletMap);
    inatLocationLeafletMarker = L.marker([lat, lon], { draggable: true }).addTo(inatLocationLeafletMap);
    inatLocationLeafletMarker.on("dragend", () => {
      const ll = inatLocationLeafletMarker.getLatLng();
      syncInatLocationInputsFromLatLng(ll.lat, ll.lng);
    });
    inatLocationLeafletMap.on("click", (ev) => {
      const ll = ev.latlng;
      inatLocationLeafletMarker.setLatLng(ll);
      syncInatLocationInputsFromLatLng(ll.lat, ll.lng);
    });
    syncInatLocationInputsFromLatLng(lat, lon);
    const onInput = () => {
      const { lat: la, lon: lo } = readInatLocationInputsLatLng();
      if (isValidObservationLatLon(la, lo) && inatLocationLeafletMarker && inatLocationLeafletMap) {
        const ll = L.latLng(la, lo);
        inatLocationLeafletMarker.setLatLng(ll);
        inatLocationLeafletMap.panTo(ll);
      }
    };
    if (inatLocLatInput) {
      inatLocLatInput.oninput = onInput;
      inatLocLonInput.oninput = onInput;
    }
    window.setTimeout(() => {
      try {
        inatLocationLeafletMap.invalidateSize();
      } catch {
        /* ignore */
      }
    }, 280);
    try {
      btnInatLocationApply && btnInatLocationApply.focus();
    } catch {
      /* ignore */
    }
  } catch (e) {
    console.error(e);
    hideInatLocationPickerDialog();
    showError("Could not start the map.", e);
  }
}

function applyInatLocationPickerToGroup() {
  const g = inatLocationPickerGroupIdx;
  if (!Number.isFinite(g) || g < 0 || !inatUploadGroups[g]) {
    hideInatLocationPickerDialog();
    return;
  }
  const { lat, lon } = readInatLocationInputsLatLng();
  if (!isValidObservationLatLon(lat, lon)) {
    showError("Enter a valid latitude (−85…85) and longitude (−180…180), or drag the pin on the map.");
    return;
  }
  inatUploadGroups[g].manualLat = lat;
  inatUploadGroups[g].manualLon = lon;
  hideInatLocationPickerDialog();
  renderInatPhotoGroupingStrip();
  updateButtons();
}

function clearInatLocationOverrideForGroup(groupIdx) {
  if (!Number.isFinite(groupIdx) || groupIdx < 0 || !inatUploadGroups[groupIdx]) return;
  delete inatUploadGroups[groupIdx].manualLat;
  delete inatUploadGroups[groupIdx].manualLon;
  renderInatPhotoGroupingStrip();
  updateButtons();
}

function wireInatLocationPickerDialog() {
  if (!inatLocationPickerDialog || !btnInatLocationApply || !btnInatLocationCancel) return;
  const backdrop = inatLocationPickerDialog.querySelector(".reapply-dialog__backdrop");
  const finishHide = () => hideInatLocationPickerDialog();
  btnInatLocationApply.addEventListener("click", () => applyInatLocationPickerToGroup());
  btnInatLocationCancel.addEventListener("click", finishHide);
  if (backdrop) backdrop.addEventListener("click", finishHide);
  if (btnInatLocationClear) {
    btnInatLocationClear.addEventListener("click", () => {
      const g = inatLocationPickerGroupIdx;
      if (Number.isFinite(g) && g >= 0) clearInatLocationOverrideForGroup(g);
      finishHide();
    });
  }
  if (btnInatLocationUseDevice) {
    btnInatLocationUseDevice.addEventListener("click", () => {
      if (!navigator.geolocation) {
        showError("This browser does not expose device location.");
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const la = pos.coords.latitude;
          const lo = pos.coords.longitude;
          syncInatLocationInputsFromLatLng(la, lo);
          if (inatLocationLeafletMarker && inatLocationLeafletMap && globalThis.L) {
            const ll = globalThis.L.latLng(la, lo);
            inatLocationLeafletMarker.setLatLng(ll);
            inatLocationLeafletMap.setView(ll, 14);
            try {
              inatLocationLeafletMap.invalidateSize();
            } catch {
              /* ignore */
            }
          }
        },
        (err) => {
          showError(`Location unavailable: ${err && err.message ? err.message : "permission or hardware"}`);
        },
        { enableHighAccuracy: true, maximumAge: 60_000, timeout: 20_000 }
      );
    });
  }
  document.addEventListener("keydown", (e) => {
    if (inatLocationPickerDialog && !inatLocationPickerDialog.hidden && e.key === "Escape") {
      e.preventDefault();
      finishHide();
    }
  });
}

wireInatLocationPickerDialog();

function wireInatCvResultsDialog() {
  if (!inatCvResultsDialog || !btnInatCvResultsClose) return;
  const backdrop = inatCvResultsDialog.querySelector(".reapply-dialog__backdrop");
  const finishHide = () => hideInatCvResultsDialog();
  btnInatCvResultsClose.addEventListener("click", finishHide);
  if (backdrop) backdrop.addEventListener("click", finishHide);
  if (btnInatCvResultsCopy && inatCvResultsPre) {
    btnInatCvResultsCopy.addEventListener("click", async () => {
      const t = inatCvResultsPre.textContent || "";
      if (!t) return;
      try {
        await navigator.clipboard.writeText(t);
      } catch {
        showError("Could not copy to clipboard.");
      }
    });
  }
  document.addEventListener("keydown", (e) => {
    if (inatCvResultsDialog && !inatCvResultsDialog.hidden && e.key === "Escape") {
      e.preventDefault();
      finishHide();
    }
  });
}

wireInatCvResultsDialog();

function renderInatPhotoGroupingStrip() {
  if (!inatUploadGrouping || !inatUploadGroupingStrip) return;
  const n = workItems.length;
  if (!n || !isCropReviewFinished()) {
    inatUploadGrouping.hidden = true;
    inatUploadGroupingStrip.replaceChildren();
    clearInatDnDDropHighlight();
    return;
  }
  if (inatUploadGroupsInitializedForN !== n) {
    initInatUploadGroupsTimeClusteredFromCache();
  } else {
    validateInatUploadGroupsOrInit();
  }
  inatUploadGrouping.hidden = false;
  hideAllInatGroupSpeciesSuggests();
  clearInatDnDDropHighlight();
  inatUploadGroupingStrip.replaceChildren();

  /** @param {number} insertBefore */
  const appendGap = (insertBefore) => {
    const gap = document.createElement("div");
    gap.className = "inat-group-gap-drop";
    gap.dataset.insertBeforeGroup = String(insertBefore);
    gap.setAttribute("aria-label", "Drop a thumbnail here to start a new observation with that photo");
    gap.title = "New observation";
    inatUploadGroupingStrip.appendChild(gap);
  };

  for (let g = 0; g < inatUploadGroups.length; g++) {
    appendGap(g);
    const grp = inatUploadGroups[g];
    const card = document.createElement("section");
    card.className = "inat-group-card";
    card.dataset.groupIdx = String(g);

    const speciesField = document.createElement("div");
    speciesField.className = "inat-species-field";
    const hid = document.createElement("input");
    hid.type = "hidden";
    hid.className = "inat-group-taxon-id";
    hid.value = grp.taxonId || "";
    const wrap = document.createElement("div");
    wrap.className = "inat-species-wrap";
    const inp = document.createElement("input");
    inp.type = "text";
    inp.id = `inat-group-species-${g}`;
    inp.className = "inat-upload-input inat-group-species";
    inp.maxLength = 200;
    inp.autocomplete = "off";
    inp.placeholder = "Search iNaturalist taxa, or leave blank for Unknown";
    inp.setAttribute("aria-label", "Species search (optional)");
    inp.setAttribute("aria-autocomplete", "list");
    inp.setAttribute("aria-expanded", "false");
    inp.value = grp.species || "";
    const sug = document.createElement("ul");
    sug.className = "inat-species-suggest inat-group-species-suggest";
    sug.setAttribute("role", "listbox");
    sug.hidden = true;
    wrap.appendChild(inp);
    wrap.appendChild(sug);
    const speciesRow = document.createElement("div");
    speciesRow.className = "inat-species-row";
    speciesRow.appendChild(wrap);
    const cvBtn = document.createElement("button");
    cvBtn.type = "button";
    cvBtn.className = "btn secondary inat-group-cv-btn";
    cvBtn.textContent = "Vision";
    cvBtn.title = "Run iNaturalist computer vision on the first photo in this group and fill the top suggestion";
    cvBtn.setAttribute("aria-label", "Run computer vision for top species suggestion");
    const cvJsonBtn = document.createElement("button");
    cvJsonBtn.type = "button";
    cvJsonBtn.className = "btn secondary inat-group-cv-json-btn";
    cvJsonBtn.textContent = "CV JSON";
    cvJsonBtn.title = "Fetch and show the full computervision/score_image API response for the first photo";
    cvJsonBtn.setAttribute("aria-label", "Show full computer vision API JSON");
    const cvActions = document.createElement("div");
    cvActions.className = "inat-group-cv-actions";
    cvActions.appendChild(cvBtn);
    cvActions.appendChild(cvJsonBtn);
    speciesRow.appendChild(cvActions);
    speciesField.appendChild(hid);
    speciesField.appendChild(speciesRow);
    card.appendChild(speciesField);

    const locRow = document.createElement("div");
    locRow.className = "inat-group-location-row";
    const summaryEl = document.createElement("div");
    summaryEl.className = "inat-group-location-summary";
    summaryEl.textContent = "Checking photo location…";
    const pickBtn = document.createElement("button");
    pickBtn.type = "button";
    pickBtn.className = "btn secondary inat-group-loc-btn";
    pickBtn.textContent = "Pick on map";
    pickBtn.title = "Set latitude and longitude when photos have no GPS";
    pickBtn.setAttribute("aria-label", "Pick observation location on map");
    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "btn secondary inat-group-loc-btn inat-group-loc-clear";
    clearBtn.textContent = "Clear map location";
    clearBtn.title = "Remove coordinates chosen on the map";
    clearBtn.setAttribute("aria-label", "Clear map location");
    clearBtn.hidden = true;
    locRow.appendChild(summaryEl);
    locRow.appendChild(pickBtn);
    locRow.appendChild(clearBtn);
    card.appendChild(locRow);
    void groupHasEmbeddedPhotoGps(grp).then((hasGps) => {
      if (!inatUploadGroupingStrip || !inatUploadGroupingStrip.contains(card)) return;
      if (card.dataset.groupIdx !== String(g)) return;
      const cur = inatUploadGroups[g];
      if (!cur) return;
      const manual =
        typeof cur.manualLat === "number" &&
        Number.isFinite(cur.manualLat) &&
        typeof cur.manualLon === "number" &&
        Number.isFinite(cur.manualLon) &&
        isValidObservationLatLon(cur.manualLat, cur.manualLon);
      if (hasGps) {
        pickBtn.hidden = true;
        clearBtn.hidden = !manual;
        if (manual) {
          summaryEl.hidden = false;
          summaryEl.textContent = `Using map location: ${formatCoordForDisplay(cur.manualLat)}, ${formatCoordForDisplay(cur.manualLon)}.`;
        } else {
          summaryEl.textContent = "";
          summaryEl.hidden = true;
        }
      } else if (manual) {
        summaryEl.hidden = false;
        summaryEl.textContent = `Using map location: ${formatCoordForDisplay(cur.manualLat)}, ${formatCoordForDisplay(cur.manualLon)}.`;
        pickBtn.hidden = false;
        pickBtn.textContent = "Edit on map";
        clearBtn.hidden = false;
      } else {
        summaryEl.hidden = false;
        summaryEl.textContent = "No GPS in these photos — set a map location before upload (recommended).";
        pickBtn.hidden = false;
        pickBtn.textContent = "Pick on map";
        clearBtn.hidden = true;
      }
    });

    const drop = document.createElement("div");
    drop.className = "inat-group-drop";
    drop.setAttribute(
      "aria-label",
      "Photo thumbnails — quick tap to adjust crop; press and hold, then drag to regroup. Drop on another observation to combine, or on a dashed row for a new observation",
    );
    for (const ix of grp.indices) {
      if (ix < 0 || ix >= workItems.length) continue;
      const file = workItems[ix];
      const tile = document.createElement("div");
      tile.className = "inat-dnd-tile";
      tile.draggable = true;
      tile.dataset.photoIdx = String(ix);
      const thumb = document.createElement("div");
      thumb.className = "inat-dnd-tile__thumb";
      const img = document.createElement("img");
      img.alt = "";
      img.loading = "lazy";
      img.draggable = false;
      try {
        void ensureInatGroupingThumbUrl(file)
          .then((u) => {
            img.src = u;
          })
          .catch(() => {
            thumb.textContent = "◆";
            thumb.classList.add("inat-dnd-tile__thumb--fallback");
          });
      } catch {
        /* ignore */
      }
      img.addEventListener("error", () => {
        thumb.textContent = "◆";
        thumb.classList.add("inat-dnd-tile__thumb--fallback");
      });
      thumb.appendChild(img);
      tile.appendChild(thumb);
      if (inatPhotoObservedCollisionFlags && inatPhotoObservedCollisionFlags[ix]) {
        const mark = document.createElement("span");
        mark.className = "inat-dnd-tile__obs-dup";
        mark.textContent = "!";
        mark.title =
          "This photo’s observed date and time (EXIF or file time) match an existing iNaturalist observation on your account — same instant to the second.";
        mark.setAttribute("aria-label", mark.title);
        tile.appendChild(mark);
      }
      drop.appendChild(tile);
    }
    card.appendChild(drop);
    inatUploadGroupingStrip.appendChild(card);
  }
  appendGap(inatUploadGroups.length);

  wireInatUploadGroupingDelegated();

  if (inatUploadAuthOk && (inatMeUserId > 0 || inatMeLogin)) {
    const sig = workItems.map((f) => fileCacheKey(f)).join("\0");
    if (sig && sig !== inatObservedCollisionSig) scheduleInatObservedTimeCollisionCheck(false);
  }
}

/**
 * Build JPEG + original source pairs for iNat upload (same order as ZIP export).
 * @param {(info: { phase: string, index: number, total: number, label?: string }) => void} [onProgress]
 * @returns {Promise<{ jpegFile: File, sourceFile: File }[]>}
 */
async function ensureJpegPairsForInatUpload(onProgress) {
  const built = await buildExportFilesListForZip(onProgress, "iNaturalist");
  const pairs = [];
  const n = built.files.length;
  for (let i = 0; i < n; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 0));
    const f = built.files[i];
    const src = built.sourceFiles[i];
    const mime = (f.type || "").toLowerCase();
    const nameLooksJpeg = /\.jpe?g$/i.test(f.name || "");
    const isJpegMime = mime === "image/jpeg" || mime === "image/jpg";
    let jpegFile;
    if (isJpegMime || (nameLooksJpeg && mime.startsWith("image/"))) {
      const name = nameLooksJpeg ? exportFilenameWithJpgExt(f.name) : `${stripFileExtension(f.name)}.jpg`;
      jpegFile = new File([f], name, { type: "image/jpeg", lastModified: f.lastModified });
    } else if (src) {
      const jpegBlob = await encodeFullImageToJpegBlobForShare(src);
      jpegFile = new File([jpegBlob], `${stripFileExtension(f.name)}.jpg`, {
        type: "image/jpeg",
        lastModified: f.lastModified,
      });
    } else {
      continue;
    }
    pairs.push({ jpegFile, sourceFile: src || f });
    if (onProgress) onProgress({ phase: "inat", index: i + 1, total: n, label: `Prepare ${i + 1} / ${n}` });
  }
  return pairs;
}

async function attachPhotoToInatObservation(obsId, jpegFile) {
  const fd = new FormData();
  fd.append("file", jpegFile, jpegFile.name || "photo.jpg");
  fd.append("observation_photo[observation_id]", String(obsId));
  return inatFetch("observation_photos", { method: "POST", auth: true, body: fd });
}

/**
 * EXIF / embedded metadata for an observation: prefer the first group photo’s timestamps,
 * but merge latitude/longitude from any photo in the group that has GPS (covers merged groups).
 * @param {File[]} sourceFiles
 * @param {File[]} jpegFiles
 */
async function extractMetaForObservationFromSources(sourceFiles, jpegFiles) {
  const combined = [];
  for (const f of sourceFiles || []) if (f) combined.push(f);
  for (const j of jpegFiles || []) if (j && !combined.some((x) => x === j)) combined.push(j);
  if (!combined.length) {
    const d = new Date();
    return {
      dtStr: formatExifDate(d) || "",
      lat: undefined,
      lon: undefined,
      altitudeMeters: undefined,
      lastModified: d.getTime(),
    };
  }
  const metas = [];
  for (const f of combined) metas.push(await extractMetaForEmbedding(f));
  let merged = { ...metas[0] };
  for (let i = 1; i < metas.length; i++) {
    if (
      typeof merged.lat === "number" &&
      typeof merged.lon === "number" &&
      Number.isFinite(merged.lat) &&
      Number.isFinite(merged.lon)
    ) {
      break;
    }
    const m = metas[i];
    if (typeof m.lat === "number" && typeof m.lon === "number" && Number.isFinite(m.lat) && Number.isFinite(m.lon)) {
      merged = { ...merged, lat: m.lat, lon: m.lon };
      if (m.altitudeMeters != null && Number.isFinite(m.altitudeMeters)) merged.altitudeMeters = m.altitudeMeters;
    }
  }
  return merged;
}

/**
 * @param {(m: { kind: "observation_created" } | { kind: "photo_uploaded"; index: number; total: number }) => void} [onMilestone]
 * @param {number} [manualLat] — used when source files have no embedded GPS
 * @param {number} [manualLon]
 */
async function createInatObservationForGroup(
  jpegFiles,
  sourceFiles,
  speciesGuessText,
  taxonIdNum,
  onMilestone,
  manualLat,
  manualLon
) {
  if (!jpegFiles.length) throw new Error("Empty photo group.");
  const meta = await extractMetaForObservationFromSources(sourceFiles, jpegFiles);
  const observedOn = observedOnStringFromMeta(meta);
  const guess = (speciesGuessText || "").trim() || "Unknown";
  /** @type {Record<string, unknown>} */
  const obs = {
    species_guess: guess,
    observed_on_string: observedOn,
    geoprivacy: "open",
  };
  if (Number.isFinite(taxonIdNum) && taxonIdNum > 0) {
    obs.taxon_id = Math.floor(taxonIdNum);
  }
  if (
    typeof meta.lat === "number" &&
    typeof meta.lon === "number" &&
    Number.isFinite(meta.lat) &&
    Number.isFinite(meta.lon)
  ) {
    obs.latitude = meta.lat;
    obs.longitude = meta.lon;
  } else if (
    typeof manualLat === "number" &&
    typeof manualLon === "number" &&
    Number.isFinite(manualLat) &&
    Number.isFinite(manualLon) &&
    isValidObservationLatLon(manualLat, manualLon)
  ) {
    obs.latitude = manualLat;
    obs.longitude = manualLon;
  }
  const res = await inatFetch("observations", {
    method: "POST",
    auth: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ observation: obs }),
  });
  if (!res.ok) {
    const detail = await formatInatHttpErrorForDisplay(res);
    throw new Error(`Could not create observation: ${detail}`);
  }
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error("Could not parse observation create response.");
  }
  const id = observationIdFromCreateJson(data);
  if (!id) throw new Error("Observation created but the response did not include an id.");
  if (typeof onMilestone === "function") onMilestone({ kind: "observation_created" });
  for (let i = 0; i < jpegFiles.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 220));
    const photoRes = await attachPhotoToInatObservation(id, jpegFiles[i]);
    if (!photoRes.ok) {
      const d = await formatInatHttpErrorForDisplay(photoRes);
      throw new Error(`Observation ${id}: photo ${i + 1} upload failed: ${d}`);
    }
    if (typeof onMilestone === "function") {
      onMilestone({ kind: "photo_uploaded", index: i + 1, total: jpegFiles.length });
    }
  }
  return id;
}

/**
 * Hard blocks before any upload prep (e.g. invalid manual map coordinates).
 * @param {Array<{ indices: number[], manualLat?: number, manualLon?: number }>} nonemptyGroups
 * @returns {string[]}
 */
function gatherInatUploadPreflightBlockingErrors(nonemptyGroups) {
  const errors = [];
  for (let gi = 0; gi < nonemptyGroups.length; gi++) {
    const grp = nonemptyGroups[gi];
    const latN = typeof grp.manualLat === "number" && Number.isFinite(grp.manualLat);
    const lonN = typeof grp.manualLon === "number" && Number.isFinite(grp.manualLon);
    if (latN !== lonN) {
      errors.push(
        `Observation ${gi + 1}: map location is incomplete — set both latitude and longitude, or clear the map location.`,
      );
      continue;
    }
    if (latN && lonN && !isValidObservationLatLon(grp.manualLat, grp.manualLon)) {
      errors.push(
        `Observation ${gi + 1}: map location is invalid — open Pick on map and choose coordinates within valid ranges, or clear them.`,
      );
    }
  }
  return errors;
}

/**
 * Soft checks before upload prep (original files only — no JPEG export yet).
 * Only **species** and **location** gaps are returned for a user prompt; other issues (e.g. observed-time
 * collision hints) are surfaced in the UI elsewhere, not as upload blockers.
 * @param {Array<{ indices: number[], species?: string, taxonId?: string, manualLat?: number, manualLon?: number }>} nonemptyGroups
 * @returns {Promise<string[]>}
 */
async function gatherInatUploadPreflightWarnings(nonemptyGroups) {
  const uploadWarnings = [];
  for (let gi = 0; gi < nonemptyGroups.length; gi++) {
    const grp = nonemptyGroups[gi];
    const taxonRaw = (grp.taxonId || "").trim();
    const taxonIdNum = taxonRaw ? parseInt(taxonRaw, 10) : NaN;
    if (!Number.isFinite(taxonIdNum) || taxonIdNum <= 0) {
      uploadWarnings.push(
        `Observation ${gi + 1}: no species / taxon selected from the search field (iNaturalist observations are much more useful with an identification).`,
      );
    }
    const sources = [];
    for (const ix of grp.indices) {
      if (Number.isFinite(ix) && ix >= 0 && ix < workItems.length && workItems[ix]) sources.push(workItems[ix]);
    }
    const meta = await extractMetaForObservationFromSources(sources, []);
    const hasExifGps =
      typeof meta.lat === "number" &&
      typeof meta.lon === "number" &&
      Number.isFinite(meta.lat) &&
      Number.isFinite(meta.lon);
    const hasManualGps =
      typeof grp.manualLat === "number" &&
      typeof grp.manualLon === "number" &&
      Number.isFinite(grp.manualLat) &&
      Number.isFinite(grp.manualLon) &&
      isValidObservationLatLon(grp.manualLat, grp.manualLon);
    if (!hasExifGps && !hasManualGps) {
      uploadWarnings.push(
        `Observation ${gi + 1}: no GPS coordinates in the photo files — add a location on the website after upload, or use photos that include embedded location.`,
      );
    }
  }
  return uploadWarnings;
}

async function runInatObservationUpload() {
  clearError();
  if (!inatApiJwtAuthorizationValue() || !inatUploadAuthOk) {
    showError("Apply a valid API token first.");
    return;
  }
  if (inatBulkCvInProgress) {
    showError("Wait for Vision all to finish before uploading.");
    return;
  }
  const n = workItems.length;
  if (!n) return;

  validateInatUploadGroupsOrInit();

  const nonemptyGroups = inatUploadGroups.filter((g) => g && g.indices && g.indices.length > 0);
  if (!nonemptyGroups.length) {
    showError("Each observation needs at least one photo. Drag photos into the observation cards.");
    return;
  }

  const blocking = gatherInatUploadPreflightBlockingErrors(nonemptyGroups);
  if (blocking.length) {
    showError(blocking.join("\n\n"));
    return;
  }

  let uploadWarnings;
  try {
    uploadWarnings = await gatherInatUploadPreflightWarnings(nonemptyGroups);
  } catch (e) {
    console.error(e);
    const msg = e && typeof e === "object" && "message" in e ? String(e.message) : String(e);
    showError(`Could not read photo metadata before upload: ${msg}`);
    return;
  }

  if (uploadWarnings.length) {
    const proceed = await showInatUploadWarningsDialog(uploadWarnings.join("\n\n"));
    if (!proceed) return;
  }

  const PREPARE_PORTION = 0.42;
  const prepareStepsTotal = Math.max(1, 2 * n);
  let prepareStepsDone = 0;

  showInatUploadProgressUi();
  setInatUploadProgressUi(0, "Preparing files…");

  let pairs;
  try {
    pairs = await ensureJpegPairsForInatUpload((info) => {
      prepareStepsDone += 1;
      const label = info && info.label ? info.label : "Preparing…";
      const frac = (prepareStepsDone / prepareStepsTotal) * PREPARE_PORTION;
      setInatUploadProgressUi(frac, label);
    });
  } catch (e) {
    console.error(e);
    resetInatUploadProgressUi();
    const msg = e && typeof e === "object" && "message" in e ? String(e.message) : String(e);
    showError(`Prepare failed: ${msg}`);
    return;
  }
  if (!pairs.length) {
    resetInatUploadProgressUi();
    showError("Nothing to upload — export encoding produced no JPEGs.");
    return;
  }
  if (pairs.length !== n) {
    resetInatUploadProgressUi();
    showError(
      "Cannot upload: some photos failed export preparation. Fix or remove the failed items, then try again."
    );
    return;
  }

  prepareStepsDone = prepareStepsTotal;
  setInatUploadProgressUi(PREPARE_PORTION, "Files ready — uploading…");

  const uploadStepsTotal = nonemptyGroups.reduce((sum, g) => sum + 1 + g.indices.length, 0);
  let uploadStepsDone = 0;

  function paintUploadProgress(label) {
    const u = uploadStepsTotal ? uploadStepsDone / uploadStepsTotal : 1;
    const frac = PREPARE_PORTION + Math.min(1, u) * (1 - PREPARE_PORTION);
    setInatUploadProgressUi(Math.min(1, frac), label);
  }

  inatUploadInProgress = true;
  updateButtons();
  paintUploadProgress("Uploading to iNaturalist…");

  let ok = 0;
  try {
    for (let gi = 0; gi < nonemptyGroups.length; gi++) {
      const grp = nonemptyGroups[gi];
      if (gi > 0) await new Promise((r) => setTimeout(r, 400));
      paintUploadProgress(`Observation ${gi + 1} of ${nonemptyGroups.length}: preparing…`);
      const jpegs = [];
      const sources = [];
      for (const ix of grp.indices) {
        const p = pairs[ix];
        if (!p) {
          showError(`Missing prepared file for photo ${ix + 1}. Try preparing again.`);
          resetInatUploadProgressUi();
          break;
        }
        jpegs.push(p.jpegFile);
        sources.push(p.sourceFile);
      }
      if (jpegs.length !== grp.indices.length) {
        resetInatUploadProgressUi();
        break;
      }
      const speciesGuess = (grp.species || "").trim();
      const taxonRaw = (grp.taxonId || "").trim();
      const taxonIdNum = taxonRaw ? parseInt(taxonRaw, 10) : NaN;
      try {
        await createInatObservationForGroup(
          jpegs,
          sources,
          speciesGuess,
          Number.isFinite(taxonIdNum) && taxonIdNum > 0 ? taxonIdNum : NaN,
          (m) => {
            uploadStepsDone += 1;
            if (m.kind === "observation_created") {
              paintUploadProgress(
                `Observation ${gi + 1} of ${nonemptyGroups.length}: created — adding photos…`
              );
            } else {
              paintUploadProgress(
                `Observation ${gi + 1} of ${nonemptyGroups.length}: photo ${m.index} / ${m.total}`
              );
            }
          },
          typeof grp.manualLat === "number" && Number.isFinite(grp.manualLat) ? grp.manualLat : undefined,
          typeof grp.manualLon === "number" && Number.isFinite(grp.manualLon) ? grp.manualLon : undefined
        );
        ok++;
      } catch (e) {
        const msg = e && typeof e === "object" && "message" in e ? String(e.message) : String(e);
        showError(`Observation ${gi + 1}: ${msg}`);
        resetInatUploadProgressUi();
        break;
      }
    }
    if (ok > 0) {
      const doneMsg =
        ok === nonemptyGroups.length
          ? `Done. ${ok} observation(s) created.`
          : `Stopped after ${ok} of ${nonemptyGroups.length}. See error above.`;
      const uDone = uploadStepsTotal ? uploadStepsDone / uploadStepsTotal : 1;
      const frac = PREPARE_PORTION + Math.min(1, uDone) * (1 - PREPARE_PORTION);
      setInatUploadProgressUi(Math.min(1, frac), doneMsg);
    }
  } catch (e) {
    console.error(e);
    const msg = e && typeof e === "object" && "message" in e ? String(e.message) : String(e);
    showError(`Upload failed: ${msg}`);
    resetInatUploadProgressUi();
  } finally {
    inatUploadInProgress = false;
    updateButtons();
  }
}

/** After removing `workItems[removedIdx]`, fix observation group indices (call before `workItems.splice`). */
function adjustInatUploadGroupsAfterRemoveAtIndex(removedIdx) {
  if (!inatUploadGroups.length) return;
  for (const g of inatUploadGroups) {
    if (!g || !Array.isArray(g.indices)) continue;
    g.indices = g.indices
      .filter((ix) => ix !== removedIdx)
      .map((ix) => (ix > removedIdx ? ix - 1 : ix));
  }
  inatUploadGroups = inatUploadGroups.filter((g) => g && g.indices && g.indices.length > 0);
}

function fixInatGroupEditIndexAfterRemove(removedIdx) {
  if (inatGroupEditForwardIndex < 0) return;
  if (inatGroupEditForwardIndex === removedIdx) inatGroupEditForwardIndex = -1;
  else if (inatGroupEditForwardIndex > removedIdx) inatGroupEditForwardIndex -= 1;
}

/** Drop cached iNat grouping JPEG so the strip can rebuild after crop edits (cache key is file-only). */
function revokeInatGroupingThumbUrlForKey(key) {
  const inatThumb = inatGroupingThumbUrlByKey.get(key);
  if (!inatThumb) return;
  try {
    URL.revokeObjectURL(inatThumb);
  } catch {
    /* ignore */
  }
  inatGroupingThumbUrlByKey.delete(key);
  const pi0 = previewObjectUrls.indexOf(inatThumb);
  if (pi0 >= 0) previewObjectUrls.splice(pi0, 1);
}

/**
 * Remove a photo from the batch and revoke its preview blob URL.
 */
function removeWorkItemAndRow(file, row) {
  /** Invalidate idle/rAF prefetch — without this, `createImageBitmap` completions can run after splice/teardown and crash WebKit (esp. last-item delete). */
  bumpPrefetchToken();
  /**
   * Abort Share prep immediately — `releaseBatchResources()` (deferred on empty batch) also invalidates,
   * but async `prepareShareSheetFilesForShare` / ZIP export can still run until that turn; touching
   * removed `File`s then crashes the tab (esp. last photo in the set).
   */
  invalidateShareSheetPrep();
  markMappingDeletedByFile(file);
  const key = fileCacheKey(file);
  cropState.delete(key);
  previewSlotErrors.delete(key);
  cropReviewDoneKeys.delete(key);
  analysisPendingKeys.delete(key);
  exportPrepCache.delete(key);
  exportPrepInflight.delete(key);
  const preBm = cropPreviewBitmapByKey.get(key);
  if (preBm) {
    try {
      preBm.close();
    } catch { /* ignore */ }
    cropPreviewBitmapByKey.delete(key);
  }
  revokeInatGroupingThumbUrlForKey(key);
  /** Stop pan/zoom/rAF before mutating batch — avoids touching detached DOM after splice. */
  if (row && typeof row._abortCropEditorUi === "function") {
    try {
      row._abortCropEditorUi();
    } catch {
      /* ignore */
    }
  }
  /** Revoke blob preview URLs from the row preview, or the cached file URL when `row` is absent (e.g. iNat strip). */
  if (row) {
    for (const imgEl of row.querySelectorAll('img[src^="blob:"]')) {
      const u = imgEl.src;
      if (filePreviewUrlByKey.get(key) === u) filePreviewUrlByKey.delete(key);
      try {
        URL.revokeObjectURL(u);
      } catch {
        /* ignore */
      }
      const pi = previewObjectUrls.indexOf(u);
      if (pi >= 0) previewObjectUrls.splice(pi, 1);
    }
  } else {
    const url = filePreviewUrlByKey.get(key);
    if (url) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        /* ignore */
      }
      filePreviewUrlByKey.delete(key);
      const pi = previewObjectUrls.indexOf(url);
      if (pi >= 0) previewObjectUrls.splice(pi, 1);
    }
  }
  const idx = workItems.findIndex((f) => fileCacheKey(f) === key);
  if (idx >= 0) {
    adjustInatUploadGroupsAfterRemoveAtIndex(idx);
    if (workItemCaptureTimesMs && workItemCaptureTimesMs.length > idx) {
      workItemCaptureTimesMs.splice(idx, 1);
    }
    fixInatGroupEditIndexAfterRemove(idx);
    const n = workItems.length;
    const fi = n - 1 - cropReviewIndex;
    workItems.splice(idx, 1);
    const m = workItems.length;
    if (m) {
      if (idx === fi) syncCropReviewIndex();
      else if (idx > fi) cropReviewIndex = Math.max(0, cropReviewIndex - 1);
      cropReviewIndex = Math.max(0, Math.min(cropReviewIndex, m - 1));
      if (inatUploadGroups.length === 0) initInatUploadGroupsTimeClusteredFromCache();
      else inatUploadGroupsInitializedForN = m;
    }
  }
  pruneAnalysisPendingKeysToWorkItems();
  if (row) row.remove();
  if (workItems.length === 0) {
    cropToolbarProgressEl = null;
    lastShareInatFiles = [];
    lastShareInatSourceFiles = [];
    /** Invalidate runAutoCrop / background analysis — deleting last file did not bump this before. */
    previewGeneration++;
    if (sessionPersistTimer != null) {
      clearTimeout(sessionPersistTimer);
      sessionPersistTimer = null;
    }
    cropState.clear();
    cropReviewDoneKeys.clear();
    previewSlotErrors.clear();
    analysisPendingKeys.clear();
    cropReviewIndex = 0;
    setProgress(false, 0, "");
    if (fileSummary) fileSummary.textContent = "";
    if (exportFooterBar) exportFooterBar.hidden = true;
    setCurrentPage("setup");
    /**
     * Defer heavy teardown (URL revoke, TF canvas, IndexedDB) — synchronous `releaseBatchResources` here
     * has crashed WebKit when removing the last row while pointer/layout work is still unwinding.
     */
    const emptyGen = previewGeneration;
    window.requestAnimationFrame(() => {
      window.setTimeout(() => {
        if (emptyGen !== previewGeneration || workItems.length > 0) return;
        try {
          releaseBatchResources();
        } catch (e) {
          console.warn("releaseBatchResources (deferred empty batch)", e);
        }
      }, 0);
    });
  } else {
    renderCropEditorSlot();
    updateCropReviewChrome();
    /**
     * User may confirm the newest photo(s) first, then delete an older one — the rest can already be
     * reviewed. `renderCropEditorSlot` clears the grid when finished but does not switch pages; mirror
     * `advanceCropReview` so ZIP / Share stay reachable.
     */
    if (workItems.length > 0 && isCropReviewFinished()) {
      setCurrentPage("export");
    }
  }
  updateButtons();
}

/** Chevron — previous photo in review (toward newer). */
const CROP_NAV_BACK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>';

/** Chevron — next photo in review (toward older). */
const CROP_NAV_FORWARD_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';

/** Accept current crop and advance (last photo finishes review and opens export). */
const CROP_CONTINUE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

/** Undo arrow — “reset crop to suggested” */
const RESET_CROP_UNDO_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a4.5 4.5 0 0 1 4.5 4.5v0a4.5 4.5 0 0 1-4.5 4.5H11"/></svg>';

/** Classic crop corners + diagonal slash when “full image” mode is on */
const CROP_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3H3v3"/><path d="M18 3h3v3"/><path d="M6 21H3v-3"/><path d="M18 21h3v-3"/></svg>';
const CROP_DISABLED_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3H3v3"/><path d="M18 3h3v3"/><path d="M6 21H3v-3"/><path d="M18 21h3v-3"/><path d="M4 20 20 4"/></svg>';

function snapshotSquareCropFromState(st) {
  if (!st || !st.hasCrop) return null;
  return { left: st.left, top: st.top, side: st.side };
}

/** Placeholder while analysis has not produced crop state for this photo yet (spinner where the image will appear). */
function buildAnalyzingPendingRow(file) {
  const key = fileCacheKey(file);
  const row = document.createElement("article");
  row.className = "preview-row preview-row--pending preview-row--loading";
  row.dataset.fileKey = key;
  row.setAttribute("aria-busy", "true");
  const wrap = document.createElement("div");
  wrap.className = "crop-loading-slot";
  const sp = document.createElement("div");
  sp.className = "crop-pending-spinner";
  sp.setAttribute("role", "status");
  sp.setAttribute("aria-label", "Loading image");
  wrap.appendChild(sp);
  row.appendChild(wrap);
  attachBatchRowActions(row, file, { variant: "pending", showNextCheck: true });
  return row;
}

/**
 * Toolbar: progress; row with photo back/forward, full-image, delete, optional reset, continue (✓).
 */
function attachBatchRowActions(row, file, options) {
  const { variant, showNextCheck, onResetSuggested, inatGroupingSingleEdit } = options || {};
  cropToolbarProgressEl = null;
  const tb = document.createElement("div");
  tb.className = "crop-toolbar";
  tb.setAttribute("role", "toolbar");
  tb.setAttribute("aria-label", "Actions");

  const btnDel = document.createElement("button");
  btnDel.type = "button";
  btnDel.className = "btn-icon btn-icon--danger";
  btnDel.title = "Remove";
  btnDel.setAttribute("aria-label", "Remove photo");
  btnDel.innerHTML =
    '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>';

  const btnFullImage = document.createElement("button");
  btnFullImage.type = "button";
  btnFullImage.className = "btn-icon btn-icon--toggle";

  function syncFullImageToggleUi() {
    const key = fileCacheKey(file);
    const st = cropState.get(key);
    const fullOn = st && st.hasCrop === false;
    btnFullImage.setAttribute("aria-pressed", fullOn ? "true" : "false");
    btnFullImage.title = fullOn ? "Full image on — tap for square crop" : "Full image off — tap for whole file";
    btnFullImage.setAttribute("aria-label", fullOn ? "Full image: on. Activate for square crop." : "Full image: off. Activate for whole image.");
    btnFullImage.innerHTML = fullOn ? CROP_DISABLED_ICON_SVG : CROP_ICON_SVG;
    btnFullImage.classList.toggle("btn-icon--toggle-on", fullOn);
  }

  if (variant === "error") {
    btnFullImage.disabled = true;
    btnFullImage.title = "N/A";
    btnFullImage.setAttribute("aria-label", "Full image toggle unavailable");
    btnFullImage.innerHTML = CROP_ICON_SVG;
  } else if (variant === "pending") {
    btnFullImage.disabled = true;
    btnFullImage.title = "Wait for analysis";
    btnFullImage.setAttribute("aria-label", "Analysis in progress");
    btnFullImage.innerHTML = CROP_ICON_SVG;
  } else if (variant === "nocrop") {
    btnFullImage.addEventListener("click", () => {
      const key = fileCacheKey(file);
      const prev = cropState.get(key);
      const w = prev && prev.w ? prev.w : 0;
      const h = prev && prev.h ? prev.h : 0;
      let sq = prev && prev.savedSquareCrop;
      if (!sq && w > 0 && h > 0) {
        const side = Math.min(w, h);
        sq = { left: Math.round((w - side) / 2), top: Math.round((h - side) / 2), side };
      }
      if (!sq) return;
      const nextState = {
        left: sq.left,
        top: sq.top,
        side: sq.side,
        w,
        h,
        hasCrop: true,
        det: prev && prev.det ? prev.det : null,
      };
      if (prev && prev.noDetectionCrop) nextState.noDetectionCrop = true;
      setCropStateForFileAndPersist(file, nextState, { accepted: false });
      const newRow = buildCropEditor(file, nextState, null, { showNextCheck, minimalChrome: true });
      row.replaceWith(newRow);
      updateButtons();
    });
    syncFullImageToggleUi();
  } else {
    btnFullImage.addEventListener("click", () => {
      const key = fileCacheKey(file);
      const prev = cropState.get(key);
      const w = prev && prev.w ? prev.w : 0;
      const h = prev && prev.h ? prev.h : 0;
      const saved = snapshotSquareCropFromState(prev);
      setCropStateForFileAndPersist(file, {
        w,
        h,
        hasCrop: false,
        det: prev && prev.det ? prev.det : null,
        savedSquareCrop: saved || undefined,
      }, { accepted: false });
      const newRow = buildOriginalOnlyRow(file, { showNextCheck, minimalChrome: true });
      row.replaceWith(newRow);
      updateButtons();
    });
    syncFullImageToggleUi();
  }

  btnDel.addEventListener("click", () => removeWorkItemAndRow(file, row));

  const actionsWrap = document.createElement("div");
  actionsWrap.className = "crop-toolbar__actions";

  if (showNextCheck) {
    const nav = document.createElement("div");
    nav.className = "crop-toolbar__nav crop-toolbar__nav--six";
    const nBatch = workItems.length;

    const btnNavBack = document.createElement("button");
    btnNavBack.type = "button";
    btnNavBack.className = "btn-icon btn-icon--nav-back";
    btnNavBack.innerHTML = CROP_NAV_BACK_SVG;

    const btnNavForward = document.createElement("button");
    btnNavForward.type = "button";
    btnNavForward.className = "btn-icon btn-icon--nav-forward";
    btnNavForward.innerHTML = CROP_NAV_FORWARD_SVG;

    function syncPhotoNavButtons() {
      const n = workItems.length;
      const atNewest = cropReviewIndex <= 0;
      const atOldest = n <= 0 || cropReviewIndex >= n - 1;
      const navDisabled = variant === "pending" || inatGroupingSingleEdit || n <= 1;
      btnNavBack.disabled = navDisabled || atNewest;
      btnNavForward.disabled = navDisabled || atOldest;
      if (navDisabled) {
        btnNavBack.title = variant === "pending" ? "Wait for analysis" : n <= 1 ? "" : "Photo navigation";
        btnNavForward.title = btnNavBack.title;
        btnNavBack.setAttribute(
          "aria-label",
          variant === "pending" ? "Wait for analysis" : n <= 1 ? "Only one photo in batch" : "Photo navigation unavailable"
        );
        btnNavForward.setAttribute("aria-label", btnNavBack.getAttribute("aria-label") || "");
      } else {
        btnNavBack.title = atNewest ? "Newest photo" : "Previous photo (newer)";
        btnNavBack.setAttribute("aria-label", atNewest ? "Already on newest photo" : "Go to newer photo");
        btnNavForward.title = atOldest ? "Oldest photo" : "Next photo (older)";
        btnNavForward.setAttribute("aria-label", atOldest ? "Already on oldest photo" : "Go to older photo");
      }
    }
    syncPhotoNavButtons();
    btnNavBack.addEventListener("click", () => navigateCropReview(-1));
    btnNavForward.addEventListener("click", () => navigateCropReview(1));

    /** @type {HTMLButtonElement | null} */
    let btnResetCrop = null;
    if (typeof onResetSuggested === "function") {
      btnResetCrop = document.createElement("button");
      btnResetCrop.type = "button";
      btnResetCrop.className = "btn-icon btn-icon--reset-crop";
      btnResetCrop.title = "Reset crop to suggested framing";
      btnResetCrop.setAttribute("aria-label", "Reset crop to suggested framing");
      btnResetCrop.innerHTML = RESET_CROP_UNDO_SVG;
      btnResetCrop.addEventListener("click", () => {
        onResetSuggested();
      });
    }

    const btnContinue = document.createElement("button");
    btnContinue.type = "button";
    btnContinue.className = "btn-icon btn-icon--continue";
    btnContinue.innerHTML = CROP_CONTINUE_SVG;
    /** Oldest remaining slot in batch — accepting it finishes review (newest-first walk). */
    const atLast = nBatch > 0 && cropReviewIndex >= nBatch - 1;
    if (variant === "pending") {
      btnContinue.disabled = true;
      btnContinue.title = "Wait for analysis";
      btnContinue.setAttribute("aria-label", "Wait for analysis");
    } else if (inatGroupingSingleEdit) {
      btnContinue.title = "Done — return to observations";
      btnContinue.setAttribute("aria-label", "Done editing this photo");
      btnContinue.addEventListener("click", () => {
        void confirmInatGroupingSingleEditAndReturn();
      });
    } else {
      btnContinue.title = atLast ? "Finish" : "Accept and next";
      btnContinue.setAttribute("aria-label", atLast ? "Finish review and go to export" : "Accept crop and go to next photo");
      btnContinue.addEventListener("click", () => advanceCropReview());
    }

    function makeSlot(child) {
      const slot = document.createElement("div");
      slot.className = "crop-toolbar__nav-slot";
      slot.appendChild(child);
      return slot;
    }

    nav.append(
      makeSlot(btnNavBack),
      makeSlot(btnFullImage),
      makeSlot(btnDel),
      btnResetCrop
        ? makeSlot(btnResetCrop)
        : (() => {
            const slot = document.createElement("div");
            slot.className = "crop-toolbar__nav-slot crop-toolbar__nav-slot--spacer";
            const ph = document.createElement("div");
            ph.className = "crop-toolbar__nav-spacer";
            ph.setAttribute("aria-hidden", "true");
            slot.appendChild(ph);
            return slot;
          })(),
      makeSlot(btnNavForward),
      makeSlot(btnContinue)
    );

    actionsWrap.appendChild(nav);

    const prog = document.createElement("span");
    prog.className = "crop-toolbar__progress";
    prog.setAttribute("aria-live", "polite");
    cropToolbarProgressEl = prog;
    tb.appendChild(prog);
  } else {
    actionsWrap.append(btnFullImage, btnDel);
  }

  tb.appendChild(actionsWrap);
  row.appendChild(tb);
}

/** Read-only preview when user chose full original (no square crop in export). */
function buildOriginalOnlyRow(file, options) {
  const { showNextCheck, minimalChrome } = options || {};
  const key = fileCacheKey(file);
  const row = document.createElement("article");
  row.className = "preview-row preview-row--original";
  row.dataset.fileKey = key;

  const editorWrap = document.createElement("div");
  editorWrap.className = "crop-editor crop-editor--readonly";

  const img = document.createElement("img");
  const objectUrl = getOrCreateFilePreviewUrl(file);
  img.src = objectUrl;
  img.alt = "";
  img.draggable = false;
  img.decoding = "async";
  img.loading = "eager";
  try {
    if ("fetchPriority" in img) img.fetchPriority = "high";
  } catch { /* ignore */ }
  editorWrap.appendChild(img);
  attachCropInteractionGuards(editorWrap);

  row.appendChild(editorWrap);
  if (!minimalChrome) {
    const meta = document.createElement("div");
    meta.className = "crop-meta";
    const label = document.createElement("span");
    label.className = "no-crop-label";
    label.textContent = "Original file — no square crop in ZIP";
    meta.appendChild(label);
    row.appendChild(meta);
  }
  attachBatchRowActions(row, file, { variant: "nocrop", showNextCheck });
  return row;
}

/* ── Model caching via Cache API (skipped on iOS Safari: Cache API can hang or reject in private mode) ── */

function isCocoModelAssetUrl(url) {
  return url.includes("tfhub.dev") || url.includes("storage.googleapis.com/tfjs-models") || url.includes("kaggle.com");
}

function resetModelWeightProgress() {
  modelWeightShardTotal = 0;
  modelWeightShardsDone = 0;
}

/**
 * After model.json is fetched, count weight shards so we can show real download progress (not just a spinner).
 */
async function applyModelJsonProgressHint(url, response) {
  if (!response.ok || !url.includes("storage.googleapis.com") || !url.endsWith("model.json")) return response;
  try {
    const j = await response.clone().json();
    let n = 0;
    for (const w of j.weightsManifest || []) n += (w.paths || []).length;
    if (n > 0) {
      modelWeightShardTotal = n;
      modelWeightShardsDone = 0;
      setModelLoadStage("Loading…");
      setProgress(true, 0, "Loading…", { indeterminate: false, skipTextLine: modelLoadElapsedTimer != null });
    }
  } catch { /* ignore */ }
  return response;
}

function noteWeightShardResponse(url, response) {
  if (!response.ok || !url.includes("storage.googleapis.com") || url.endsWith("model.json")) return;
  if (modelWeightShardTotal <= 0) return;
  modelWeightShardsDone = Math.min(modelWeightShardTotal, modelWeightShardsDone + 1);
  const pct = Math.min(99, (modelWeightShardsDone / modelWeightShardTotal) * 100);
  setProgress(true, pct, "Loading…", { indeterminate: false, skipTextLine: modelLoadElapsedTimer != null });
}

async function cachedFetch(request) {
  const url = typeof request === "string" ? request : request.url;
  if (!isCocoModelAssetUrl(url)) {
    return nativeFetch(request);
  }
  const useDiskCache = !isIOSOrIPadOS();
  let response;
  if (useDiskCache) {
    try {
      const cache = await caches.open(MODEL_CACHE_NAME);
      const cached = await cache.match(url);
      if (cached) return cached;
      response = await nativeFetch(request);
      if (response.ok) {
        try {
          await cache.put(url, response.clone());
        } catch {
          /* quota / private browsing */
        }
      }
    } catch {
      response = await nativeFetch(request);
    }
  } else {
    response = await nativeFetch(request);
  }
  response = await applyModelJsonProgressHint(url, response);
  noteWeightShardResponse(url, response);
  return response;
}

function formatAnalysisLoadError(e) {
  const msg = e && typeof e === "object" && "message" in e ? String(e.message) : String(e);
  const net = /failed to fetch|network|load failed|Load failed|aborted|timeout/i.test(msg);
  if (net) return `${msg} Check connection; retry later.`;
  return msg;
}

/** Free COCO-SSD + TF weight tensors when leaving the crop flow (large batches / last delete). */
async function disposeLoadedModel() {
  const m = model;
  model = null;
  modelPromise = null;
  if (m && typeof m.dispose === "function") {
    try {
      m.dispose();
    } catch (e) {
      console.warn("disposeLoadedModel", e);
    }
  }
  try {
    const eng = tf.engine();
    if (eng && typeof eng.disposeVariables === "function") await eng.disposeVariables();
  } catch { /* ignore */ }
}

/**
 * Drop decoded previews, blob URLs, and export prep without clearing crop review state (caller handles that).
 * Does **not** dispose the TF model synchronously — that can race `detModel.detect()` and crash WebKit.
 * Model is released on real page unload (`pagehide` when not entering bfcache), not on tab visibility alone —
 * hiding the tab while analysis runs used to dispose mid-`detect()` and throw (e.g. `s.backend`).
 */
function releaseBatchResources() {
  bumpPrefetchToken();
  previewGrid.replaceChildren();
  for (const u of previewObjectUrls) {
    try {
      URL.revokeObjectURL(u);
    } catch { /* ignore */ }
  }
  previewObjectUrls = [];
  filePreviewUrlByKey.clear();
  for (const bm of cropPreviewBitmapByKey.values()) {
    try {
      bm.close();
    } catch { /* ignore */ }
  }
  cropPreviewBitmapByKey.clear();
  exportPrepCache.clear();
  exportPrepInflight.clear();
  exportPrepBackgroundChain = Promise.resolve();
  invalidateShareSheetPrep();
}

async function ensureModel() {
  if (model) return model;
  if (!modelPromise) {
    resetModelWeightProgress();
    setModelLoadStage("Preparing…");
    startModelLoadElapsedUi();
    const originalFetch = window.fetch;
    window.fetch = cachedFetch;
    modelPromise = (async () => {
      try {
        try {
          if (!isIOSOrIPadOS()) tf.env().set("WEBGL_PACK", true);
        } catch { /* ignore */ }
        try {
          if (isIOSOrIPadOS()) await tf.setBackend("cpu");
          else await tf.setBackend("webgl");
          await tf.ready();
        } catch {
          await tf.setBackend("cpu");
          await tf.ready();
        }
        setModelLoadStage("Loading…");
        await new Promise((r) => requestAnimationFrame(() => r()));
        const m = await cocoSsd.load({ base: COCO_SSD_BASE });
        model = m;
        setProgress(true, 100, "Starting…", { indeterminate: true });
        setModelLoadStage("Starting…");
        stopModelLoadElapsedUi();
        modelLoadStageText = "";
        updateButtons();
        return m;
      } finally {
        window.fetch = originalFetch;
      }
    })().catch((e) => {
      modelPromise = null;
      resetModelWeightProgress();
      stopModelLoadElapsedUi();
      modelLoadStageText = "";
      throw e;
    });
  }
  return modelPromise;
}

/* ── Crop editor UI ── */

/**
 * @param {string | null} [manualNote] — shown when crop is user-adjusted fallback (model/detector failure).
 * @param {{ showNextCheck?: boolean }} [options]
 */
function buildCropEditor(file, state, manualNote, options) {
  const showNextCheck = Boolean(options && options.showNextCheck);
  const minimalChrome = Boolean(options && options.minimalChrome);
  const key = fileCacheKey(file);
  const row = document.createElement("article");
  row.className = "preview-row";
  row.dataset.fileKey = key;

  const editorWrap = document.createElement("div");
  editorWrap.className = "crop-editor";

  /** @type {HTMLImageElement | HTMLCanvasElement} */
  let img;
  /** Capped prefetch bitmaps are for queue snappiness only — the editor always uses the full file preview for accurate crop. */
  const preBm = cropPreviewBitmapByKey.get(key);
  if (preBm) {
    cropPreviewBitmapByKey.delete(key);
    try {
      preBm.close();
    } catch {
      /* ignore */
    }
  }
  const im = document.createElement("img");
  im.src = getOrCreateFilePreviewUrl(file);
  im.alt = "";
  im.draggable = false;
  /** Async decode keeps main thread responsive while the crop UI paints. */
  im.decoding = "async";
  im.loading = "eager";
  try {
    if ("fetchPriority" in im) im.fetchPriority = "high";
  } catch {
    /* ignore */
  }
  im.setAttribute("draggable", "false");
  img = im;

  const meta = document.createElement("div");
  meta.className = "crop-meta";

  if (!state.hasCrop) {
    if (!minimalChrome) {
      const label = document.createElement("span");
      label.className = "no-crop-label";
      label.textContent = "No crop — original kept";
      meta.appendChild(label);
    }
    editorWrap.appendChild(img);
    attachCropInteractionGuards(editorWrap);
    row.appendChild(editorWrap);
    if (!minimalChrome) row.appendChild(meta);
    attachBatchRowActions(row, file, { variant: "nocrop", showNextCheck });
    return row;
  }

  editorWrap.classList.add("crop-editor--fixed-viewport");

  /** Tear down pan/zoom listeners when the row is removed — avoids leaked `document` listeners crashing after last-item delete. */
  const cropEditorUiAbort = new AbortController();
  const cropUiSignal = cropEditorUiAbort.signal;
  row._abortCropEditorUi = () => {
    try {
      cropEditorUiAbort.abort();
    } catch {
      /* ignore */
    }
  };

  const viewportHost = document.createElement("div");
  viewportHost.className = "crop-viewport-host";

  const viewport = document.createElement("div");
  viewport.className = "crop-viewport";
  viewport.setAttribute("role", "application");
  viewport.setAttribute("aria-label", "Pan image");

  const imageLayer = document.createElement("div");
  imageLayer.className = "crop-image-layer";

  const imageScaler = document.createElement("div");
  imageScaler.className = "crop-image-layer__scaler";

  const frameEl = document.createElement("div");
  frameEl.className = "crop-viewport__frame";
  frameEl.setAttribute("aria-hidden", "true");

  imageScaler.appendChild(img);
  imageLayer.appendChild(imageScaler);
  viewport.appendChild(imageLayer);
  viewport.appendChild(frameEl);
  viewportHost.appendChild(viewport);
  editorWrap.appendChild(viewportHost);

  const zoomRow = document.createElement("div");
  zoomRow.className = "crop-zoom-row";
  const zoomSliderId = `crop-zoom-${++cropZoomSliderIdSeq}`;
  const zoomLabel = document.createElement("label");
  zoomLabel.className = minimalChrome ? "crop-zoom-label crop-zoom-label--sr" : "crop-zoom-label";
  zoomLabel.setAttribute("for", zoomSliderId);
  zoomLabel.textContent = "Zoom";
  const zoomInput = document.createElement("input");
  zoomInput.type = "range";
  zoomInput.className = "crop-zoom-slider";
  zoomInput.id = zoomSliderId;
  /** 0–1000 steps: finer than 0–100 so the thumb tracks smoothly; crop `side` is fractional while dragging, snapped on release. */
  const ZOOM_SLIDER_MAX = 1000;
  zoomInput.min = "0";
  zoomInput.max = String(ZOOM_SLIDER_MAX);
  zoomInput.step = "any";
  zoomInput.setAttribute("aria-valuemin", "0");
  zoomInput.setAttribute("aria-valuemax", String(ZOOM_SLIDER_MAX));
  const zoomSliderBlock = document.createElement("div");
  zoomSliderBlock.className = "crop-zoom-row__slider";
  zoomSliderBlock.append(zoomLabel, zoomInput);
  zoomRow.appendChild(zoomSliderBlock);
  editorWrap.appendChild(zoomRow);

  attachCropInteractionGuards(viewport);
  attachCropInteractionGuards(imageLayer);
  attachCropInteractionGuards(imageScaler);

  if (!minimalChrome) {
    if (state.noDetectionCrop) {
      const label = document.createElement("span");
      label.className = "no-crop-label";
      label.textContent = "No subject detected — drag the photo to center, use the zoom slider to resize the square.";
      meta.appendChild(label);
    } else if (manualNote) {
      const manual = document.createElement("span");
      manual.className = "manual-crop-label";
      manual.textContent = manualNote;
      meta.appendChild(manual);
    }
  }

  row.appendChild(editorWrap);
  if (meta.childNodes.length) row.appendChild(meta);

  function minCropSide() {
    return minSquareCropSideForDims(state.w, state.h);
  }

  function zoomLogBounds() {
    const lo = minCropSide();
    const hi = Math.min(state.w, state.h);
    return { lo, hi, logLo: Math.log(lo), logHi: Math.log(hi) };
  }

  function sideToSliderValue(side) {
    const { lo, hi, logLo, logHi } = zoomLogBounds();
    if (hi <= lo) return ZOOM_SLIDER_MAX / 2;
    const s = Math.max(lo, Math.min(hi, side));
    const tZoom = (Math.log(s) - logLo) / (logHi - logLo);
    /** Slider right = zoom in (smaller crop square); left = zoom out — invert log mapping. */
    return Math.round(Math.max(0, Math.min(ZOOM_SLIDER_MAX, (1 - tZoom) * ZOOM_SLIDER_MAX)));
  }

  function sliderValueToSide(raw) {
    const { lo, hi, logLo, logHi } = zoomLogBounds();
    if (hi <= lo) return lo;
    const tUi = Math.max(0, Math.min(1, Number(raw) / ZOOM_SLIDER_MAX));
    const tZoom = 1 - tUi;
    const s = Math.exp(logLo + tZoom * (logHi - logLo));
    /** Subpixel `side` while dragging — avoids 1px stair-stepping in the preview; commit snaps to pixels. */
    return Math.max(lo, Math.min(hi, s));
  }

  let skipZoomInputEvent = false;
  function syncZoomSliderFromState() {
    skipZoomInputEvent = true;
    zoomInput.value = String(sideToSliderValue(state.side));
    skipZoomInputEvent = false;
  }

  let zoomInputRaf = 0;
  zoomInput.addEventListener(
    "input",
    () => {
      if (skipZoomInputEvent) return;
      if (zoomInputRaf) cancelAnimationFrame(zoomInputRaf);
      zoomInputRaf = requestAnimationFrame(() => {
        zoomInputRaf = 0;
        const minSide = minCropSide();
        const newSide = sliderValueToSide(zoomInput.value);
        const prev = { left: state.left, top: state.top, side: state.side };
        const anchored = anchorCropCenterOnZoom(prev, newSide, state.w, state.h, minSide);
        state.left = anchored.left;
        state.top = anchored.top;
        state.side = anchored.side;
        panLayoutFloat = null;
        /** Skip `cropState.set` every frame — reduces Map churn + session debounce noise; commit on `change`. */
        syncFixedViewportLayout();
      });
    },
    { signal: cropUiSignal }
  );

  zoomInput.addEventListener(
    "change",
    () => {
      if (skipZoomInputEvent) return;
      const minSide = minCropSide();
      const cxView = state.left + state.side / 2;
      const cyView = state.top + state.side / 2;
      const snapped = clampSquareCropInImage(
        cxView - state.side / 2,
        cyView - state.side / 2,
        state.side,
        state.w,
        state.h,
        minSide
      );
      state.left = snapped.left;
      state.top = snapped.top;
      state.side = snapped.side;
      panLayoutFloat = null;
      setCropStateForFileAndPersist(file, state, { accepted: false });
      syncZoomSliderFromState();
      syncFixedViewportLayout();
    },
    { signal: cropUiSignal }
  );

  let layoutRaf = 0;
  /** If a layout was requested while an rAF was already queued, run again next frame (zoom + pan same tick). */
  let layoutDirty = false;
  /** While panning, use float crop origin for the transform (subpixel smoothness); committed `state` stays int until pointer-up. */
  let panLayoutFloat = null;
  /** Coalesce high-frequency `pointermove` to one clamp + DOM write per frame (reduces main-thread work). */
  let panMoveRaf = 0;
  /** @type {{ clientX: number, clientY: number } | null} */
  let pendingPanClient = null;
  /** Skip redundant style writes when transform/size unchanged (fewer style recalcs during pan/zoom). */
  let lastLayoutImgW = NaN;
  let lastLayoutImgH = NaN;
  let lastLayoutCap = NaN;
  let lastLayoutOx = NaN;
  let lastLayoutOy = NaN;
  /** Matches `setW / state.w` after layout — must drive pan/zoom math (not `vw/side`) when width is divisor-snapped. */
  let lastCssPxPerImgPx = NaN;
  /** When `clientWidth` is 0 (not laid out yet), poll a few frames so we do not leave a stale preview. */
  let layoutAwaitingVwRetries = 0;
  const LAYOUT_VW_ZERO_MAX_RETRIES = 120;

  function invalidateFixedViewportLayoutCache() {
    lastLayoutImgW = NaN;
    lastLayoutImgH = NaN;
    lastLayoutCap = NaN;
    lastLayoutOx = NaN;
    lastLayoutOy = NaN;
    lastCssPxPerImgPx = NaN;
  }

  function commitPendingPanLayout() {
    if (!panLayoutFloat) return;
    const minSide = minCropSide();
    const sq = clampSquareCropInImage(
      panLayoutFloat.left,
      panLayoutFloat.top,
      panLayoutFloat.side,
      state.w,
      state.h,
      minSide
    );
    state.left = sq.left;
    state.top = sq.top;
    state.side = sq.side;
    panLayoutFloat = null;
    setCropStateForFileAndPersist(file, state, { accepted: false });
    syncZoomSliderFromState();
    syncFixedViewportLayout();
  }

  /** Update image size/position only — do not rewrite the zoom slider (avoids fight while dragging). */
  function syncFixedViewportLayout() {
    if (cropUiSignal.aborted) return;
    if (layoutRaf) {
      layoutDirty = true;
      return;
    }
    layoutDirty = false;
    layoutRaf = requestAnimationFrame(() => {
      layoutRaf = 0;
      if (cropUiSignal.aborted) return;
      const vw = viewport.clientWidth;
      if (vw <= 0 || !state.side) {
        if (layoutDirty) {
          layoutDirty = false;
          syncFixedViewportLayout();
        } else if (layoutAwaitingVwRetries < LAYOUT_VW_ZERO_MAX_RETRIES) {
          layoutAwaitingVwRetries++;
          syncFixedViewportLayout();
        }
        return;
      }
      layoutAwaitingVwRetries = 0;
      const contentScale = vw / state.side;
      const uncW = state.w * contentScale;
      const uncH = state.h * contentScale;
      const uncMax = Math.max(uncW, uncH);
      let cap = 1;
      if (uncMax > CROP_VIEWPORT_MAX_DISPLAY_EDGE) {
        cap = CROP_VIEWPORT_MAX_DISPLAY_EDGE / uncMax;
      }
      const setWRounded = Math.round(uncW * cap);
      const setHRounded = Math.round(uncH * cap);
      /** Use rounded layout size directly — divisor-of-screen snapping used `window` width, not the crop `vw`, and could shrink `setW` far below `uncW` at low zoom (large crop), breaking zoom vs pan. */
      const setW = Math.max(1, setWRounded);
      const setH = Math.max(1, setHRounded);
      if (setW !== lastLayoutImgW || setH !== lastLayoutImgH || cap !== lastLayoutCap) {
        lastLayoutImgW = setW;
        lastLayoutImgH = setH;
        lastLayoutCap = cap;
        img.style.width = `${setW}px`;
        img.style.height = `${setH}px`;
        if (cap < 1) {
          const inv = 1 / cap;
          imageScaler.style.transform = `scale(${inv})`;
        } else {
          imageScaler.style.transform = "";
        }
      }
      /** Divisor-snapped `setW` can differ a lot from `vw/side`×w — use the real CSS px per image px so zoom does not look like pan. */
      const pxPerImg = cap < 1 - 1e-9 ? Math.max(1e-9, setW / cap / state.w) : setW / state.w;
      lastCssPxPerImgPx = pxPerImg;
      const oxSrc = panLayoutFloat ? panLayoutFloat.left : state.left;
      const oySrc = panLayoutFloat ? panLayoutFloat.top : state.top;
      const ox = -oxSrc * pxPerImg;
      const oy = -oySrc * pxPerImg;
      if (ox !== lastLayoutOx || oy !== lastLayoutOy) {
        lastLayoutOx = ox;
        lastLayoutOy = oy;
        /** translateZ(0) promotes the layer for smoother composited pans on mobile GPUs. */
        imageLayer.style.transform = `translate3d(${ox}px, ${oy}px, 0)`;
      }
      if (layoutDirty) {
        layoutDirty = false;
        syncFixedViewportLayout();
      }
    });
  }

  function blockImageChrome(ev) {
    ev.preventDefault();
  }

  if (img.tagName === "IMG") {
    img.addEventListener(
      "load",
      () => {
        syncFixedViewportLayout();
        syncZoomSliderFromState();
      },
      { signal: cropUiSignal }
    );
  }
  let resizeLayoutRaf = 0;
  const cropViewportResizeObserver = new ResizeObserver(() => {
    if (resizeLayoutRaf) return;
    resizeLayoutRaf = requestAnimationFrame(() => {
      resizeLayoutRaf = 0;
      syncFixedViewportLayout();
    });
  });
  cropViewportResizeObserver.observe(viewport);
  cropUiSignal.addEventListener("abort", () => {
    if (resizeLayoutRaf) {
      cancelAnimationFrame(resizeLayoutRaf);
      resizeLayoutRaf = 0;
    }
    try {
      cropViewportResizeObserver.disconnect();
    } catch {
      /* ignore */
    }
  });

  img.addEventListener("contextmenu", blockImageChrome, { signal: cropUiSignal });
  img.addEventListener("dragstart", blockImageChrome, { signal: cropUiSignal });
  if (img.tagName === "IMG") {
    queueMicrotask(() => {
      if (cropUiSignal.aborted) return;
      if (img.tagName === "IMG" && img.complete && img.naturalWidth > 0) {
        syncFixedViewportLayout();
        syncZoomSliderFromState();
      }
    });
  }

  /** @type {Map<number, { x: number, y: number }>} */
  const activePtrs = new Map();
  let panAnchor = null;

  function onPointerDown(e) {
    e.preventDefault();
    activePtrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (activePtrs.size > 1) {
      flushPendingPanMove();
      commitPendingPanLayout();
    }
    if (activePtrs.size === 1) {
      panAnchor = {
        x: e.clientX,
        y: e.clientY,
        left: state.left,
        top: state.top,
      };
      try {
        viewport.setPointerCapture(e.pointerId);
      } catch { /* ignore */ }
    }
  }

  function applyPan(clientX, clientY) {
    if (!panAnchor) return;
    const vw = viewport.clientWidth;
    if (vw <= 0) return;
    const scale =
      Number.isFinite(lastCssPxPerImgPx) && lastCssPxPerImgPx > 0 ? lastCssPxPerImgPx : vw / state.side;
    const dx = clientX - panAnchor.x;
    const dy = clientY - panAnchor.y;
    const minSide = minCropSide();
    const sq = clampSquareCropInImageFloat(
      panAnchor.left - dx / scale,
      panAnchor.top - dy / scale,
      state.side,
      state.w,
      state.h,
      minSide
    );
    panLayoutFloat = { left: sq.left, top: sq.top, side: sq.side };
    syncFixedViewportLayout();
  }

  function schedulePanMove(clientX, clientY) {
    pendingPanClient = { clientX, clientY };
    if (panMoveRaf) return;
    panMoveRaf = requestAnimationFrame(() => {
      panMoveRaf = 0;
      const p = pendingPanClient;
      pendingPanClient = null;
      if (!p || !panAnchor) return;
      applyPan(p.clientX, p.clientY);
    });
  }

  function flushPendingPanMove() {
    if (panMoveRaf) {
      cancelAnimationFrame(panMoveRaf);
      panMoveRaf = 0;
    }
    if (pendingPanClient && panAnchor) {
      const p = pendingPanClient;
      pendingPanClient = null;
      applyPan(p.clientX, p.clientY);
    }
  }

  function onPointerMove(e) {
    if (!activePtrs.has(e.pointerId)) return;
    activePtrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (activePtrs.size === 1 && panAnchor) {
      schedulePanMove(e.clientX, e.clientY);
    }
  }

  function onPointerUpOrCancel(e) {
    activePtrs.delete(e.pointerId);
    if (activePtrs.size === 0) {
      flushPendingPanMove();
      commitPendingPanLayout();
      panAnchor = null;
    } else if (activePtrs.size === 1) {
      flushPendingPanMove();
      commitPendingPanLayout();
      const rem = activePtrs.entries().next().value;
      if (rem) {
        const p = rem[1];
        panAnchor = { x: p.x, y: p.y, left: state.left, top: state.top };
      }
    }
  }

  viewport.addEventListener("pointerdown", onPointerDown, { signal: cropUiSignal });
  viewport.addEventListener("pointermove", onPointerMove, { signal: cropUiSignal, passive: true });
  viewport.addEventListener("pointerup", onPointerUpOrCancel, { signal: cropUiSignal });
  viewport.addEventListener("pointercancel", onPointerUpOrCancel, { signal: cropUiSignal });
  /** Passive on document — we do not cancel move; reduces scroll jank if the browser treats the chain as scrollable. */
  document.addEventListener("pointermove", onPointerMove, { signal: cropUiSignal, passive: true });
  document.addEventListener("pointerup", onPointerUpOrCancel, { signal: cropUiSignal, passive: true });
  document.addEventListener("pointercancel", onPointerUpOrCancel, { signal: cropUiSignal, passive: true });

  cropUiSignal.addEventListener("abort", () => {
    layoutDirty = false;
    layoutAwaitingVwRetries = 0;
    pendingPanClient = null;
    if (panMoveRaf) {
      cancelAnimationFrame(panMoveRaf);
      panMoveRaf = 0;
    }
    if (layoutRaf) {
      cancelAnimationFrame(layoutRaf);
      layoutRaf = 0;
    }
    if (zoomInputRaf) {
      cancelAnimationFrame(zoomInputRaf);
      zoomInputRaf = 0;
    }
  });

  syncZoomSliderFromState();
  syncFixedViewportLayout();

  function resetCropToSuggested() {
    const sug = suggestedSquareCropFromState(state);
    if (!sug) return;
    const minSide = minCropSide();
    const clamped = clampSquareCropInImage(sug.left, sug.top, sug.side, state.w, state.h, minSide);
    panLayoutFloat = null;
    state.left = clamped.left;
    state.top = clamped.top;
    state.side = clamped.side;
    setCropStateForFileAndPersist(file, state, { accepted: false });
    syncZoomSliderFromState();
    syncFixedViewportLayout();
  }

  const fiNow = cropItemForwardIndex();
  const inatGroupingSingleEdit =
    inatGroupEditForwardIndex >= 0 && fiNow === inatGroupEditForwardIndex;
  attachBatchRowActions(row, file, {
    variant: "crop",
    showNextCheck,
    onResetSuggested: resetCropToSuggested,
    inatGroupingSingleEdit,
  });
  return row;
}

function centeredSquareCropState(w, h) {
  const side = Math.min(w, h);
  return {
    left: Math.round((w - side) / 2),
    top: Math.round((h - side) / 2),
    side,
    w,
    h,
    hasCrop: true,
    det: null,
  };
}

/**
 * When auto-detect or the model fails, still store a centered square so the user can export after review.
 */
async function ensureManualCropStateAfterError(file, shortReason) {
  const decoded = await decodeForManualCrop(file);
  const { w, h, close } = decoded;
  if (typeof close === "function") close();
  const base = centeredSquareCropState(w, h);
  const key = fileCacheKey(file);
  const note = shortReason || "Manual crop";
  const state = { ...base, det: null, reviewNote: note };
  setCropStateForFileAndPersist(file, state, { accepted: false });
}

async function runManualCropOnly(gen) {
  const total = workItems.length;
  for (let idx = 0; idx < total; idx++) {
    if (gen !== previewGeneration) return;
    if (shouldYieldBetweenBatchItems() && idx > 0) await new Promise((r) => setTimeout(r, 0));
    setProgress(true, ((idx + 1) / total) * 100, `Applying centered crop · ${idx + 1} / ${total}…`);

    const file = workItems[idx];
    const key = fileCacheKey(file);
    try {
      await ensureManualCropStateAfterError(file, "No auto-detect");
      previewSlotErrors.delete(key);
    } catch (err) {
      console.error(err);
      previewSlotErrors.set(key, String(err.message || err));
    }
  }
}

function finishPreviewBatch(gen, total, manualOnly) {
  if (gen !== previewGeneration) return;
  setProgress(false, 0, "");
  fileSummary.textContent = `${total} ready — review & ✓ each`;
  syncCropReviewIndex();
  setCurrentPage("crop");
  renderCropEditorSlot();
  updateCropReviewChrome();
  updateButtons();
}

/** Open crop UI after the first photo is analyzed; optional summary until full batch is ready. */
function openCropEditorAfterFirst(gen, total, summaryText) {
  if (gen !== previewGeneration) return;
  setProgress(false, 0, "");
  fileSummary.textContent = summaryText;
  syncCropReviewIndex();
  setCurrentPage("crop");
  renderCropEditorSlot();
  updateCropReviewChrome();
  updateButtons();
}

/** Run detector on one file and write `cropState` or `previewSlotErrors`. */
async function analyzeOneImage(file, detModel, padFrac, minScore, gen) {
  if (!file) return;
  const key = fileCacheKey(file);
  if (!workItems.some((f) => fileCacheKey(f) === key)) {
    analysisPendingKeys.delete(key);
    return;
  }
  try {
    const det = await getCachedDetection(file, detModel);
    if (gen !== previewGeneration) return;
    const { preds, fullW: w, fullH: h } = det;
    const topDet = topRawDetection(preds);
    const picked = pickBestWildlifeCropFromPredictions(preds, w, h, padFrac, minScore);

    let state;
    if (picked) {
      state = {
        left: picked.crop.left,
        top: picked.crop.top,
        side: picked.crop.side,
        w,
        h,
        hasCrop: true,
        det: picked.det,
      };
    } else {
      const side = Math.min(w, h);
      state = {
        left: Math.round((w - side) / 2),
        top: Math.round((h - side) / 2),
        side,
        w,
        h,
        hasCrop: true,
        noDetectionCrop: true,
        det: slimDetectionForState(topRawDetection(preds)),
      };
    }
    setCropStateForFileAndPersist(file, state, { accepted: false });
    previewSlotErrors.delete(key);
    await new Promise((r) => requestAnimationFrame(() => r()));
  } catch (err) {
    console.error(err);
    try {
      await ensureManualCropStateAfterError(file, "Detect failed");
      previewSlotErrors.delete(key);
    } catch (e2) {
      console.error(e2);
      previewSlotErrors.set(key, String(e2.message || e2));
    }
  } finally {
    analysisPendingKeys.delete(key);
  }
}

/**
 * Analyze remaining photos without blocking the UI (first image already done).
 * Uses `analysisPendingKeys` + current `workItems` order — not a fixed index range — so deleting
 * items from the batch cannot skip analysis or leave “Analyzing…” stuck forever.
 */
function runRemainingAnalysisInBackground(gen, detModel, padFrac, minScore) {
  void (async () => {
    let pass = 0;
    while (gen === previewGeneration) {
      pruneAnalysisPendingKeysToWorkItems();
      let pendingIdx = -1;
      for (let i = workItems.length - 1; i >= 0; i--) {
        if (analysisPendingKeys.has(fileCacheKey(workItems[i]))) {
          pendingIdx = i;
          break;
        }
      }
      if (pendingIdx < 0) break;
      if (shouldYieldBetweenBatchItems() && pass > 0) await new Promise((r) => setTimeout(r, 0));
      pass++;
      const file = workItems[pendingIdx];
      await analyzeOneImage(file, detModel, padFrac, minScore, gen);
      if (gen !== previewGeneration) return;
      /** Let the main thread breathe; iOS WebGL/CPU backend + decode spikes otherwise. */
      await new Promise((r) => setTimeout(r, isIOSOrIPadOS() ? 24 : 0));
      /** User may delete the last item(s) while analysis awaits — avoid `workItems[-1]` / `fileCacheKey(undefined)`. */
      if (!workItems.length) continue;
      const cur = workItems[cropItemForwardIndex()];
      const curKey = cur ? fileCacheKey(cur) : "";
      if (file && fileCacheKey(file) === curKey) {
        renderCropEditorSlot();
        updateCropReviewChrome();
        updateButtons();
      }
      if (fileSummary && gen === previewGeneration) {
        const n = workItems.length;
        const done = workItems.filter((f) => cropState.has(fileCacheKey(f))).length;
        fileSummary.textContent =
          n > 0 ? `${done} / ${n} analyzed · review when ready` : "";
      }
    }
    if (gen === previewGeneration && fileSummary) {
      const n = workItems.length;
      fileSummary.textContent = n > 0 ? `${n} ready — review & ✓ each` : "";
    }
  })();
}

/* ── Main pipeline: auto-crop on file select ── */

async function runAutoCrop() {
  /** Must match `previewGeneration` from the file-input handler (handler increments once to invalidate prior runs). Do not `++` here or `gen` and `previewGeneration` drift and the pipeline exits immediately. */
  const gen = previewGeneration;
  revokePreviewUrls();
  clearCropState();

  if (!workItems.length) {
    fileSummary.textContent = "";
    setCurrentPage("setup");
    updateButtons();
    return;
  }

  const totalFiles = workItems.length;
  if (fileSummary) fileSummary.textContent = `Preparing · ${totalFiles} photo(s)`;
  clearError();
  /** Progress bar lives on `page-crop`; stay on setup until here and users saw only `file-summary` with no bar. */
  setCurrentPage("crop");
  setProgress(true, 0, `Preparing · ${totalFiles} photo(s)…`, { indeterminate: true });
  const reapplied = await applySavedCropMappingForCurrentBatch(totalFiles);
  const reappliedDeleted = reapplied.deleted || 0;
  if (fileSummary) {
    fileSummary.textContent = fileSummaryTextAfterReapply(
      `Preparing · ${totalFiles} photo(s)`,
      reapplied.applied,
      reapplied.accepted,
      reappliedDeleted
    );
  }
  const skipAnalysisKeys = reapplied && reapplied.reappliedKeys ? reapplied.reappliedKeys : new Set();
  for (let i = 0; i < workItems.length; i++) {
    const key = fileCacheKey(workItems[i]);
    if (!skipAnalysisKeys.has(key)) analysisPendingKeys.add(key);
  }
  if (!workItems.length) {
    setProgress(false, 0, "");
    if (fileSummary) fileSummary.textContent = "All selected photos were marked as removed in saved mappings.";
    setCurrentPage("setup");
    updateButtons();
    return;
  }
  if (analysisPendingKeys.size === 0) {
    setProgress(false, 0, "");
    if (fileSummary) {
      fileSummary.textContent = fileSummaryTextAfterReapply(
        `${workItems.length} ready — review & ✓ each`,
        reapplied.applied,
        reapplied.accepted,
        reappliedDeleted
      );
    }
    syncCropReviewIndex();
    setCurrentPage("crop");
    renderCropEditorSlot();
    updateCropReviewChrome();
    updateButtons();
    return;
  }
  const queuedForDetect = analysisPendingKeys.size;
  setProgress(
    true,
    0,
    `Loading detection model · ${queuedForDetect} photo${queuedForDetect === 1 ? "" : "s"}…`,
    { indeterminate: true }
  );
  setCurrentPage("crop");
  updateButtons();

  try { await ensureModel(); } catch (e) {
    console.error(e);
    if (gen !== previewGeneration) return;
    if (!workItems.length) {
      setProgress(false, 0, "");
      fileSummary.textContent = "";
      setCurrentPage("setup");
      updateButtons();
      return;
    }
    const detail = formatAnalysisLoadError(e);
    showError(`Couldn’t start analysis: ${detail} Centered square crops were applied — adjust below if needed.`, e);
    await runManualCropOnly(gen);
    if (gen !== previewGeneration) return;
    finishPreviewBatch(gen, workItems.length, true);
    return;
  }
  if (gen !== previewGeneration) return;

  if (!workItems.length) {
    setProgress(false, 0, "");
    fileSummary.textContent = "";
    setCurrentPage("setup");
    updateButtons();
    return;
  }

  const padFrac = PADDING_FRAC;
  const minScore = MIN_DETECTION_SCORE;
  const detModel = model;
  const total = workItems.length;
  setProgress(false, 0, "");
  if (fileSummary) {
    fileSummary.textContent =
      total > 1
        ? `${total} photos — review newest first; analysis continues in the background.`
        : `${total} ready — review & ✓ each`;
  }
  syncCropReviewIndex();
  setCurrentPage("crop");
  runRemainingAnalysisInBackground(gen, detModel, padFrac, minScore);
  renderCropEditorSlot();
  updateCropReviewChrome();
  updateButtons();
}

function startOverFromCropFlow() {
  clearError();
  clearSessionPersistNotice();
  clearCropState();
  workItems = [];
  previewGeneration++;
  releaseBatchResources();
  if (fileInput) fileInput.value = "";
  if (fileSummary) fileSummary.textContent = "";
  if (exportFooterBar) exportFooterBar.hidden = true;
  lastShareInatFiles = [];
  lastShareInatSourceFiles = [];
  setProgress(false, 0, "");
  setZipDownloadProgress(false, 0, "", {});
  setCurrentPage("setup");
  updateButtons();
}

function fileSummaryTextAfterReapply(baseText, applied, accepted, deleted) {
  if (!applied && !deleted) return baseText;
  const parts = [];
  if (applied) parts.push(`${applied} crop mapping${applied === 1 ? "" : "s"} reapplied`);
  if (accepted) parts.push(`${accepted} accepted`);
  if (deleted) parts.push(`${deleted} hidden`);
  return `${baseText} · ${parts.join(" · ")}`;
}

/* ── Event wiring ── */

fileInput.addEventListener("change", async () => {
  clearError();
  clearSessionPersistNotice();
  const raw = fileInput.files ? Array.from(fileInput.files) : [];
  const images = raw.filter((f) => isImageFile(f));

  /**
   * Some browsers fire `change` with an empty file list (cancel / same path quirks). Do not reset the
   * in-progress crop session — that was jumping users back to “Select photos” mid-review.
   */
  if (raw.length === 0) {
    return;
  }

  if (images.length === 0) {
    if (fileSummary) fileSummary.textContent = "No supported images.";
    showError("No supported images in that selection.");
    return;
  }

  await cropMappingsSessionRestorePromise;
  pendingReapplyMappingsByImageName = offerCropMappingReapply(images);

  if (images.length > MAX_BATCH_FILES) {
    const n = images.length;
    images.splice(MAX_BATCH_FILES);
    if (fileSummary) {
      fileSummary.textContent = `Using first ${MAX_BATCH_FILES} of ${n} photos (memory limit). Add more in another batch.`;
    }
    showError(
      `Large selections can crash the browser. Processing the first ${MAX_BATCH_FILES} of ${n} photos — run again for the rest.`
    );
  }

  clearCropState();
  if (exportFooterBar) exportFooterBar.hidden = true;
  if (inatUploadSection) inatUploadSection.hidden = true;
  previewGeneration++;
  releaseBatchResources();
    try {
    workItems = await sortFilesByCapture(images);
    try {
      if (isIOSOrIPadOS() || workItems.length >= memoryPressureThreshold()) {
        /** Match `sortFilesByCapture` fast path — avoid dozens of full `exifr.parse` on the main thread (hangs). */
        workItemCaptureTimesMs = workItems.map((f) => f.lastModified);
      } else {
        workItemCaptureTimesMs = await Promise.all(workItems.map((f) => getCaptureTime(f)));
      }
    } catch {
      workItemCaptureTimesMs = workItems.map((f) => f.lastModified);
    }
  } catch (e) {
    console.error(e);
    fileSummary.textContent = "";
    showError(`Date read failed: ${String(e && e.message ? e.message : e)} · fewer files?`, e);
    setCurrentPage("setup");
    updateButtons();
    return;
  }
  if (!workItems.length) {
    fileSummary.textContent = "No supported images.";
    setCurrentPage("setup");
    updateButtons();
    return;
  }
  await yieldToMainForUi();
  runAutoCrop().catch((e) => {
    console.error(e);
    showError("Processing failed. Retry.", e);
    setCurrentPage("setup");
  }).finally(() => {
    pendingReapplyMappingsByImageName = new Map();
    clearLegacySessionIfNeeded();
    markSessionPersistDirty();
  });
});

if (btnStartOver) {
  btnStartOver.addEventListener("click", () => startOverFromCropFlow());
}

/**
 * Dispose TF weights when the page is actually going away — not when the tab is merely hidden.
 * `visibilitychange` + dispose raced background `detModel.detect()` and crashed TF.js (`s.backend`).
 */
if (typeof window !== "undefined") {
  window.addEventListener(
    "pagehide",
    (ev) => {
      flushPendingSessionPersist();
      if (ev && ev.persisted) return;
      void disposeLoadedModel();
    },
    { capture: true }
  );
}

/**
 * Build export files for ZIP (cropped JPEGs or originals when no crop).
 * @param {(info: { phase: string, index: number, total: number, label?: string }) => void} [onProgress]
 */
async function buildExportFilesListForZip(onProgress, labelPrefix) {
  await refreshWorkItemsCaptureOrder();
  const out = [];
  /** Same length as `out`: batch `File` used to build each export (for JPEG re-encode when sharing to iNaturalist). */
  const sourceFiles = [];
  let failures = 0;
  const total = workItems.length;
  const indexWidth = Math.max(3, String(total).length);
  const evictAfterUse = heavyBatchMode();
  const prefix = labelPrefix != null && labelPrefix !== "" ? `${labelPrefix} ` : "";

  for (let i = 0; i < total; i++) {
    if (shouldYieldBetweenBatchItems() && i > 0) await new Promise((r) => setTimeout(r, 0));
    if (onProgress) onProgress({ phase: "export", index: i + 1, total, label: `${prefix}Image ${i + 1} / ${total}` });

    const file = workItems[i];
    const key = fileCacheKey(file);
    const indexPrefix = String(i + 1).padStart(indexWidth, "0");

    try {
      const prep = await ensureExportPrepReady(key);
      if (!prep || prep.kind === "fail") {
        failures++;
        continue;
      }

      if (prep.kind === "original") {
        const name = `${indexPrefix}_${exportFilenameWithJpgExt(file.name)}`;
        const src = prep.sourceFile;
        out.push(
          new File([src], name, {
            type: prep.mime,
            lastModified: prep.meta.lastModified,
          })
        );
        sourceFiles.push(src);
        if (evictAfterUse) exportPrepCache.delete(key);
        continue;
      }

      const base = file.name.replace(/\.[^.]+$/i, "");
      const name = `${indexPrefix}_${base}_square.${CROP_EXPORT_FORMAT.ext}`;
      out.push(
        new File([prep.blob], name, {
          type: CROP_EXPORT_FORMAT.mime,
          lastModified: prep.meta.lastModified,
        })
      );
      sourceFiles.push(prep.sourceFile);
      if (evictAfterUse) exportPrepCache.delete(key);
    } catch (err) {
      console.error(err);
      failures++;
    }
  }
  return { files: out, failures, sourceFiles };
}

/**
 * Build JPEGs for the system share sheet when the user taps Share.
 * Must be awaited from the Share click handler so the async chain starts in a user gesture.
 * @returns {Promise<File[]>}
 */
async function prepareShareSheetFilesForShare() {
  if (!workItems.length || !isCropReviewFinished()) {
    shareSheetReadyFiles = null;
    sharePrepStatusText = "";
    shareSheetBuildIndex = 0;
    shareSheetBuildTotal = 0;
    return [];
  }
  const gen = ++shareSheetPrepareGen;
  shareSheetReadyFiles = null;
  sharePrepStatusText = "";
  const n = workItems.length;
  shareSheetBuildIndex = 0;
  shareSheetBuildTotal = n;
  shareSheetPrepRunning = true;
  updateSharePrepUiDisplay();
  updateButtons();
  try {
    const built = await buildExportFilesListForZip(
      (info) => {
        if (gen !== shareSheetPrepareGen) return;
        shareSheetBuildIndex = info.index;
        shareSheetBuildTotal = info.total;
        sharePrepStatusText = "";
        updateSharePrepUiDisplay();
      },
      "Share"
    );
    if (gen !== shareSheetPrepareGen) return [];
    const normTotal = built.files.length;
    shareSheetBuildTotal = normTotal;
    shareSheetBuildIndex = 0;
    sharePrepStatusText = "";
    updateSharePrepUiDisplay();
    let files = await normalizeExportFilesForShare(built.files, built.sourceFiles, (info) => {
      if (gen !== shareSheetPrepareGen) return;
      shareSheetBuildIndex = info.index;
      shareSheetBuildTotal = info.total;
      updateSharePrepUiDisplay();
    });
    if (gen !== shareSheetPrepareGen) return [];
    sharePrepStatusText = "";
    files = pickShareableImageFiles(files);
    shareSheetReadyFiles = files;
    shareSheetBuildIndex = shareSheetBuildTotal;
    return files;
  } catch (e) {
    console.error(e);
    if (gen === shareSheetPrepareGen) {
      shareSheetReadyFiles = [];
      sharePrepStatusText = "";
    }
    return [];
  } finally {
    shareSheetPrepRunning = false;
    updateSharePrepUiDisplay();
    updateButtons();
  }
}

async function runZipDownload() {
  clearError();
  if (!workItems.length || zipDownloadInProgress) return;
  invalidateShareSheetPrep();
  zipDownloadInProgress = true;
  updateCropReviewChrome();
  btnCrop.disabled = true;
  if (btnShareInat) btnShareInat.disabled = true;
  lastShareInatFiles = [];
  lastShareInatSourceFiles = [];
  setZipDownloadProgress(true, 0, "ZIP…", { indeterminate: true });

  const total = workItems.length;
  let zipSucceeded = false;
  try {
    await refreshWorkItemsCaptureOrder();
    const zip = new JSZip();
    const zipOpts = { compression: "STORE" };
    const memoryLight = heavyBatchMode();
    const indexWidth = Math.max(3, String(total).length);
    const shareAcc = { files: [], sources: [] };
    let failures = 0;
    let packed = 0;

    for (let i = 0; i < total; i++) {
      if (shouldYieldBetweenBatchItems() && i > 0) await new Promise((r) => setTimeout(r, 0));
      const prepLine = `Image ${i + 1} / ${total}`;
      setZipDownloadProgress(
        true,
        total > 0 ? Math.min(45, Math.round(((i + 1) / total) * 45)) : 0,
        prepLine,
        { indeterminate: false }
      );

      const file = workItems[i];
      const key = fileCacheKey(file);
      const indexPrefix = String(i + 1).padStart(indexWidth, "0");

      try {
        const prep = await ensureExportPrepReady(key);
        if (!prep || prep.kind === "fail") {
          failures++;
          continue;
        }

        let outFile;
        if (prep.kind === "original") {
          const name = `${indexPrefix}_${exportFilenameWithJpgExt(file.name)}`;
          const src = prep.sourceFile;
          outFile = new File([src], name, {
            type: prep.mime,
            lastModified: prep.meta.lastModified,
          });
          shareAcc.files.push(outFile);
          shareAcc.sources.push(src);
        } else {
          const base = file.name.replace(/\.[^.]+$/i, "");
          const name = `${indexPrefix}_${base}_square.${CROP_EXPORT_FORMAT.ext}`;
          outFile = new File([prep.blob], name, {
            type: CROP_EXPORT_FORMAT.mime,
            lastModified: prep.meta.lastModified,
          });
          shareAcc.files.push(outFile);
          shareAcc.sources.push(prep.sourceFile);
        }

        if (memoryLight) exportPrepCache.delete(key);

        const mtime =
          typeof outFile.lastModified === "number" && Number.isFinite(outFile.lastModified) ? outFile.lastModified : Date.now();
        zip.file(outFile.name, outFile, { ...zipOpts, date: new Date(mtime) });
        packed++;
        const packPct = 45 + Math.round(((i + 1) / Math.max(total, 1)) * 10);
        const line = `ZIP ${packed} added`;
        setZipDownloadProgress(true, Math.min(54, packPct), `${line}…`, { indeterminate: false });
        if (i % 5 === 0) await new Promise((r) => setTimeout(r, 0));
      } catch (err) {
        console.error(err);
        failures++;
      }
    }

    const names = Object.keys(zip.files).filter((k) => !zip.files[k].dir);
    if (names.length === 0) {
      showError("Nothing exported. Retry Download ZIP.");
      return;
    }

    const compressLine = "Compressing…";
    setZipDownloadProgress(true, 55, compressLine, { indeterminate: true });

    const zipBlob = await zip.generateAsync(
      {
        type: "blob",
        compression: "DEFLATE",
        streamFiles: true,
      },
      (meta) => {
        const p = typeof meta.percent === "number" ? meta.percent : 0;
        const line = `ZIP ${Math.round(p)}%`;
        const barPct = 55 + Math.round((p / 100) * 45);
        setZipDownloadProgress(true, barPct, line, { indeterminate: false });
      }
    );
    const a = document.createElement("a");
    a.href = URL.createObjectURL(zipBlob);
    a.download = "subject-square-crops.zip";
    a.rel = "noopener";
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2500);
    setZipDownloadProgress(
      true,
      100,
      failures > 0 ? `Done · ${failures} skipped` : "Done.",
      { indeterminate: false }
    );
    zipSucceeded = true;
    // Omit lastShareInat* = shareAcc.* — nothing reads them and they duplicated every export in RAM.
  } catch (e) {
    console.error(e);
    const msg = e && typeof e === "object" && "message" in e ? String(e.message) : String(e);
    const oom = /memory|allocation|heap|QuotaExceeded|out of memory/i.test(msg);
    showError(
      (oom ? "Out of memory — fewer photos or close tabs." : "ZIP failed.") + " Retry Download ZIP.",
      e
    );
    lastShareInatFiles = [];
    lastShareInatSourceFiles = [];
  } finally {
    zipDownloadInProgress = false;
    updateCropReviewChrome();
    btnCrop.disabled = false;
    if (!zipSucceeded) setZipDownloadProgress(false, 0, "", {});
    updateButtons();
  }
}

btnCrop.addEventListener("click", () => {
  void runZipDownload();
});

if (btnShareInat) {
  btnShareInat.addEventListener("click", async () => {
    if (!workItems.length) return;
    if (typeof navigator.share !== "function") {
      showError("Sharing unavailable. Use Download ZIP.");
      return;
    }
    clearError();
    const files = await prepareShareSheetFilesForShare();
    if (!files.length) {
      showError("Nothing to share. Use Download ZIP.");
      updateButtons();
      return;
    }
    if (isAndroidBrowser() && files.length > 1) {
      showError(
        "Chrome on Android can crash when sharing several images at once. Use Download ZIP, or save images one at a time.",
      );
      updateButtons();
      return;
    }
    let sharePromise;
    try {
      /* Only `files` — pairing `title`/`text` with `files` has broken Android WebView / Chrome builds. */
      sharePromise = navigator.share({ files });
    } catch (e) {
      const msg = e && typeof e === "object" && "message" in e ? String(e.message) : String(e);
      showError(`Share could not start: ${msg} Use Download ZIP.`);
      updateButtons();
      return;
    }
    void sharePromise
      .catch((e) => {
        if (e && e.name === "AbortError") return;
        const msg = e && typeof e === "object" && "message" in e ? String(e.message) : String(e);
        showError(`Share failed: ${msg} Use Download ZIP.`);
      })
      .finally(() => {
        invalidateShareSheetPrep();
        updateButtons();
      });
  });
}

if (btnInatUploadTokenApply && inatUploadToken) {
  btnInatUploadTokenApply.addEventListener("click", () => {
    clearError();
    const pasted = inatUploadToken.value;
    const parsed = parseInatApiTokenPaste(pasted);
    if (parsed.error || !parsed.token) {
      showError(parsed.error || "Could not read token.");
      return;
    }
    const saved = persistParsedInatApiJwt(parsed.token);
    if (!saved.ok) {
      showError(saved.error || "Could not save token.");
      return;
    }
    inatUploadToken.value = "";
    void refreshInatUploadAuthUi();
  });
}

if (btnInatUploadTokenClear) {
  btnInatUploadTokenClear.addEventListener("click", () => {
    clearError();
    clearStoredInatApiJwt();
    if (inatUploadToken) inatUploadToken.value = "";
    for (const g of inatUploadGroups) {
      g.species = "";
      g.taxonId = "";
    }
    hideAllInatGroupSpeciesSuggests();
    if (inatUploadGrouping && !inatUploadGrouping.hidden && workItems.length && isCropReviewFinished()) {
      renderInatPhotoGroupingStrip();
    }
    void refreshInatUploadAuthUi();
  });
}

if (btnInatUploadObs) {
  btnInatUploadObs.addEventListener("click", () => {
    void runInatObservationUpload();
  });
}

if (btnInatCvAll) {
  btnInatCvAll.addEventListener("click", () => {
    void runInatCvForAllObservations();
  });
}

/**
 * Playwright / automation hooks (guarded — only when URL contains `e2e=1`).
 * Not used in normal browsing.
 */
function installE2EHooksIfNeeded() {
  try {
    if (typeof window === "undefined" || !window.location.search.includes("e2e=1")) return;
    window.__sqcE2E = {
      advance: () => {
        advanceCropReview();
        return isCropReviewFinished();
      },
      removeCurrent: () => {
        const row = previewGrid.querySelector("article.preview-row");
        if (!row || !workItems.length) return false;
        const key = row.dataset.fileKey;
        if (!key) return false;
        const file = workItems.find((f) => fileCacheKey(f) === key);
        if (!file) return false;
        removeWorkItemAndRow(file, row);
        return true;
      },
      finishReview: () => {
        let guard = 0;
        while (!isCropReviewFinished() && workItems.length && guard < 5000) {
          advanceCropReview();
          guard += 1;
        }
        return isCropReviewFinished();
      },
      panCrop: (dx, dy) => {
        const vp = previewGrid.querySelector(".crop-viewport");
        if (!vp) return false;
        const r = vp.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        const dxa = dx != null ? Number(dx) : 30;
        const dya = dy != null ? Number(dy) : 0;
        vp.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: x, clientY: y, pointerId: 1, pointerType: "mouse", isPrimary: true }));
        vp.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: x + dxa, clientY: y + dya, pointerId: 1, pointerType: "mouse", isPrimary: true }));
        vp.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: x + dxa, clientY: y + dya, pointerId: 1, pointerType: "mouse", isPrimary: true }));
        return true;
      },
      getCounts: () => ({
        files: workItems.length,
        reviewDone: cropReviewDoneKeys.size,
        exportPage: pageExport && !pageExport.hidden,
        allAnalyzed:
          workItems.length > 0 &&
          workItems.every((f) => cropState.has(fileCacheKey(f))),
      }),
    };
  } catch (e) {
    console.warn("installE2EHooksIfNeeded", e);
  }
}

installE2EHooksIfNeeded();

void cropMappingsSessionRestorePromise.then(() => {
  setCurrentPage("setup");
  updateButtons();
  installE2EHooksIfNeeded();
});

window.addEventListener("error", (ev) => {
  console.error(ev.error || ev.message);
  let detail = "";
  let diag = ev.error;
  if (ev.error != null) detail = errorDetailForUser(ev.error);
  else if (ev.message && ev.message !== "Script error.") {
    detail = errorDetailForUser(ev.message);
    diag = new Error(ev.message);
  }
  if (!detail) {
    detail =
      "Script error (the browser hid the message — often a cross-origin script).";
  }
  showError(
    `Unexpected error: ${detail} If the page looks broken, reload — your work may be restored.`,
    diag
  );
});

window.addEventListener("unhandledrejection", (ev) => {
  console.error(ev.reason);
  const detail = errorDetailForUser(ev.reason);
  showError(
    detail
      ? `Unhandled promise error: ${detail} If the page looks broken, reload — your work may be restored.`
      : "Unhandled promise rejection. If the page looks broken, reload — your work may be restored.",
    ev.reason
  );
});
