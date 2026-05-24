import { installExplorerDocumentZoomGuards } from "./pinch-zoom-images.js";

const MIN_SCALE = 1;
const MAX_SCALE = 4;
const PAN_SLOP_PX = 8;
const VIEW_CLASS = "explorer-photo-lightbox__view";

function clampScale(s) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
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
    return;
  }
  let x = tx;
  let y = ty;
  if (!skipReclamp && shellEl instanceof Element) {
    const rect = shellEl.getBoundingClientRect();
    const w = shellEl.clientWidth || rect.width || 1;
    const h = shellEl.clientHeight || rect.height || 1;
    /* translate(tx,ty) scale(s) with origin 0,0: scaled box spans [tx, tx+s*w] × [ty, ty+s*h] in shell coords.
       Viewport is [0,w]×[0,h]. Avoid empty margin: tx ∈ [w - s*w, 0], ty ∈ [h - s*h, 0] (not symmetric ±). */
    const txMax = 0;
    const txMin = w - sc * w;
    const tyMax = 0;
    const tyMin = h - sc * h;
    x = Math.min(txMax, Math.max(txMin, tx));
    y = Math.min(tyMax, Math.max(tyMin, ty));
  }
  viewEl.style.transform = `translate(${x}px, ${y}px) scale(${sc})`;
}

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

function pinchTouchCountForShell(pointers, shell) {
  let n = 0;
  for (const p of pointers.values()) {
    if (p.shell === shell) n += 1;
  }
  return n;
}

/**
 * Tap `img.card-photo[data-explorer-lightbox-src]` opens fullscreen uncropped photo with pinch / wheel zoom and pan.
 * @param {ParentNode | null | undefined} root
 */
