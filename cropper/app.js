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

/** Real `fetch` before any temporary patching; bare `fetch()` inside our wrapper would recurse into `window.fetch`. */
const nativeFetch = globalThis.fetch.bind(globalThis);

const MODEL_CACHE_NAME = "coco-ssd-model-v2";
/** Default COCO-SSD variant: fewer / smaller weight shards than full mobilenet_v2 (~17), better on mobile Safari. */
const COCO_SSD_BASE = "lite_mobilenet_v2";

/** Crash / reload recovery: persist batch + crop progress to IndexedDB (debounced). */
const SESSION_IDB_NAME = "subject-square-crop-session";
const SESSION_IDB_VER = 1;
const SESSION_STORE = "kv";
const SESSION_KEY = "v1";
let sessionPersistTimer = null;
let sessionDbPromise = null;

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

/** Skip persisting huge clips so IndexedDB quota / memory spikes don’t take down the tab. */
const MAX_SESSION_FILE_BYTES = 95 * 1024 * 1024;
/** Desktop: duplicate ArrayBuffers during persist spike RSS. */
const MAX_SESSION_TOTAL_BYTES_DESKTOP = 200 * 1024 * 1024;
/** iOS WebKit is stricter; duplicate buffers + TF often crash before quota errors. */
const MAX_SESSION_TOTAL_BYTES_IOS = 64 * 1024 * 1024;
/**
 * Never persist more than N files (each `arrayBuffer()` doubles memory briefly).
 * Desktop cap must allow the advertised batch limit (`MAX_BATCH_FILES`) so reload restores
 * large selections (e.g. 100 × ~1 MiB stays under `MAX_SESSION_TOTAL_BYTES_DESKTOP`).
 */
const SESSION_PERSIST_MAX_FILES_DESKTOP = 180;
const SESSION_PERSIST_MAX_FILES_IOS = 36;

function maxSessionTotalBytes() {
  return isIOSOrIPadOS() ? MAX_SESSION_TOTAL_BYTES_IOS : MAX_SESSION_TOTAL_BYTES_DESKTOP;
}

function sessionPersistMaxFiles() {
  return isIOSOrIPadOS() ? SESSION_PERSIST_MAX_FILES_IOS : SESSION_PERSIST_MAX_FILES_DESKTOP;
}

function schedulePersistSession() {
  if (typeof indexedDB === "undefined") return;
  if (!workItems.length) return;
  if (workItems.length > sessionPersistMaxFiles()) return;
  if (sessionPersistTimer != null) clearTimeout(sessionPersistTimer);
  sessionPersistTimer = setTimeout(() => {
    sessionPersistTimer = null;
    void persistSessionNow();
  }, 650);
}

/** Run pending debounced save immediately (e.g. before tab background/close). */
function flushPendingSessionPersist() {
  if (sessionPersistTimer != null) {
    clearTimeout(sessionPersistTimer);
    sessionPersistTimer = null;
  }
  if (workItems.length) void persistSessionNow();
}

