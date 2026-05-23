const MIN_SCALE = 1;
const MAX_SCALE = 4;

/** Leaflet adds this class to the map root; allow native two-finger map zoom there only. */
const LEAFLET_MAP_ROOT = ".leaflet-container";

let documentZoomGuardsInstalled = false;

/**
 * Viewport meta alone does not stop desktop pinch (Ctrl/trackpad wheel) or Safari page pinch.
 * Block those at the document while still allowing Leaflet map pinch and our image handlers.
 */
function installExplorerDocumentZoomGuards() {
  if (documentZoomGuardsInstalled) return;
  documentZoomGuardsInstalled = true;

  const onLeafletMap = (node) => {
    if (!(node instanceof Element)) return false;
    try {
      return Boolean(node.closest(LEAFLET_MAP_ROOT));
    } catch {
      return false;
    }
  };

  /** Chromium / Firefox: trackpad pinch and Ctrl+wheel use ctrlKey on wheel events. */
  const onWindowWheelCapture = (e) => {
    if (e.ctrlKey || e.metaKey) e.preventDefault();
  };
  window.addEventListener("wheel", onWindowWheelCapture, { passive: false, capture: true });

  /** Mobile: block 2-finger viewport zoom unless both touches are on the map (Leaflet pinch). */
  const onTouchMoveCapture = (e) => {
    if (e.touches.length < 2) return;
    const allOnMap = Array.from(e.touches).every((t) => onLeafletMap(t.target));
    if (allOnMap) return;
    e.preventDefault();
  };
  document.addEventListener("touchmove", onTouchMoveCapture, { passive: false, capture: true });

  /** Safari (esp. macOS): page pinch uses non-standard gesture events. */
  if (typeof window.GestureEvent === "function") {
    const onGestureCapture = (e) => {
      const t = e.target;
      if (t instanceof Element && onLeafletMap(t)) return;
      e.preventDefault();
    };
    document.addEventListener("gesturestart", onGestureCapture, { passive: false, capture: true });
    document.addEventListener("gesturechange", onGestureCapture, { passive: false, capture: true });
    document.addEventListener("gestureend", onGestureCapture, { passive: false, capture: true });
  }
}

/** @param {HTMLElement} inner */
function readScale(inner) {
  const t = inner.style.transform;
  if (!t || t === "none") return 1;
  const m = t.match(/scale\(\s*([\d.]+)\s*\)/);
  if (!m) return 1;
  const s = Number(m[1]);
  return Number.isFinite(s) ? Math.min(MAX_SCALE, Math.max(MIN_SCALE, s)) : 1;
}

/** @param {HTMLElement} inner */
function writeScale(inner, scale) {
  const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
  inner.style.transform = s <= MIN_SCALE + 1e-6 ? "" : `scale(${s})`;
}

function distance(x1, y1, x2, y2) {
  return Math.hypot(x2 - x1, y2 - y1);
}

/**
 * Blocks browser-level zoom (viewport meta is not enough on desktop / some mobile engines),
 * then wires application-level zoom for `[data-explorer-pinch-zoom]` (touch pinch and Ctrl/Cmd+wheel).
 * @param {ParentNode | null | undefined} root
 */
export function installExplorerImagePinchZoom(root) {
  installExplorerDocumentZoomGuards();
  if (!root) return;

  /** @type {Map<number, { clientX: number, clientY: number, shell: Element }>} */
  const pointers = new Map();

  let pinchShell = null;
  /** @type {HTMLElement | null} */
  let pinchInner = null;
  let startDist = 1;
  let startScale = 1;

  const endPinchTracking = () => {
    pinchShell = null;
    pinchInner = null;
    startDist = 1;
    startScale = 1;
  };

  const tryBeginPinch = () => {
    if (pointers.size !== 2) return;
    const entries = [...pointers.values()];
    const shellA = entries[0].shell;
    const shellB = entries[1].shell;
    if (shellA !== shellB) return;
    const inner = shellA.querySelector(".card-photo-pinch__scale");
    if (!(inner instanceof HTMLElement)) return;
    const d = distance(entries[0].clientX, entries[0].clientY, entries[1].clientX, entries[1].clientY);
    if (d < 12) return;
    pinchShell = shellA;
    pinchInner = inner;
    startDist = d;
    startScale = readScale(inner);
  };

  /** @param {PointerEvent} e */
  const onPointerDown = (e) => {
    if (e.pointerType !== "touch") return;
    const shell = e.target.closest("[data-explorer-pinch-zoom]");
    if (!(shell instanceof Element) || !root.contains(shell)) return;
    pointers.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY, shell });
    tryBeginPinch();
  };

  /** @param {PointerEvent} e */
  const onPointerMove = (e) => {
    const rec = pointers.get(e.pointerId);
    if (!rec) return;
    rec.clientX = e.clientX;
    rec.clientY = e.clientY;
    if (!pinchInner || !pinchShell || pointers.size < 2) return;
    const pair = [...pointers.values()].filter((p) => p.shell === pinchShell);
    if (pair.length < 2) return;
    const d = distance(pair[0].clientX, pair[0].clientY, pair[1].clientX, pair[1].clientY);
    if (d > 4 && startDist > 4) {
      e.preventDefault();
      const next = startScale * (d / startDist);
      writeScale(pinchInner, next);
    }
  };

  /** @param {PointerEvent} e */
  const onPointerUp = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) endPinchTracking();
  };

  /** @param {PointerEvent} e */
  const onPointerCancel = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) endPinchTracking();
  };

  /** @param {WheelEvent} e */
  const onWheel = (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    const shell = e.target.closest("[data-explorer-pinch-zoom]");
    if (!(shell instanceof Element) || !root.contains(shell)) return;
    e.preventDefault();
    const inner = shell.querySelector(".card-photo-pinch__scale");
    if (!(inner instanceof HTMLElement)) return;
    const factor = e.deltaY < 0 ? 1.08 : 1 / 1.08;
    writeScale(inner, readScale(inner) * factor);
  };

  root.addEventListener("pointerdown", onPointerDown);
  root.addEventListener("pointermove", onPointerMove, { passive: false });
  root.addEventListener("pointerup", onPointerUp);
  root.addEventListener("pointercancel", onPointerCancel);
  root.addEventListener("wheel", onWheel, { passive: false });
}