export function installExplorerPhotoLightbox(root) {
  installExplorerDocumentZoomGuards();

  const lb = document.createElement("div");
  lb.className = "explorer-photo-lightbox";
  lb.setAttribute("role", "dialog");
  lb.setAttribute("aria-modal", "true");
  lb.setAttribute("aria-label", "Photo");
  lb.hidden = true;
  lb.innerHTML = `
    <button type="button" class="explorer-photo-lightbox__close" aria-label="Close">&times;</button>
    <div class="explorer-photo-lightbox__stage">
      <div class="${VIEW_CLASS}">
        <img class="explorer-photo-lightbox__img" alt="" />
      </div>
    </div>
  `;
  document.body.appendChild(lb);

  const btnClose = lb.querySelector(".explorer-photo-lightbox__close");
  const stage = lb.querySelector(".explorer-photo-lightbox__stage");
  const viewEl = lb.querySelector(`.${VIEW_CLASS}`);
  const imgEl = lb.querySelector(".explorer-photo-lightbox__img");
  if (!(btnClose instanceof HTMLButtonElement && stage instanceof HTMLElement && viewEl instanceof HTMLElement && imgEl instanceof HTMLImageElement)) {
    return;
  }

  let bodyPrevOverflow = "";

  /** @type {Map<number, { clientX: number, clientY: number, shell: Element }>} */
  const pointers = new Map();
  let pinchShell = null;
  /** @type {HTMLElement | null} */
  let pinchView = null;
  let startDist = 1;
  let startScale = 1;

  /** @type {{ pointerId: number, x0: number, y0: number, tx0: number, ty0: number, phase: "candidate" | "dragging" } | null} */
  let imagePan = null;

  /** @type {{ id: number, x0: number, y0: number, tx0: number, ty0: number, phase: "candidate" | "dragging" } | null} */
  let touchPan = null;

  const isOpen = () => !lb.hidden;

  const resetView = () => {
    viewEl.style.transform = "";
  };

  const close = () => {
    if (!isOpen()) return;
    lb.hidden = true;
    document.body.style.overflow = bodyPrevOverflow;
    pointers.clear();
    pinchShell = null;
    pinchView = null;
    imagePan = null;
    touchPan = null;
    imgEl.removeAttribute("src");
    resetView();
  };

  const open = (url) => {
    const u = typeof url === "string" ? url.trim() : "";
    if (!u) return;
    resetView();
    imgEl.alt = "Observation photo";
    imgEl.src = u;
    lb.hidden = false;
    bodyPrevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    try {
      btnClose.focus();
    } catch {
      /* ignore */
    }
  };

  const endPinchTracking = () => {
    if (pinchShell && pinchView) reclampView(pinchShell, pinchView);
    pinchShell = null;
    pinchView = null;
    startDist = 1;
    startScale = 1;
  };

  const tryBeginPinch = () => {
    if (pointers.size !== 2) return;
    const entries = [...pointers.values()];
    if (entries[0].shell !== entries[1].shell) return;
    const shellA = entries[0].shell;
    if (shellA !== stage) return;
    if (touchPan) touchPan = null;
    if (imagePan) imagePan = null;
    const view = stage.querySelector(`.${VIEW_CLASS}`);
    if (!(view instanceof HTMLElement)) return;
    const d = distance(entries[0].clientX, entries[0].clientY, entries[1].clientX, entries[1].clientY);
    if (d < 12) return;
    pinchShell = stage;
    pinchView = view;
    startDist = d;
    startScale = readViewTransform(view).s;
  };

  /** @param {PointerEvent} e */
  const onStagePointerDown = (e) => {
    if (!isOpen()) return;
    if (e.pointerType === "touch") {
      pointers.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY, shell: stage });
      if (pinchTouchCountForShell(pointers, stage) >= 2) {
        imagePan = null;
        touchPan = null;
      }
      tryBeginPinch();
      return;
    }
    if (readViewTransform(viewEl).s <= 1) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const { tx, ty } = readViewTransform(viewEl);
    imagePan = {
      pointerId: e.pointerId,
      x0: e.clientX,
      y0: e.clientY,
      tx0: tx,
      ty0: ty,
      phase: "candidate",
    };
    try {
      stage.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  /** @param {PointerEvent} e */
  const onStagePointerMove = (e) => {
    if (!isOpen()) return;
    const rec = pointers.get(e.pointerId);
    if (rec) {
      rec.clientX = e.clientX;
      rec.clientY = e.clientY;
    }

    if (imagePan && e.pointerId === imagePan.pointerId) {
      if (pinchTouchCountForShell(pointers, stage) >= 2) {
        imagePan = null;
      } else if (readViewTransform(viewEl).s > 1) {
        e.preventDefault();
        if (imagePan.phase === "candidate") {
          if (distance(e.clientX, e.clientY, imagePan.x0, imagePan.y0) >= PAN_SLOP_PX) imagePan.phase = "dragging";
        }
        if (imagePan && imagePan.phase === "dragging") {
          const tx = imagePan.tx0 + (e.clientX - imagePan.x0);
          const ty = imagePan.ty0 + (e.clientY - imagePan.y0);
          const { s } = readViewTransform(viewEl);
          writeViewTransform(stage, viewEl, tx, ty, s, {});
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
      const u = (mx - txOld) / sOld;
      const v = (my - tyOld) / sOld;
      const txNew = mx - u * sNew;
      const tyNew = my - v * sNew;
      writeViewTransform(pinchShell, pinchView, txNew, tyNew, sNew, { skipReclamp: true });
    }
  };

  /** @param {PointerEvent} e */
  const onStagePointerUp = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) endPinchTracking();
    if (imagePan && imagePan.pointerId === e.pointerId) {
      try {
        stage.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      imagePan = null;
    }
  };

  /** @param {WheelEvent} e */
  const onStageWheel = (e) => {
    if (!isOpen()) return;
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    e.stopPropagation();
    const factor = e.deltaY < 0 ? 1.08 : 1 / 1.08;
    const { tx, ty, s } = readViewTransform(viewEl);
    writeViewTransform(stage, viewEl, tx, ty, s * factor, {});
  };

  stage.addEventListener("pointerdown", onStagePointerDown);
  stage.addEventListener("pointermove", onStagePointerMove, { passive: false });
  stage.addEventListener("pointerup", onStagePointerUp);
  stage.addEventListener("pointercancel", onStagePointerUp);
  stage.addEventListener("wheel", onStageWheel, { passive: false });

  /** @param {TouchEvent} e */
  const onDocTouchStart = (e) => {
    if (!isOpen()) return;
    if (e.touches.length !== 1) {
      touchPan = null;
      return;
    }
    const t = e.touches[0];
    if (!stage.contains(t.target)) return;
    if (readViewTransform(viewEl).s <= 1) return;
    const tr = readViewTransform(viewEl);
    touchPan = {
      id: t.identifier,
      x0: t.clientX,
      y0: t.clientY,
      tx0: tr.tx,
      ty0: tr.ty,
      phase: "candidate",
    };
  };

  /** @param {TouchEvent} e */
  const onDocTouchMove = (e) => {
    if (!isOpen() || !touchPan) return;
    if (e.touches.length !== 1) {
      touchPan = null;
      return;
    }
    const t = [...e.touches].find((x) => x.identifier === touchPan.id);
    if (!t) return;
    if (readViewTransform(viewEl).s <= 1) {
      touchPan = null;
      return;
    }
    e.preventDefault();
    if (touchPan.phase === "candidate") {
      if (distance(t.clientX, t.clientY, touchPan.x0, touchPan.y0) >= PAN_SLOP_PX) touchPan.phase = "dragging";
    }
    if (touchPan && touchPan.phase === "dragging") {
      const tx = touchPan.tx0 + (t.clientX - touchPan.x0);
      const ty = touchPan.ty0 + (t.clientY - touchPan.y0);
      const { s } = readViewTransform(viewEl);
      writeViewTransform(stage, viewEl, tx, ty, s, {});
    }
  };

  const onDocTouchEnd = (e) => {
    if (!touchPan) return;
    if (![...e.changedTouches].some((ct) => ct.identifier === touchPan.id)) return;
    touchPan = null;
  };

  document.addEventListener("touchstart", onDocTouchStart, { passive: true, capture: true });
  document.addEventListener("touchmove", onDocTouchMove, { passive: false, capture: true });
  document.addEventListener("touchend", onDocTouchEnd, { passive: true, capture: true });
  document.addEventListener("touchcancel", onDocTouchEnd, { passive: true, capture: true });

  btnClose.addEventListener("click", (e) => {
    e.preventDefault();
    close();
  });

  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape" && isOpen()) close();
    },
    true
  );

  if (root) {
    root.addEventListener(
      "click",
      (e) => {
        const t = e.target;
        if (!(t instanceof Element)) return;
        const hit = t.closest("img.card-photo[data-explorer-lightbox-src]");
        if (!(hit instanceof HTMLImageElement) || !root.contains(hit)) return;
        e.preventDefault();
        e.stopPropagation();
        const url = hit.getAttribute("data-explorer-lightbox-src");
        if (url && url.trim()) open(url.trim());
      },
      true
    );
  }
}
