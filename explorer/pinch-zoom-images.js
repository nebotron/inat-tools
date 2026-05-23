const MIN_SCALE = 1;
const MAX_SCALE = 4;
const PAN_SLOP_PX = 8;

/** One wrapper carries both pan + scale so math matches the real CSS composite (origin 0 0). */
const PINCH_VIEW_CLASS = "card-photo-pinch__view";

/** Leaflet adds this class to the map root; allow native two-finger map zoom there only. */
const LEAFLET_MAP_ROOT = ".leaflet-container";

let documentZoomGuardsInstalled = false;

function clampScale(s) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}

/**
 * Viewport meta alone does not stop desktop pinch (Ctrl/trackpad wheel), Safari page pinch,
 * or keyboard zoom shortcuts. Block those at the document while still allowing Leaflet map pinch
 * and our image handlers.
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

  const zoomKeyTargetIsEditable = (t) => {
    if (!(t instanceof Element)) return false;
    if (t.isContentEditable) return true;
    const tag = (t.tagName || "").toLowerCase();
    return tag === "input" || tag === "textarea" || tag === "select" || tag === "button";
  };

  /** Chromium / Firefox: trackpad pinch and Ctrl+wheel use ctrlKey on wheel events. */
  const onWindowWheelCapture = (e) => {
    if (e.ctrlKey || e.metaKey) e.preventDefault();
  };
  window.addEventListener("wheel", onWindowWheelCapture, { passive: false, capture: true });

  /** Block Ctrl/Cmd +/-/0 page zoom (still allow in editable fields). */
  const onWindowKeyDownCapture = (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (zoomKeyTargetIsEditable(e.target)) return;
    const k = e.key;
    const code = e.code;
    if (
      k === "=" ||
      k === "+" ||
      k === "-" ||
      k === "0" ||
      code === "NumpadAdd" ||
      code === "NumpadSubtract" ||
      code === "NumpadEqual" ||
      code === "Numpad0" ||
      code === "Minus" ||
      code === "Equal" ||
      code === "Digit0"
    ) {
      e.preventDefault();
    }
  };
  window.addEventListener("keydown", onWindowKeyDownCapture, { capture: true });

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

/** @param {HTMLElement} viewEl */
function readViewTransform(viewEl) {
  let tx = 0;
  let ty = 0;
  let s = 1;
  const t = viewEl.style.transform;
  if (t && t !== "none") {
    const tm = t.match(/translate\(\s*([-0-9.eE+]+)px\s*,\s*([-0-9.eE+]+)px\s*\)/);
    if (tm) {
      tx = Number(tm[1]);
      ty = Number(tm[2]);
      if (!Number.isFinite(tx)) tx = 0;
      if (!Number.isFinite(ty)) ty = 0;
    }
    const sm = t.match(/scale\(\s*([-0-9.eE+]+)\s*\)/);
    if (sm) {
      const sv = Number(sm[1]);
      if (Number.isFinite(sv)) s = clampScale(sv);
    }
  }
  return { tx, ty, s };
}

/** Lets CSS set touch-action:none on the photo subtree so the observations panel does not steal drags. */
function syncPhotoShellZoomedState(viewEl) {
  const shell = viewEl.closest("[data-explorer-pinch-zoom]");
  if (!(shell instanceof HTMLElement)) return;
  if (readViewTransform(viewEl).s > 1) shell.setAttribute("data-explorer-photo-zoomed", "1");
  else shell.removeAttribute("data-explorer-photo-zoomed");
}

/**
 * @param {Element | null} shellEl
 * @param {HTMLElement} viewEl
 * @param {number} tx
 * @param {number} ty
 * @param {number} s
 * @param {{ skipReclamp?: boolean }} [opts]
 */
function writeViewTransform(shellEl, viewEl, tx, ty, s, opts) {
  const skipReclamp = Boolean(opts && opts.skipReclamp);
  const sc = clampScale(s);
  if (sc <= MIN_SCALE + 1e-6) {
    viewEl.style.transform = "";
    syncPhotoShellZoomedState(viewEl);
    return;
  }
  let x = tx;
  let y = ty;
  if (!skipReclamp && shellEl instanceof Element) {
    const rect = shellEl.getBoundingClientRect();
    const w = shellEl.clientWidth || rect.width || 1;
    const h = shellEl.clientHeight || rect.height || 1;
    const maxX = ((sc - 1) * w) / 2;
    const maxY = ((sc - 1) * h) / 2;
    x = Math.min(maxX, Math.max(-maxX, tx));
    y = Math.min(maxY, Math.max(-maxY, ty));
  }
  viewEl.style.transform = `translate(${x}px, ${y}px) scale(${sc})`;
  syncPhotoShellZoomedState(viewEl);
}

/** @param {Element | null} shellEl @param {HTMLElement} viewEl */
function reclampView(shellEl, viewEl) {
  const { tx, ty, s } = readViewTransform(viewEl);
  writeViewTransform(shellEl, viewEl, tx, ty, s, {});
}

function distance(x1, y1, x2, y2) {
  return Math.hypot(x2 - x1, y2 - y1);
}

