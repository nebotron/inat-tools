const MIN_SCALE = 1;
const MAX_SCALE = 4;
const PAN_SLOP_PX = 8;

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

/** @param {HTMLElement} scaleEl */
function readScale(scaleEl) {
  const t = scaleEl.style.transform;
  if (!t || t === "none") return 1;
  const m = t.match(/scale\(\s*([\d.]+)\s*\)/);
  if (!m) return 1;
  const s = Number(m[1]);
  return Number.isFinite(s) ? Math.min(MAX_SCALE, Math.max(MIN_SCALE, s)) : 1;
}

/** Lets CSS set touch-action:none on the photo subtree so the observations panel does not steal drags. */
function syncPhotoShellZoomedState(scaleEl) {
  const shell = scaleEl.closest("[data-explorer-pinch-zoom]");
  if (!(shell instanceof HTMLElement)) return;
  if (readScale(scaleEl) > 1) shell.setAttribute("data-explorer-photo-zoomed", "1");
  else shell.removeAttribute("data-explorer-photo-zoomed");
}

/** @param {HTMLElement} scaleEl */
function writeScale(scaleEl, scale) {
  const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
  scaleEl.style.transform = s <= MIN_SCALE + 1e-6 ? "" : `scale(${s})`;
  const panEl = scaleEl.parentElement;
  if (panEl instanceof HTMLElement && panEl.classList.contains("card-photo-pinch__pan")) {
    if (s <= MIN_SCALE + 1e-6) panEl.style.transform = "";
    else reclampPan(scaleEl.closest("[data-explorer-pinch-zoom]"), panEl, scaleEl);
  }
  syncPhotoShellZoomedState(scaleEl);
}

/** @param {HTMLElement} panEl */
function readTranslate(panEl) {
  const t = panEl.style.transform;
  if (!t || t === "none") return { x: 0, y: 0 };
  const m = t.match(/translate\(\s*([-0-9.]+)px\s*,\s*([-0-9.]+)px\s*\)/);
  if (!m) return { x: 0, y: 0 };
  const x = Number(m[1]);
  const y = Number(m[2]);
  return {
    x: Number.isFinite(x) ? x : 0,
    y: Number.isFinite(y) ? y : 0,
  };
}

/**
 * @param {Element | null} shellEl
 * @param {HTMLElement} panEl
 * @param {HTMLElement} scaleEl
 * @param {number} tx
 * @param {number} ty
 */
function writeTranslateClamped(shellEl, panEl, scaleEl, tx, ty) {
  if (!(shellEl instanceof Element)) return;
  const s = readScale(scaleEl);
  if (s <= 1) {
    panEl.style.transform = "";
    syncPhotoShellZoomedState(scaleEl);
    return;
  }
  const rect = shellEl.getBoundingClientRect();
  const w = shellEl.clientWidth || rect.width || 1;
  const h = shellEl.clientHeight || rect.height || 1;
  const maxX = ((s - 1) * w) / 2;
  const maxY = ((s - 1) * h) / 2;
  const x = Math.min(maxX, Math.max(-maxX, tx));
  const y = Math.min(maxY, Math.max(-maxY, ty));
  panEl.style.transform = x === 0 && y === 0 ? "" : `translate(${x}px, ${y}px)`;
  syncPhotoShellZoomedState(scaleEl);
}

/** @param {Element | null} shellEl */
function reclampPan(shellEl, panEl, scaleEl) {
  const { x, y } = readTranslate(panEl);
  writeTranslateClamped(shellEl, panEl, scaleEl, x, y);
}

function distance(x1, y1, x2, y2) {
  return Math.hypot(x2 - x1, y2 - y1);
}

/**
 * @param {Map<number, { shell: Element }>} pointers
 * @param {Element} shell
 */
function pinchTouchCountForShell(pointers, shell) {
  let n = 0;
  for (const p of pointers.values()) {
    if (p.shell === shell) n += 1;
  }
  return n;
}

