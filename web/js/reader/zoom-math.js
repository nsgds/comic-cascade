// Pure transform math for the pinch-zoom overlay (reader/zoom.js) — no DOM, so
// Node can pin every rule.
//
// Coordinate model: the overlay is laid out exactly over the page's FITTED rect
// (`rect` = {x, y, w, h} in viewport px — the never-upscaled layout size, so
// scale 1 IS fit scale). The transform state {scale, tx, ty} maps the overlay
// with origin at the rect's own top-left corner: the visible page rect is
//   x: rect.x + tx,  y: rect.y + ty,  w: rect.w * scale,  h: rect.h * scale
// which corresponds to CSS `translate(tx, ty) scale(scale)` with
// `transform-origin: 0 0` on an element positioned at (rect.x, rect.y).
//
// Every mutation returns a NEW state (no aliasing surprises across rAF frames),
// already pan-clamped — callers can render any state this module hands back.

// Below EXIT_SCALE the zoom "clicks back in" to plain scrolling.
export const EXIT_SCALE = 1.02;
// A page's max zoom: at least MIN_MAX_SCALE even for tiny pages, else up to the
// image's native 1:1 (fit often DOWNSCALES, so native can be far past 3×).
export const MIN_MAX_SCALE = 3;
// Trackpad pinch / ctrl-scroll: scale factor per wheel event (pixel deltaMode).
const WHEEL_K = 0.01;
// A single input event may not jump the scale more than 2× in either direction
// (a huge wheel delta or a glitchy pinch frame must not teleport the view).
const MAX_STEP = 2;

export function maxScaleFor(naturalW, fitW) {
  if (!(naturalW > 0) || !(fitW > 0)) return MIN_MAX_SCALE;
  return Math.max(MIN_MAX_SCALE, naturalW / fitW);
}

// Double-tap / double-click target: a decisive jump, but never past the cap.
export function presetScale(maxScale) {
  return Math.min(2, maxScale);
}

// true => leave ZOOM and hand the viewport back to native scroll.
export function shouldExit(scale) {
  return scale <= EXIT_SCALE;
}

// Wheel delta -> multiplicative zoom factor. Negative deltaY (pinch out /
// scroll up) zooms in. Clamped so one event can't teleport the scale.
export function wheelFactor(deltaY) {
  return clampStep(Math.exp(-deltaY * WHEEL_K));
}

export function clampStep(factor) {
  return Math.min(MAX_STEP, Math.max(1 / MAX_STEP, factor));
}

// Pan slack: on a covered axis the page may be dragged PAST flush by this
// fraction of the viewport, so a panel at the page's rim can be pulled toward
// the middle of the screen instead of staying pinned at the screen edge.
// Tune by feel; 0 restores hard edge-to-edge clamping.
export const PAN_SLACK_FRAC = 0.25;

// The slack TAPERS to zero as the scaled dimension approaches the viewport
// size: the covered branch's bounds then converge to the centered branch's
// single value, so zooming out across the crossing cannot teleport the page
// (a fixed slack allowed a one-frame jump of up to a quarter viewport).
export function slackFor(scaled, viewportDim) {
  return Math.min(viewportDim * PAN_SLACK_FRAC, Math.max(0, (scaled - viewportDim) / 2));
}

// Clamp a pan so the page can't be lost off-screen. Per axis: a page LARGER
// than the viewport pans to every corner and up to the (tapered) slack margin
// beyond it — never further, the page stays mostly on screen; a page SMALLER
// than the viewport is centered on that axis — it has nowhere sensible to go.
export function clampPan(state, rect, viewport) {
  const w = rect.w * state.scale;
  const h = rect.h * state.scale;
  let { tx, ty } = state;

  if (w >= viewport.w) {
    const m = slackFor(w, viewport.w);
    tx = Math.min(m - rect.x, Math.max(viewport.w - w - rect.x - m, tx));
  } else {
    tx = (viewport.w - w) / 2 - rect.x;
  }
  if (h >= viewport.h) {
    const m = slackFor(h, viewport.h);
    ty = Math.min(m - rect.y, Math.max(viewport.h - h - rect.y - m, ty));
  } else {
    ty = (viewport.h - h) / 2 - rect.y;
  }
  return { scale: state.scale, tx, ty };
}

// Focal-point-preserving zoom: the CONTENT under the viewport point (cx, cy)
// stays under it while the scale multiplies by `factor` (clamped to
// [1, maxScale], and to one MAX_STEP per call). scale 1 is fit — zooming out
// below it is the exit path (shouldExit), not a smaller rendering.
export function zoomAt(state, factor, cx, cy, rect, viewport, maxScale) {
  const target = state.scale * clampStep(factor);
  const scale = Math.min(maxScale, Math.max(1, target));
  const f = scale / state.scale;
  const tx = cx - rect.x - f * (cx - rect.x - state.tx);
  const ty = cy - rect.y - f * (cy - rect.y - state.ty);
  return clampPan({ scale, tx, ty }, rect, viewport);
}

export function panBy(state, dx, dy, rect, viewport) {
  return clampPan({ scale: state.scale, tx: state.tx + dx, ty: state.ty + dy }, rect, viewport);
}

// The identity state: overlay exactly covering the fitted rect.
export function initialState() {
  return { scale: 1, tx: 0, ty: 0 };
}

// Where the page actually is on screen for a given state (tests + hit-testing).
export function visibleRect(state, rect) {
  return {
    x: rect.x + state.tx,
    y: rect.y + state.ty,
    w: rect.w * state.scale,
    h: rect.h * state.scale,
  };
}

// The CSS for a state (element positioned at rect.x/rect.y, origin 0 0).
export function cssTransform(state) {
  return `translate(${state.tx}px, ${state.ty}px) scale(${state.scale})`;
}