async function persistSessionNow() {
  if (typeof indexedDB === "undefined" || !workItems.length) return;
  if (workItems.length > sessionPersistMaxFiles()) {
    console.warn("Session persist: too many files — skipping (memory)");
    setSessionPersistNotice(
      `Reload recovery unavailable: this batch has ${workItems.length} photos, but saving more than ${sessionPersistMaxFiles()} files is disabled to avoid running out of memory. Download ZIP or finish before closing the tab.`
    );
    return;
  }
  try {
    let totalBytes = 0;
    const fileParts = [];
    const cap = maxSessionTotalBytes();
    const n = workItems.length;
    for (let i = 0; i < n; i++) {
      const f = workItems[i];
      if (f.size > MAX_SESSION_FILE_BYTES) {
        console.warn("Session persist: skipping oversized file", f.name);
        setSessionPersistNotice(
          `Reload recovery unavailable: “${f.name || "A photo"}” is larger than the safe save limit (${Math.round(MAX_SESSION_FILE_BYTES / (1024 * 1024))} MB). Download ZIP or remove that file.`
        );
        return;
      }
      totalBytes += f.size;
      if (totalBytes > cap) {
        console.warn("Session persist: batch too large to save");
        setSessionPersistNotice(
          `Reload recovery unavailable: total size of this batch exceeds the safe save limit (~${Math.round(cap / (1024 * 1024))} MB). Download ZIP or use fewer / smaller photos.`
        );
        return;
      }
      let buffer;
      try {
        buffer = await f.arrayBuffer();
      } catch (e) {
        console.warn("Session persist: could not read file — skipping save", e);
        setSessionPersistNotice(
          "Reload recovery unavailable: a photo could not be read for saving. Download ZIP to keep your work."
        );
        return;
      }
      fileParts.push({
        name: f.name,
        size: f.size,
        lastModified: f.lastModified,
        type: f.type || "",
        buffer,
      });
      /** Yield so large batches are less likely to freeze or crash the tab (especially iOS). */
      if (i < n - 1 && shouldYieldBetweenBatchItems()) await new Promise((r) => setTimeout(r, 0));
    }
    const payload = {
      v: 1,
      /** v2: newest-first `cropReviewIndex`; v3: persist omits `source`; restore does not jump review slot. */
      cropUiRev: 3,
      previewGeneration,
      cropReviewIndex,
      cropReviewDoneKeys: [...cropReviewDoneKeys],
      analysisPendingKeys: [...analysisPendingKeys],
      cropStateEntries: [...cropState.entries()].map(([k, v]) => [k, sanitizeCropStateForSession(v)]),
      previewSlotErrorsEntries: [...previewSlotErrors.entries()],
      fileParts,
    };
    const db = await openSessionIdb();
    if (!db) return;
    await new Promise((resolve, reject) => {
      const tx = db.transaction(SESSION_STORE, "readwrite");
      tx.objectStore(SESSION_STORE).put(payload, SESSION_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    setSessionPersistNotice("");
  } catch (e) {
    console.warn("persistSessionNow", e);
    setSessionPersistNotice(
      `Reload recovery unavailable: could not save to browser storage (${e && e.message ? String(e.message) : "unknown error"}). Download ZIP to keep your work.`
    );
  }
}

function setSessionRestoreProgress(pct, options) {
  const wrap = document.getElementById("session-restore-progress-wrap");
  const bar = document.getElementById("session-restore-progress");
  const fill = document.getElementById("session-restore-progress-fill");
  if (!wrap || !bar || !fill) return;
  const indeterminate = options && options.indeterminate;
  if (indeterminate) {
    wrap.hidden = false;
    bar.classList.add("progress--indeterminate");
    fill.classList.add("progress__fill--indeterminate");
    fill.style.width = "";
    bar.removeAttribute("aria-valuenow");
    bar.setAttribute("aria-valuetext", "In progress");
    return;
  }
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  wrap.hidden = false;
  bar.classList.remove("progress--indeterminate");
  fill.classList.remove("progress__fill--indeterminate");
  fill.style.width = `${p}%`;
  bar.setAttribute("aria-valuenow", String(Math.round(p)));
  bar.setAttribute("aria-valuetext", `${Math.round(p)}%`);
}

function resetSessionRestoreProgressUi() {
  const wrap = document.getElementById("session-restore-progress-wrap");
  const bar = document.getElementById("session-restore-progress");
  const fill = document.getElementById("session-restore-progress-fill");
  if (wrap) wrap.hidden = true;
  if (bar) {
    bar.classList.remove("progress--indeterminate");
    bar.removeAttribute("aria-valuenow");
    bar.removeAttribute("aria-valuetext");
  }
  if (fill) {
    fill.classList.remove("progress__fill--indeterminate");
    fill.style.width = "";
  }
}

function setSessionRestoreOverlay(visible, options) {
  const el = document.getElementById("session-restore-overlay");
  if (!el) return;
  const textEl = el.querySelector(".session-restore-overlay__text");
  if (textEl) {
    if (visible && options && options.text != null) {
      textEl.textContent = String(options.text);
    } else if (!visible) {
      const def = textEl.getAttribute("data-default-text");
      if (def) textEl.textContent = def;
    }
  }
  if (!visible) {
    resetSessionRestoreProgressUi();
  } else if (options && options.progress != null) {
    setSessionRestoreProgress(options.progress, { indeterminate: Boolean(options.progressIndeterminate) });
  } else if (options && options.progressIndeterminate) {
    setSessionRestoreProgress(0, { indeterminate: true });
  }
  el.hidden = !visible;
  el.setAttribute("aria-busy", visible ? "true" : "false");
  if (visible && options && options.text != null) {
    el.setAttribute("aria-label", String(options.text).replace(/\u2026/g, "..."));
  } else if (!visible) {
    el.setAttribute("aria-label", "Restoring your session");
  }
}

async function tryRestoreSessionFromIdb() {
  if (typeof indexedDB === "undefined") return false;
  let restoreUiShown = false;
  try {
    const db = await openSessionIdb();
    if (!db) return false;

    setSessionRestoreOverlay(true, { text: "Loading saved session…", progressIndeterminate: true });
    restoreUiShown = true;
    /** Let the browser paint the overlay before IndexedDB + heavy work (otherwise it can stay blank). */
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    const payload = await new Promise((resolve, reject) => {
      const tx = db.transaction(SESSION_STORE, "readonly");
      const r = tx.objectStore(SESSION_STORE).get(SESSION_KEY);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    if (!payload || !payload.v || !Array.isArray(payload.fileParts) || !payload.fileParts.length) {
      return false;
    }

    let restoreTotal = 0;
    for (const p of payload.fileParts) {
      restoreTotal += p && typeof p.size === "number" ? p.size : 0;
    }
    if (
      payload.fileParts.length > sessionPersistMaxFiles() ||
      restoreTotal > maxSessionTotalBytes()
    ) {
      console.warn("tryRestoreSessionFromIdb: stored session too large — clearing");
      await clearPersistedSession();
      return false;
    }

    const totalFiles = payload.fileParts.length;
    const photoStepText = (index1, n) =>
      n > 1 ? `Restoring photo ${index1} of ${n}…` : "Restoring your photo…";

    setSessionRestoreOverlay(true, { text: "Unpacking saved session…", progress: 0 });
    await new Promise((r) => requestAnimationFrame(r));

    workItems = [];
    for (let i = 0; i < payload.fileParts.length; i++) {
      const p = payload.fileParts[i];
      workItems.push(
        new File([p.buffer], p.name, { type: p.type || "application/octet-stream", lastModified: p.lastModified })
      );
      const stepPct = ((i + 1) / totalFiles) * 50;
      setSessionRestoreOverlay(true, {
        text: photoStepText(i + 1, totalFiles),
        progress: stepPct,
      });
      if (i < payload.fileParts.length - 1) await new Promise((r) => requestAnimationFrame(r));
    }

    setSessionRestoreOverlay(true, { text: "Applying crop data…", progress: 55 });
    await new Promise((r) => requestAnimationFrame(r));

    previewGeneration = (payload.previewGeneration != null ? Number(payload.previewGeneration) : 0) + 10000;
    {
      const n = workItems.length;
      let ri = Number(payload.cropReviewIndex) || 0;
      /** v1 sessions stored oldest-first index; v2 stores newest-first offset. */
      if (payload.cropUiRev !== 2 && n > 0) {
        const oldFi = Math.max(0, Math.min(ri, n - 1));
        ri = Math.max(0, Math.min(n - 1 - oldFi, n - 1));
      }
      cropReviewIndex = Math.max(0, Math.min(n - 1, ri));
    }
    cropReviewDoneKeys.clear();
    for (const k of payload.cropReviewDoneKeys || []) cropReviewDoneKeys.add(String(k));
    analysisPendingKeys.clear();
    for (const k of payload.analysisPendingKeys || []) analysisPendingKeys.add(String(k));
    cropState.clear();
    for (const [k, v] of payload.cropStateEntries || []) {
      if (k && v && typeof v === "object") cropState.set(String(k), sanitizeCropStateForSession(v));
    }
    previewSlotErrors.clear();
    for (const [k, v] of payload.previewSlotErrorsEntries || []) {
      if (k != null) previewSlotErrors.set(String(k), String(v));
    }
    pruneAnalysisPendingKeysToWorkItems();

    setSessionRestoreOverlay(true, { text: "Preparing editor…", progress: 72 });
    await new Promise((r) => requestAnimationFrame(r));

    revokePreviewUrls();
    filePreviewUrlByKey.clear();
    exportPrepCache.clear();
    exportPrepInflight.clear();
    shareSheetReadyFiles = null;
    shareSheetPrepareGen++;
    lastShareInatFiles = [];
    lastShareInatSourceFiles = [];

    setSessionRestoreOverlay(true, { text: "Almost ready…", progress: 92 });
    await new Promise((r) => requestAnimationFrame(r));

    /** Keep restored `cropReviewIndex` — do not jump to “first unreviewed” (that broke resume UX). */
    if (fileSummary) {
      fileSummary.textContent = "Restored your last session — continue where you left off.";
    }
    clearError();
    if (isCropReviewFinished()) {
      setCurrentPage("export");
      prepareShareSheetFilesInBackground();
    } else {
      setCurrentPage("crop");
      renderCropEditorSlot();
    }
    updateCropReviewChrome();
    updateButtons();
    resumeAnalysisAfterRestoreIfNeeded();
    return true;
  } catch (e) {
    console.warn("tryRestoreSessionFromIdb", e);
    return false;
  } finally {
    if (restoreUiShown) setSessionRestoreOverlay(false);
  }
}

/**
 * After reload, finish background analysis for items still in `analysisPendingKeys`.
 */
function resumeAnalysisAfterRestoreIfNeeded() {
  if (!workItems.length || isCropReviewFinished()) return;
  if (!analysisPendingKeys.size) return;
  const gen = previewGeneration;
  void ensureModel()
    .then((detModel) => {
      if (gen !== previewGeneration) return;
      runRemainingAnalysisInBackground(gen, detModel, PADDING_FRAC, MIN_DETECTION_SCORE);
    })
    .catch((e) => {
      console.warn("resumeAnalysisAfterRestoreIfNeeded", e);
    });
}

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
const batchProgress = document.getElementById("batch-progress");
const sharePrepProgress = document.getElementById("share-prep-progress");
const sharePrepLine = document.getElementById("share-prep-line");
const sharePrepBar = document.getElementById("share-prep-bar");
const sharePrepFill = document.getElementById("share-prep-fill");
const cropExportBar = document.getElementById("crop-export-bar");
const zipDownloadPanel = document.getElementById("zip-download-panel");
const zipDownloadLine = document.getElementById("zip-download-line");
const zipDownloadBar = document.getElementById("zip-download-bar");
const zipDownloadFill = document.getElementById("zip-download-fill");
const pageSetup = document.getElementById("page-setup");
const pageCrop = document.getElementById("page-crop");
const pageExport = document.getElementById("page-export");
const btnStartOver = document.getElementById("btn-start-over");
/** Set while the crop review toolbar is mounted (progress lives in `.crop-toolbar__progress`). */
let cropToolbarProgressEl = null;

const PREVIEW_MAX_EDGE = 720;
const PREVIEW_MAX_EDGE_IOS = 520;
/** Run COCO-SSD on a downscaled copy so large photos do not spike WebGL / RAM. Bboxes are mapped back to full resolution. */
const DETECTION_MAX_EDGE = 1280;

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

/**
 * JPEG `File`s ready for `navigator.share({ files })` — built on the export step before the user taps Share
 * so the click handler can call `share()` synchronously (required for user activation / NotAllowedError).
 * `null` = preparing or not started; `[]` = ready but nothing shareable.
 * @type {File[] | null}
 */
let shareSheetReadyFiles = null;
/** Bumps when starting a new prep so stale async work does not flip state. */
let shareSheetPrepareGen = 0;
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
 * @type {Map<string, { kind: 'crop', blob: Blob, meta: Awaited<ReturnType<typeof extractMetaForEmbedding>>, sourceFile: File } | { kind: 'original', buffer: ArrayBuffer, meta: Awaited<ReturnType<typeof extractMetaForEmbedding>>, mime: string } | { kind: 'fail' }>}
 */
const exportPrepCache = new Map();
/** In-flight prep so we do not duplicate work for the same key. */
const exportPrepInflight = new Map();

let zipDownloadInProgress = false;

/** Minimum detector score to accept a crop (fixed at 0 = any detection). */
const MIN_DETECTION_SCORE = 0;

/**
 * Large batches: aggressive preview prefetch limits + do not retain export payloads in RAM after each encode.
 * Share, ZIP, and background prep still run — we only tune memory retention, not features.
 */
function heavyBatchMode() {
  return workItems.length >= memoryPressureThreshold();
}

function fileCacheKey(file) {
  return `${file.name}\0${file.size}\0${file.lastModified}`;
}

/** Decoded bitmap/canvas handles must not be persisted — strip before IndexedDB / after restore. */
function sanitizeCropStateForSession(st) {
  if (!st || typeof st !== "object") return st;
  if (!("source" in st)) return st;
  const { source: _drop, ...rest } = st;
  return rest;
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
  shareSheetReadyFiles = null;
  shareSheetPrepareGen++;
  sharePrepStatusText = "";
  shareSheetBuildIndex = 0;
  shareSheetBuildTotal = 0;
  setSharePrepProgress(false, 0, "", {});
  clearSessionPersistNotice();
  void clearPersistedSession();
}

function invalidateShareSheetPrep() {
  shareSheetReadyFiles = null;
  shareSheetPrepareGen++;
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
 * Wizard pages: setup → crop (editor) → export (ZIP / Share after review).
 * @param {"setup" | "crop" | "export"} name
 */
function setCurrentPage(name) {
  if (pageSetup) pageSetup.hidden = name !== "setup";
  if (pageCrop) pageCrop.hidden = name !== "crop";
  if (pageExport) pageExport.hidden = name !== "export";
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
        showError("Couldn’t show this image. Try the previous/next arrows or delete the file.");
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
  queueExportPrepForKey(confirmedKey);
  syncCropReviewIndex();
  renderCropEditorSlot();
  if (isCropReviewFinished()) {
    setCurrentPage("export");
    prepareShareSheetFilesInBackground();
  }
  updateButtons();
  schedulePersistSession();
}

/** Go to newer photo without confirming (reverse-chrono: back = toward newest). */
function retreatCropReview() {
  if (!workItems.length || isCropReviewFinished()) return;
  if (cropReviewIndex <= 0) return;
  cropReviewIndex -= 1;
  renderCropEditorSlot();
  updateButtons();
}

/**
 * After a photo is checked off, decode/crop/encode in the background when possible.
 * Large batches still run this path; `buildExportPayloadForKey` avoids retaining blobs in RAM.
 */
function queueExportPrepForKey(key) {
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
}

/**
 * @returns {Promise<{ kind: 'crop', blob: Blob, meta: object, sourceFile: File } | { kind: 'original', buffer: ArrayBuffer, meta: object, mime: string } | { kind: 'fail' } | undefined>}
 */
async function buildExportPayloadForKey(key) {
  const file = workItems.find((f) => fileCacheKey(f) === key);
  if (!file) return;
  const state = cropState.get(key);
  const meta = await extractMetaForEmbedding(file);
  const heavyBatch = heavyBatchMode();

  if (!state || !state.hasCrop) {
    const buf = await file.arrayBuffer();
    let lastMs = meta.lastModified;
    const mime = (file.type || "").toLowerCase();
    const looksJpeg = mime === "image/jpeg" || mime === "image/jpg" || /\.jpe?g$/i.test(file.name || "");
    if (looksJpeg) {
      const fromEmb = await lastModifiedMsFromJpegBlob(new Blob([buf], { type: "image/jpeg" }));
      if (fromEmb != null) lastMs = fromEmb;
    }
    const metaOut = { ...meta, lastModified: lastMs };
    const prep = { kind: "original", buffer: buf, meta: metaOut, mime: file.type || "application/octet-stream" };
    if (workItems.some((f) => fileCacheKey(f) === key) && !heavyBatch) {
      exportPrepCache.set(key, prep);
    }
    return prep;
  }

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

/** After changing crop `side`, keep the same image point at the viewport center (zoom slider anchor). */
function anchorCropCenterOnZoom(prev, nextSide, imgW, imgH, minSide) {
  const cx = prev.left + prev.side / 2;
  const cy = prev.top + prev.side / 2;
  let left = cx - nextSide / 2;
  let top = cy - nextSide / 2;
  return clampSquareCropInImageFloat(left, top, nextSide, imgW, imgH, minSide);
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
const CROP_PREVIEW_PREFETCH_AHEAD = 4;
/** Large batches: fewer prefetch probes and more aggressive blob-URL eviction (mobile RAM). */
const MEMORY_PRESSURE_FILE_THRESHOLD = 44;
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
  return isIOSOrIPadOS() ? Math.min(MEMORY_PRESSURE_FILE_THRESHOLD, 32) : MEMORY_PRESSURE_FILE_THRESHOLD;
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

/** Epoch ms from embedded EXIF in a JPEG `Blob` (output bytes), or null. */
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

function latLonAltitudeFromExifr(ex) {
  let lat = typeof ex.latitude === "number" ? ex.latitude : undefined;
  let lon = typeof ex.longitude === "number" ? ex.longitude : undefined;
  if ((lat == null || lon == null) && ex.gps && typeof ex.gps.latitude === "number" && typeof ex.gps.longitude === "number") {
    lat = ex.gps.latitude; lon = ex.gps.longitude;
  }
  if ((lat == null || lon == null) && ex.GPSLatitude != null && ex.GPSLongitude != null) {
    lat = ex.GPSLatitude; lon = ex.GPSLongitude;
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

/** Drop blob URLs far from the current review index so hundreds of files do not all stay resident. */
function revokeDistantPreviewBlobUrls() {
  const pressure = memoryPressureThreshold();
  if (workItems.length < pressure) return;
  const keepRadius = workItems.length >= pressure ? 2 : 4;
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
  void createImageBitmap(file)
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
  progressLine.hidden = !visible;
  progressBar.hidden = !visible;
  if (!visible) {
    progressLine.textContent = "";
  } else if (!skipTextLine && text !== undefined) {
    progressLine.textContent = text;
  }
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
  if (cropExportBar) cropExportBar.hidden = !show;
}

function updateSharePrepUiDisplay() {
  const onExportPage = pageExport && !pageExport.hidden;
  const zipReady =
    workItems.length > 0 &&
    workItems.some((f) => cropState.get(fileCacheKey(f))) &&
    isCropReviewFinished();
  const sharePrepPending =
    onExportPage &&
    zipReady &&
    typeof navigator.share === "function" &&
    shareSheetReadyFiles === null;
  if (!sharePrepPending) {
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
    /** JPEGs for the share sheet are built in the background after review; disable until ready. */
    const sharePrepPending =
      onExportPage &&
      zipReady &&
      typeof navigator.share === "function" &&
      shareSheetReadyFiles === null;
    const shareNothingReady =
      onExportPage &&
      zipReady &&
      typeof navigator.share === "function" &&
      Array.isArray(shareSheetReadyFiles) &&
      shareSheetReadyFiles.length === 0;
    btnShareInat.disabled =
      !zipReady ||
      typeof navigator.share !== "function" ||
      sharePrepPending ||
      shareNothingReady;
    btnShareInat.title = sharePrepPending
      ? "Preparing images for share…"
      : shareNothingReady
        ? "Nothing to share — use Download ZIP"
        : "Share JPEGs only";
  }
  updateCropExportActionsVisibility();
  updateSharePrepUiDisplay();
  if (workItems.length) schedulePersistSession();
}

/**
 * Remove a photo from the batch and revoke its preview blob URL.
 */
function removeWorkItemAndRow(file, row) {
  /** Invalidate idle/rAF prefetch — without this, `createImageBitmap` completions can run after splice/teardown and crash WebKit (esp. last-item delete). */
  bumpPrefetchToken();
  /**
   * Abort Share prep immediately — `releaseBatchResources()` (deferred on empty batch) also invalidates,
   * but async `buildExportFilesListForZip` / `prepareShareSheetFilesInBackground` can still run until
   * that turn; touching removed `File`s then crashes the tab (esp. last photo in the set).
   */
  invalidateShareSheetPrep();
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
  /** Stop pan/zoom/rAF before mutating batch — avoids touching detached DOM after splice. */
  if (typeof row._abortCropEditorUi === "function") {
    try {
      row._abortCropEditorUi();
    } catch {
      /* ignore */
    }
  }
  /** Revoke blob preview URLs for `<img>` (canvas-based previews have no blob src). */
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
  const idx = workItems.findIndex((f) => fileCacheKey(f) === key);
  if (idx >= 0) {
    const n = workItems.length;
    const fi = n - 1 - cropReviewIndex;
    workItems.splice(idx, 1);
    const m = workItems.length;
    if (m) {
      if (idx === fi) syncCropReviewIndex();
      else if (idx > fi) cropReviewIndex = Math.max(0, cropReviewIndex - 1);
      cropReviewIndex = Math.max(0, Math.min(cropReviewIndex, m - 1));
    }
  }
  pruneAnalysisPendingKeysToWorkItems();
  row.remove();
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
    if (cropExportBar) cropExportBar.hidden = true;
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
        void clearPersistedSession();
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
      prepareShareSheetFilesInBackground();
    }
  }
  updateButtons();
}

/** Navigate crop queue — forward confirms current photo and advances (last item finishes batch). */
const NAV_FORWARD_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';

const NAV_BACK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>';

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
 * Toolbar: progress; row with back arrow | full-image, delete, optional reset | forward arrow.
 */
function attachBatchRowActions(row, file, options) {
  const { variant, showNextCheck, onResetSuggested } = options || {};
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
      cropState.set(key, nextState);
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
      cropState.set(key, {
        w,
        h,
        hasCrop: false,
        det: prev && prev.det ? prev.det : null,
        savedSquareCrop: saved || undefined,
      });
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
    nav.className = "crop-toolbar__nav crop-toolbar__nav--five";

    const btnPrev = document.createElement("button");
    btnPrev.type = "button";
    btnPrev.className = "btn-icon btn-icon--nav-back";
    btnPrev.innerHTML = NAV_BACK_SVG;
    btnPrev.title = "Newer photo";
    btnPrev.setAttribute("aria-label", "Newer photo");
    const canGoBack = cropReviewIndex > 0;
    btnPrev.disabled = !canGoBack || variant === "pending";
    if (!canGoBack) {
      btnPrev.title = "No newer photo";
      btnPrev.setAttribute("aria-label", "No newer photo");
    }
    btnPrev.addEventListener("click", () => retreatCropReview());

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

    const btnNext = document.createElement("button");
    btnNext.type = "button";
    btnNext.className = "btn-icon btn-icon--nav-forward";
    const atLast = cropReviewIndex <= 0;
    if (variant === "pending") {
      btnNext.disabled = true;
      btnNext.title = "Wait for analysis";
      btnNext.setAttribute("aria-label", "Wait for analysis");
    } else {
      btnNext.title = atLast ? "Finish" : "Next photo";
      btnNext.setAttribute("aria-label", atLast ? "Finish and export" : "Accept and next photo");
      btnNext.addEventListener("click", () => advanceCropReview());
    }
    btnNext.innerHTML = NAV_FORWARD_SVG;

    function makeSlot(child) {
      const slot = document.createElement("div");
      slot.className = "crop-toolbar__nav-slot";
      slot.appendChild(child);
      return slot;
    }

    nav.append(
      makeSlot(btnPrev),
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
      makeSlot(btnNext)
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
  const preBm = cropPreviewBitmapByKey.get(key);
  if (preBm) {
    cropPreviewBitmapByKey.delete(key);
    const c = document.createElement("canvas");
    c.className = "crop-preview-canvas";
    c.width = preBm.width;
    c.height = preBm.height;
    const pctx = c.getContext("2d", { willReadFrequently: false });
    if (pctx) pctx.drawImage(preBm, 0, 0);
    try {
      preBm.close();
    } catch { /* ignore */ }
    img = c;
    queueMicrotask(() => {
      syncFixedViewportLayout();
      syncZoomSliderFromState();
    });
  } else {
    const im = document.createElement("img");
    im.src = getOrCreateFilePreviewUrl(file);
    im.alt = "";
    im.draggable = false;
    /** Async decode keeps main thread responsive while the crop UI paints. */
    im.decoding = "async";
    im.loading = "eager";
    try {
      if ("fetchPriority" in im) im.fetchPriority = "high";
    } catch { /* ignore */ }
    im.setAttribute("draggable", "false");
    img = im;
  }

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

  const viewport = document.createElement("div");
  viewport.className = "crop-viewport";
  viewport.setAttribute("role", "application");
  viewport.setAttribute("aria-label", "Pan image");

  const imageLayer = document.createElement("div");
  imageLayer.className = "crop-image-layer";

  const frameEl = document.createElement("div");
  frameEl.className = "crop-viewport__frame";
  frameEl.setAttribute("aria-hidden", "true");

  imageLayer.appendChild(img);
  viewport.appendChild(imageLayer);
  viewport.appendChild(frameEl);
  editorWrap.appendChild(viewport);

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
    const dim = Math.min(state.w, state.h);
    const coarse = isCoarsePointerPrimaryInput();
    /** Smaller minimum side → stronger zoom-in (slider fully right). Keep a floor for touch/export sanity. */
    return Math.max(coarse ? 48 : 32, Math.round(dim * 0.02));
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
      const snapped = clampSquareCropInImage(state.left, state.top, state.side, state.w, state.h, minSide);
      state.left = snapped.left;
      state.top = snapped.top;
      state.side = snapped.side;
      panLayoutFloat = null;
      cropState.set(key, state);
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
    cropState.set(key, state);
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
      if (vw <= 0 || !state.side) return;
      const contentScale = vw / state.side;
      const imgW = state.w * contentScale;
      const imgH = state.h * contentScale;
      img.style.width = `${imgW}px`;
      img.style.height = `${imgH}px`;
      const oxSrc = panLayoutFloat ? panLayoutFloat.left : state.left;
      const oySrc = panLayoutFloat ? panLayoutFloat.top : state.top;
      const ox = -oxSrc * contentScale;
      const oy = -oySrc * contentScale;
      /** translateZ(0) promotes the layer for smoother composited pans on mobile GPUs. */
      imageLayer.style.transform = `translate3d(${ox}px, ${oy}px, 0)`;
      if (layoutDirty) {
        layoutDirty = false;
        syncFixedViewportLayout();
      }
    });
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
  const cropViewportResizeObserver = new ResizeObserver(() => {
    syncFixedViewportLayout();
  });
  cropViewportResizeObserver.observe(viewport);
  cropUiSignal.addEventListener("abort", () => {
    try {
      cropViewportResizeObserver.disconnect();
    } catch {
      /* ignore */
    }
  });

  function blockImageChrome(ev) {
    ev.preventDefault();
  }
  img.addEventListener("contextmenu", blockImageChrome, { signal: cropUiSignal });
  img.addEventListener("dragstart", blockImageChrome, { signal: cropUiSignal });

  /** @type {Map<number, { x: number, y: number }>} */
  const activePtrs = new Map();
  let panAnchor = null;

  function onPointerDown(e) {
    e.preventDefault();
    activePtrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (activePtrs.size > 1) commitPendingPanLayout();
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
    const contentScale = vw / state.side;
    const dx = clientX - panAnchor.x;
    const dy = clientY - panAnchor.y;
    const minSide = minCropSide();
    const sq = clampSquareCropInImageFloat(
      panAnchor.left - dx / contentScale,
      panAnchor.top - dy / contentScale,
      state.side,
      state.w,
      state.h,
      minSide
    );
    panLayoutFloat = { left: sq.left, top: sq.top, side: sq.side };
    syncFixedViewportLayout();
  }

  function onPointerMove(e) {
    if (!activePtrs.has(e.pointerId)) return;
    activePtrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (activePtrs.size === 1 && panAnchor) {
      applyPan(e.clientX, e.clientY);
    }
  }

  function onPointerUpOrCancel(e) {
    activePtrs.delete(e.pointerId);
    if (activePtrs.size === 0) {
      commitPendingPanLayout();
      panAnchor = null;
    } else if (activePtrs.size === 1) {
      commitPendingPanLayout();
      const rem = activePtrs.entries().next().value;
      if (rem) {
        const p = rem[1];
        panAnchor = { x: p.x, y: p.y, left: state.left, top: state.top };
      }
    }
  }

  viewport.addEventListener("pointerdown", onPointerDown, { signal: cropUiSignal });
  viewport.addEventListener("pointermove", onPointerMove, { signal: cropUiSignal });
  viewport.addEventListener("pointerup", onPointerUpOrCancel, { signal: cropUiSignal });
  viewport.addEventListener("pointercancel", onPointerUpOrCancel, { signal: cropUiSignal });
  /** Passive on document — we do not cancel move; reduces scroll jank if the browser treats the chain as scrollable. */
  document.addEventListener("pointermove", onPointerMove, { signal: cropUiSignal, passive: true });
  document.addEventListener("pointerup", onPointerUpOrCancel, { signal: cropUiSignal, passive: true });
  document.addEventListener("pointercancel", onPointerUpOrCancel, { signal: cropUiSignal, passive: true });

  cropUiSignal.addEventListener("abort", () => {
    layoutDirty = false;
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
    cropState.set(key, state);
    syncZoomSliderFromState();
    syncFixedViewportLayout();
  }

  attachBatchRowActions(row, file, { variant: "crop", showNextCheck, onResetSuggested: resetCropToSuggested });
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
  cropState.set(key, state);
}

async function runManualCropOnly(gen) {
  const total = workItems.length;
  for (let idx = 0; idx < total; idx++) {
    if (gen !== previewGeneration) return;
    if (shouldYieldBetweenBatchItems() && idx > 0) await new Promise((r) => setTimeout(r, 0));
    setProgress(true, ((idx + 1) / total) * 100, `${idx + 1} / ${total}…`);

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
    cropState.set(key, state);
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
  fileSummary.textContent = `Preparing · ${totalFiles} photo(s)`;
  clearError();
  for (let i = 0; i < workItems.length; i++) {
    analysisPendingKeys.add(fileCacheKey(workItems[i]));
  }
  syncCropReviewIndex();
  setProgress(true, 0, "Preparing…", { indeterminate: true });
  setCurrentPage("crop");
  renderCropEditorSlot();
  updateCropReviewChrome();
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
    showError(`Couldn’t start analysis: ${detail} Crop manually below.`, e);
    await runManualCropOnly(gen);
    finishPreviewBatch(gen, totalFiles, true);
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

  setProgress(true, total > 0 ? (1 / total) * 100 : 0, `1 / ${total}…`);
  await analyzeOneImage(workItems[workItems.length - 1], detModel, padFrac, minScore, gen);
  if (gen !== previewGeneration) return;

  if (!workItems.length) {
    setProgress(false, 0, "");
    fileSummary.textContent = "";
    setCurrentPage("setup");
    updateButtons();
    return;
  }

  openCropEditorAfterFirst(
    gen,
    total,
    total > 1 ? `1 / ${total} analyzed · more in background` : `${total} ready — review & ✓ each`
  );

  if (total > 1) {
    runRemainingAnalysisInBackground(gen, detModel, padFrac, minScore);
  }
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
  if (batchProgress) { batchProgress.hidden = true; batchProgress.textContent = ""; }
  if (cropExportBar) cropExportBar.hidden = true;
  lastShareInatFiles = [];
  lastShareInatSourceFiles = [];
  setProgress(false, 0, "");
  setZipDownloadProgress(false, 0, "", {});
  setCurrentPage("setup");
  updateButtons();
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
  if (batchProgress) { batchProgress.hidden = true; batchProgress.textContent = ""; }
  if (cropExportBar) cropExportBar.hidden = true;
  previewGeneration++;
  releaseBatchResources();
    try {
    workItems = await sortFilesByCapture(images);
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
  runAutoCrop().catch((e) => {
    console.error(e);
    showError("Processing failed. Retry.", e);
    setCurrentPage("setup");
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
        out.push(
          new File([prep.buffer], name, {
            type: prep.mime,
            lastModified: prep.meta.lastModified,
          })
        );
        sourceFiles.push(file);
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
 * Build JPEGs for the system share sheet before the user taps Share, so `navigator.share()` can run
 * in the same synchronous turn as the click (avoids NotAllowedError after async prep).
 */
function prepareShareSheetFilesInBackground() {
  if (!workItems.length || !isCropReviewFinished()) {
    shareSheetReadyFiles = null;
    sharePrepStatusText = "";
    shareSheetBuildIndex = 0;
    shareSheetBuildTotal = 0;
    return;
  }
  const gen = ++shareSheetPrepareGen;
  shareSheetReadyFiles = null;
  sharePrepStatusText = "";
  const n = workItems.length;
  shareSheetBuildIndex = 0;
  shareSheetBuildTotal = n;
  updateSharePrepUiDisplay();
  updateButtons();
  void (async () => {
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
      if (gen !== shareSheetPrepareGen) return;
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
      if (gen !== shareSheetPrepareGen) return;
      sharePrepStatusText = "";
      files = pickShareableImageFiles(files);
      shareSheetReadyFiles = files;
      if (gen === shareSheetPrepareGen) {
        shareSheetBuildIndex = shareSheetBuildTotal;
        updateButtons();
      }
    } catch (e) {
      console.error(e);
      if (gen === shareSheetPrepareGen) {
        shareSheetReadyFiles = [];
        sharePrepStatusText = "";
        updateButtons();
      }
    }
  })();
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
          outFile = new File([prep.buffer], name, {
            type: prep.mime,
            lastModified: prep.meta.lastModified,
          });
          shareAcc.files.push(outFile);
          shareAcc.sources.push(file);
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
    lastShareInatFiles = shareAcc.files;
    lastShareInatSourceFiles = shareAcc.sources;
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
    /**
     * ZIP start calls `invalidateShareSheetPrep()` — that aborts in-flight Share prep and leaves
     * `shareSheetReadyFiles === null`. Restart background prep so Share can enable again after ZIP.
     */
    if (
      pageExport &&
      !pageExport.hidden &&
      workItems.length > 0 &&
      isCropReviewFinished() &&
      typeof navigator.share === "function"
    ) {
      prepareShareSheetFilesInBackground();
    }
    updateButtons();
  }
}

btnCrop.addEventListener("click", () => {
  void runZipDownload();
});

if (btnShareInat) {
  btnShareInat.addEventListener("click", () => {
    if (!workItems.length) return;
    if (typeof navigator.share !== "function") {
      showError("Sharing unavailable. Use Download ZIP.");
      return;
    }
    clearError();
    /** Must call `navigator.share` synchronously from this gesture — async prep first causes NotAllowedError. */
    if (shareSheetReadyFiles === null) {
      showError("Still preparing images for share — try again in a moment, or use Download ZIP.");
      return;
    }
    const files = pickShareableImageFiles(shareSheetReadyFiles.slice());
    if (!files.length) {
      showError("Nothing to share. Use Download ZIP.");
      return;
    }
    const sharePromise =
      isIOSOrIPadOS()
        ? navigator.share({ files })
        : navigator.share({
            files,
            title: "Share",
            text: "JPEGs only · pick app in sheet",
          });
    void sharePromise
      .catch((e) => {
        if (e && e.name === "AbortError") return;
        const msg = e && typeof e === "object" && "message" in e ? String(e.message) : String(e);
        showError(`Share failed: ${msg} Use Download ZIP.`);
      })
      .finally(() => {
        updateButtons();
      });
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

void tryRestoreSessionFromIdb().then((restored) => {
  if (!restored) {
    setCurrentPage("setup");
    updateButtons();
  }
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