/** @param {Element} shellEl */
function shellLocalFromClient(shellEl, clientX, clientY) {
  const r = shellEl.getBoundingClientRect();
  return { x: clientX - r.left, y: clientY - r.top };
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
 * then wires application-level zoom for `[data-explorer-pinch-zoom]` (two-finger focal pinch,
 * Ctrl/Cmd+wheel, single-touch pan via capture TouchEvents, and mouse/pen pointer pan while zoomed).
 * @param {ParentNode | null | undefined} root
 */
export function installExplorerImagePinchZoom(root) {
  installExplorerDocumentZoomGuards();
  if (!root) return;

  /** @type {Map<number, { clientX: number, clientY: number, shell: Element }>} */
  const pointers = new Map();

  let pinchShell = null;
  /** @type {HTMLElement | null} */
  let pinchView = null;
  let startDist = 1;
  let startScale = 1;

  /** @type {{
   *   phase: "candidate" | "dragging",
   *   shell: Element,
   *   viewEl: HTMLElement,
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
   *   viewEl: HTMLElement,
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
    if (pinchShell && pinchView) reclampView(pinchShell, pinchView);
    pinchShell = null;
    pinchView = null;
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
    const view = shellA.querySelector(`.${PINCH_VIEW_CLASS}`);
    if (!(view instanceof HTMLElement)) return;
    const d = distance(entries[0].clientX, entries[0].clientY, entries[1].clientX, entries[1].clientY);
    if (d < 12) return;
    pinchShell = shellA;
    pinchView = view;
    startDist = d;
    startScale = readViewTransform(view).s;
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

    const viewEl = shell.querySelector(`.${PINCH_VIEW_CLASS}`);
    if (!(viewEl instanceof HTMLElement)) return;
    if (readViewTransform(viewEl).s <= 1) return;
    if (panStartBlocked(e.target)) return;

    const { tx: tx0, ty: ty0 } = readViewTransform(viewEl);
    imagePan = {
      phase: "candidate",
      shell,
      viewEl,
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
      } else if (readViewTransform(imagePan.viewEl).s > 1) {
        /* Stop the scrollable panel (and browser) from treating this as a scroll gesture. */
        e.preventDefault();
        if (imagePan.phase === "candidate") {
          const dist = distance(e.clientX, e.clientY, imagePan.x0, imagePan.y0);
          if (dist >= PAN_SLOP_PX) imagePan.phase = "dragging";
        }
        if (imagePan && imagePan.phase === "dragging") {
          const tx = imagePan.tx0 + (e.clientX - imagePan.x0);
          const ty = imagePan.ty0 + (e.clientY - imagePan.y0);
          const { s } = readViewTransform(imagePan.viewEl);
          writeViewTransform(shell, imagePan.viewEl, tx, ty, s, {});
        }
      }
    }

    if (!pinchView || !pinchShell || pointers.size < 2) return;
    const pair = [...pointers.values()].filter((p) => p.shell === pinchShell);
    if (pair.length < 2) return;
    const d = distance(pair[0].clientX, pair[0].clientY, pair[1].clientX, pair[1].clientY);
    if (d > 4 && startDist > 4) {
      e.preventDefault();
      const sNew = clampScale(startScale * (d / startDist));
      const { tx: txOld, ty: tyOld, s: sOld } = readViewTransform(pinchView);
      if (sOld < 1e-6) return;
      const pa = shellLocalFromClient(pinchShell, pair[0].clientX, pair[0].clientY);
      const pb = shellLocalFromClient(pinchShell, pair[1].clientX, pair[1].clientY);
      const mx = (pa.x + pb.x) / 2;
      const my = (pa.y + pb.y) / 2;
      /* Shell-local content coords (scale about 0,0 then translate): mx = tx + s * u  =>  u = (mx - tx) / s */
      const u = (mx - txOld) / sOld;
      const v = (my - tyOld) / sOld;
      const txNew = mx - u * sNew;
      const tyNew = my - v * sNew;
      writeViewTransform(pinchShell, pinchView, txNew, tyNew, sNew, { skipReclamp: true });
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
    const viewEl = shell.querySelector(`.${PINCH_VIEW_CLASS}`);
    if (!(viewEl instanceof HTMLElement)) return;
    const factor = e.deltaY < 0 ? 1.08 : 1 / 1.08;
    const { tx, ty, s } = readViewTransform(viewEl);
    writeViewTransform(shell, viewEl, tx, ty, s * factor, {});
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
    const viewEl = shell.querySelector(`.${PINCH_VIEW_CLASS}`);
    if (!(viewEl instanceof HTMLElement)) return;
    if (readViewTransform(viewEl).s <= 1) return;
    const tr = readViewTransform(viewEl);
    touchPan = {
      phase: "candidate",
      shell,
      viewEl,
      id: t.identifier,
      x0: t.clientX,
      y0: t.clientY,
      tx0: tr.tx,
      ty0: tr.ty,
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
    if (readViewTransform(touchPan.viewEl).s <= 1) {
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
      const { s } = readViewTransform(touchPan.viewEl);
      writeViewTransform(touchPan.shell, touchPan.viewEl, tx, ty, s, {});
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
