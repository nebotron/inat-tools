/** Leaflet adds this class to the map root; allow native two-finger map zoom there only. */
const LEAFLET_MAP_ROOT = ".leaflet-container";

let documentZoomGuardsInstalled = false;

/**
 * Viewport meta alone does not stop desktop pinch (Ctrl/trackpad wheel), Safari page pinch,
 * or keyboard zoom shortcuts. Block those at the document while still allowing Leaflet map pinch.
 */
export function installExplorerDocumentZoomGuards() {
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