/**
 * Blocks browser-level zoom (viewport meta is not enough on desktop / some mobile engines),
 * then wires application-level zoom for `[data-explorer-pinch-zoom]` (touch pinch, Ctrl/Cmd+wheel,
 * single-touch pan via capture TouchEvents, and mouse/pen pointer pan while zoomed).
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

  /** @type {{
   *   phase: "candidate" | "dragging",
   *   shell: Element,
   *   panEl: HTMLElement,
   *   scaleEl: HTMLElement,
   *   pointerId: number,
   *   x0: number,
   *   y0: number,
   *   tx0: number,
   *   ty0: number,
   * } | null} */
  let imagePan = null;

  /** Touch pan (iOS / WebKit): single-finger drag uses TouchEvents + capture; pointer pan is mouse/pen only. */
  /** @type {{
   *   phase: "candidate" | "dragging",
   *   shell: Element,
   *   panEl: HTMLElement,
   *   scaleEl: HTMLElement,
   *   id: number,
   *   x0: number,
   *   y0: number,
   *   tx0: number,
   *   ty0: number,
   * } | null} */
  let touchPan = null;

  const clearTouchPan = () => {
    touchPan = null;
  };

  const clearTouchPanForShell = (shell) => {
    if (touchPan && touchPan.shell === shell) clearTouchPan();
  };

  const endPinchTracking = () => {
    pinchShell = null;
    pinchInner = null;
    startDist = 1;
    startScale = 1;
  };

  const clearImagePan = () => {
    if (imagePan) {
      try {
        imagePan.shell.releasePointerCapture(imagePan.pointerId);
      } catch {
        /* ignore */
      }
    }
    imagePan = null;
  };

  const clearImagePanForShell = (shell) => {
    if (imagePan && imagePan.shell === shell) clearImagePan();
  };

  const tryBeginPinch = () => {
    if (pointers.size !== 2) return;
    const entries = [...pointers.values()];
    const shellA = entries[0].shell;
    const shellB = entries[1].shell;
    if (shellA !== shellB) return;
    clearImagePanForShell(shellA);
    clearTouchPanForShell(shellA);
    const inner = shellA.querySelector(".card-photo-pinch__scale");
    if (!(inner instanceof HTMLElement)) return;
    const d = distance(entries[0].clientX, entries[0].clientY, entries[1].clientX, entries[1].clientY);
    if (d < 12) return;
    pinchShell = shellA;
    pinchInner = inner;
    startDist = d;
    startScale = readScale(inner);
  };

  const panStartBlocked = (target) => {
    if (!(target instanceof Element)) return true;
    if (target.closest("button.card-media-carousel__dot-slot")) return true;
    if (target.closest(".card-actions-upper-right")) return true;
    if (target.closest("a.card-photo-page-link")) return true;
    return false;
  };

  /** @param {PointerEvent} e */
  const onPointerDown = (e) => {
    const shell = e.target.closest("[data-explorer-pinch-zoom]");
    if (!(shell instanceof Element) || !root.contains(shell)) return;

    if (e.pointerType === "touch") {
      pointers.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY, shell });
      if (pinchTouchCountForShell(pointers, shell) >= 2) {
        clearImagePanForShell(shell);
        clearTouchPanForShell(shell);
      }
      tryBeginPinch();
      return;
    }

    const panEl = shell.querySelector(".card-photo-pinch__pan");
    const scaleEl = shell.querySelector(".card-photo-pinch__scale");
    if (!(panEl instanceof HTMLElement && scaleEl instanceof HTMLElement)) return;
    if (readScale(scaleEl) <= 1) return;
    if (panStartBlocked(e.target)) return;

    const { x: tx0, y: ty0 } = readTranslate(panEl);
    imagePan = {
      phase: "candidate",
      shell,
      panEl,
      scaleEl,
      pointerId: e.pointerId,
      x0: e.clientX,
      y0: e.clientY,
      tx0,
      ty0,
    };
    try {
      shell.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  /** @param {PointerEvent} e */
  const onPointerMove = (e) => {
    const rec = pointers.get(e.pointerId);
    if (rec) {
      rec.clientX = e.clientX;
      rec.clientY = e.clientY;
    }

    if (imagePan && e.pointerId === imagePan.pointerId) {
      const shell = imagePan.shell;
      if (pinchTouchCountForShell(pointers, shell) >= 2) {
        clearImagePan();
        clearTouchPanForShell(shell);
      } else if (readScale(imagePan.scaleEl) > 1) {
        /* Stop the scrollable panel (and browser) from treating this as a scroll gesture. */
        e.preventDefault();
        if (imagePan.phase === "candidate") {
          const dist = distance(e.clientX, e.clientY, imagePan.x0, imagePan.y0);
          if (dist >= PAN_SLOP_PX) imagePan.phase = "dragging";
        }
        if (imagePan && imagePan.phase === "dragging") {
          const tx = imagePan.tx0 + (e.clientX - imagePan.x0);
          const ty = imagePan.ty0 + (e.clientY - imagePan.y0);
          writeTranslateClamped(shell, imagePan.panEl, imagePan.scaleEl, tx, ty);
        }
      }
    }

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

    if (imagePan && imagePan.pointerId === e.pointerId) clearImagePan();
  };

  /** @param {PointerEvent} e */
  const onPointerCancel = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) endPinchTracking();
    if (imagePan && imagePan.pointerId === e.pointerId) clearImagePan();
  };

  /** @param {WheelEvent} e */
  const onWheel = (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    const shell = e.target.closest("[data-explorer-pinch-zoom]");
    if (!(shell instanceof Element) || !root.contains(shell)) return;
    e.preventDefault();
    const scaleEl = shell.querySelector(".card-photo-pinch__scale");
    const panEl = shell.querySelector(".card-photo-pinch__pan");
    if (!(scaleEl instanceof HTMLElement)) return;
    const factor = e.deltaY < 0 ? 1.08 : 1 / 1.08;
    writeScale(scaleEl, readScale(scaleEl) * factor);
    if (panEl instanceof HTMLElement) reclampPan(shell, panEl, scaleEl);
  };

  /** @param {TouchEvent} e */
  const onDocTouchStart = (e) => {
    if (e.touches.length !== 1) {
      touchPan = null;
      return;
    }
    const t = e.touches[0];
    const shell = t.target.closest("[data-explorer-pinch-zoom]");
    if (!(shell instanceof Element) || !root.contains(shell)) return;
    if (shell.getAttribute("data-explorer-photo-zoomed") !== "1") return;
    if (panStartBlocked(t.target)) return;
    const panEl = shell.querySelector(".card-photo-pinch__pan");
    const scaleEl = shell.querySelector(".card-photo-pinch__scale");
    if (!(panEl instanceof HTMLElement && scaleEl instanceof HTMLElement)) return;
    if (readScale(scaleEl) <= 1) return;
    const tr = readTranslate(panEl);
    touchPan = {
      phase: "candidate",
      shell,
      panEl,
      scaleEl,
      id: t.identifier,
      x0: t.clientX,
      y0: t.clientY,
      tx0: tr.x,
      ty0: tr.y,
    };
  };

  /** @param {TouchEvent} e */
  const onDocTouchMove = (e) => {
    if (!touchPan) return;
    if (e.touches.length !== 1) {
      touchPan = null;
      return;
    }
    const t = [...e.touches].find((x) => x.identifier === touchPan.id);
    if (!t) return;
    if (!(touchPan.shell instanceof Element) || !root.contains(touchPan.shell)) {
      clearTouchPan();
      return;
    }
    if (readScale(touchPan.scaleEl) <= 1) {
      clearTouchPan();
      return;
    }
    e.preventDefault();
    if (touchPan.phase === "candidate") {
      if (distance(t.clientX, t.clientY, touchPan.x0, touchPan.y0) >= PAN_SLOP_PX) touchPan.phase = "dragging";
    }
    if (touchPan && touchPan.phase === "dragging") {
      const tx = touchPan.tx0 + (t.clientX - touchPan.x0);
      const ty = touchPan.ty0 + (t.clientY - touchPan.y0);
      writeTranslateClamped(touchPan.shell, touchPan.panEl, touchPan.scaleEl, tx, ty);
    }
  };

  /** @param {TouchEvent} e */
  const onDocTouchEndOrCancel = (e) => {
    if (!touchPan) return;
    if (![...e.changedTouches].some((ct) => ct.identifier === touchPan.id)) return;
    clearTouchPan();
  };

  root.addEventListener("pointerdown", onPointerDown);
  root.addEventListener("pointermove", onPointerMove, { passive: false });
  root.addEventListener("pointerup", onPointerUp);
  root.addEventListener("pointercancel", onPointerCancel);
  root.addEventListener("wheel", onWheel, { passive: false });

  document.addEventListener("touchstart", onDocTouchStart, { passive: true, capture: true });
  document.addEventListener("touchmove", onDocTouchMove, { passive: false, capture: true });
  document.addEventListener("touchend", onDocTouchEndOrCancel, { passive: true, capture: true });
  document.addEventListener("touchcancel", onDocTouchEndOrCancel, { passive: true, capture: true });
}
