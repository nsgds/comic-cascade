// The SCROLL <-> ZOOM state machine and zoom overlay.
//
// ZOOM is an overlay BESIDE the reader, never a transform on it: entering
// creates a `.zoom-layer` inside the reader root (the fullscreen element —
// anything outside it is invisible in fullscreen) holding one fresh <img> of
// the current page (same URL as the mounted page, so it's already cached),
// positioned to exactly cover the page's on-screen rect. The scroller is
// frozen with `overflow: hidden` — which preserves scrollTop/Left — and never
// otherwise touched: the virtualizer, layout and page detection know nothing
// about zoom, and exiting restores scrolling at the same page by construction.
//
// Input comes from gestures.js (which owns the Android 2-finger preventDefault
// hatch); geometry comes from zoom-math.js. The controller here only routes:
//   SCROLL: accumulate pinch-out; past the threshold -> enter at the focal
//           point (double-tap / double-click / "+" enter at a preset instead).
//   ZOOM:   pinch scales about the focal point, drags/plain-wheel pan, and
//           double-tap, Escape, "0", or pinching back to fit all exit.
// A pinch that starts on the scroller keeps streaming there through the
// SCROLL->ZOOM transition (touch pointers are implicitly captured by the
// element that saw pointerdown), so the scroller handlers delegate to the
// overlay handlers while active — the entering pinch never stutters.

import { attachGestures } from "./gestures.js";
import {
  EXIT_SCALE, cssTransform, initialState, maxScaleFor, panBy, presetScale,
  shouldExit, zoomAt,
} from "./zoom-math.js";

const KEY_STEP = 1.25;      // "+"/"-" zoom per press
const EXIT_ANIM_MS = 150;   // snap-back-to-fit animation

// deps: {rootEl, scroller, toolbar, getPage, settle?, onEnter?, onExit?}
//   getPage(cx, cy) -> {img, natural: {w,h}|null, src} for the page under the
//   gesture point (falling back to the current page), or null.
//   settle() -> synchronously finish any in-flight programmatic smooth scroll.
// Returns {active, exit, handleKey, destroy}.
export function createZoomController(deps) {
  const { rootEl, scroller, toolbar, getPage } = deps;
  let overlay = null;
  let img = null;
  let state = null;
  let rect = null;      // the page's fitted rect, relative to the viewport box
  let vb = null;        // the scroller's box at entry: {x, y, w, h}
  let maxScale = 3;
  let detachOverlay = null;
  let pending = 1;      // cumulative pinch factor while still in SCROLL

  const active = () => overlay !== null;
  const view = () => ({ w: vb.w, h: vb.h });

  function apply() {
    img.style.transform = cssTransform(state);
  }

  // `scale` null -> the double-tap/keyboard preset (decided once maxScale is known).
  function enterAt(cx, cy, scale) {
    if (active()) return;
    // If the BROWSER is viewport-zoomed (a11y force-zoom, or a pinch that beat
    // the reading-view viewport lock), every rect we'd measure is lying —
    // entering would anchor the overlay to phantom geometry. Stay in SCROLL.
    if (window.visualViewport && Math.abs(window.visualViewport.scale - 1) > 0.01) return;
    // A programmatic smooth scroll may still be gliding: settle it first, or
    // the rects below capture transient mid-animation geometry (and the glide
    // would finish invisibly under the frozen overlay).
    if (deps.settle) deps.settle();
    // Anchor to the page UNDER the gesture, not the viewport-center page — at a
    // page seam they routinely differ, and zooming the wrong one replaces what
    // the user tapped with the opaque overlay showing its neighbour.
    const page = getPage(cx, cy);
    if (!page || !page.img) return;
    const b = scroller.getBoundingClientRect();
    vb = { x: b.left, y: b.top, w: b.width, h: b.height };
    const r = page.img.getBoundingClientRect();
    rect = { x: r.left - vb.x, y: r.top - vb.y, w: r.width, h: r.height };
    if (!(rect.w > 0) || !(rect.h > 0) || !(vb.w > 0)) return;
    maxScale = maxScaleFor(page.natural && page.natural.w, rect.w);

    overlay = document.createElement("div");
    overlay.className = "zoom-layer";
    Object.assign(overlay.style, {
      left: `${vb.x}px`, top: `${vb.y}px`, width: `${vb.w}px`, height: `${vb.h}px`,
    });
    img = new Image();
    img.className = "zoom-img";
    img.decoding = "async";
    img.src = page.src; // same URL as the mounted page: immutable-cached, instant
    Object.assign(img.style, {
      left: `${rect.x}px`, top: `${rect.y}px`,
      width: `${rect.w}px`, height: `${rect.h}px`,
    });
    overlay.appendChild(img);
    // Stacking is z-index driven (see .zoom-layer in app.css): the mounted
    // pages are positioned elements, so DOM order alone cannot put the overlay
    // above them — device testing caught the zoom rendering BEHIND the frozen
    // page. z-55 sits over the pages and under the autohide toolbar (60).
    rootEl.insertBefore(overlay, toolbar);
    scroller.style.overflow = "hidden"; // freeze; scrollTop/Left are preserved

    state = zoomAt(initialState(), scale ?? presetScale(maxScale),
                   cx - vb.x, cy - vb.y, rect, view(), maxScale);
    apply();
    detachOverlay = attachGestures(overlay, overlayHandlers);
    if (deps.onEnter) deps.onEnter();
  }

  function exit(animate = true) {
    if (!active()) return;
    const ov = overlay;
    const im = img;
    if (detachOverlay) {
      detachOverlay();
      detachOverlay = null;
    }
    overlay = null;
    img = null;
    state = null;
    // The dying overlay must not shield the scroller while it animates out: its
    // listeners are already detached, so any event it swallowed (a flick, a
    // ctrl-wheel with nobody left to preventDefault it -> desktop browser
    // page-zoom) would just die. Let everything fall through immediately.
    ov.style.pointerEvents = "none";
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      ov.remove();
      // Un-freeze ONLY if no successor session started during the animation
      // window — a stale finish() restoring overflow under a live re-entered
      // zoom would leave the scroller scrollable beneath the overlay.
      if (!active()) {
        scroller.style.overflow = "";
        if (deps.onExit) deps.onExit();
      }
    };
    if (animate) {
      im.style.transition = `transform ${EXIT_ANIM_MS}ms ease-out`;
      im.style.transform = cssTransform(initialState()); // snap back to fit
      im.addEventListener("transitionend", finish, { once: true });
      setTimeout(finish, EXIT_ANIM_MS + 100); // fallback if transitionend is lost
    } else {
      finish();
    }
  }

  const overlayHandlers = {
    onPinch(g) {
      if (!active()) return;
      if (g.phase === "change") {
        state = zoomAt(state, g.factor, g.cx - vb.x, g.cy - vb.y, rect, view(), maxScale);
        apply();
      } else if (g.phase === "end" && shouldExit(state.scale)) {
        exit(); // pinched back to fit: click back into SCROLL
      }
    },
    onPan(p) {
      if (!active()) return;
      state = panBy(state, p.dx, p.dy, rect, view());
      apply();
    },
    onWheelPan(p) {
      overlayHandlers.onPan(p); // plain wheel pans exactly like a drag
    },
    onDoubleTap() {
      exit(); // the toggle back out
    },
  };

  const scrollHandlers = {
    onPinch(g) {
      if (active()) return overlayHandlers.onPinch(g); // the entering pinch continues
      if (g.phase === "start") {
        pending = 1;
      } else if (g.phase === "change") {
        pending *= g.factor;
        if (pending > EXIT_SCALE) {
          const p = pending;
          pending = 1;
          enterAt(g.cx, g.cy, p);
        }
      } else {
        pending = 1; // pinch-in (or ended sub-threshold) in SCROLL: nothing
      }
    },
    onPan(p) {
      if (active()) overlayHandlers.onPan(p); // entering pinch degraded to one finger
    },
    onDoubleTap(g) {
      if (!active()) enterAt(g.cx, g.cy, null);
    },
  };

  // Bare keys only (the reader's onKey already screens modifiers/typing).
  // Returns true when consumed. Arrow/page navigation is NOT consumed here:
  // goTo() exits zoom itself, so "arrows exit-then-navigate" falls out for free.
  function handleKey(key) {
    if (!active()) {
      if (key === "+" || key === "=") {
        const b = scroller.getBoundingClientRect();
        enterAt(b.left + b.width / 2, b.top + b.height / 2, null);
        return true;
      }
      return false;
    }
    switch (key) {
      case "Escape":
      case "0":
        exit();
        return true;
      case "+":
      case "=":
      case "-": {
        const factor = key === "-" ? 1 / KEY_STEP : KEY_STEP;
        // zoom about the box center — coords here are vb-relative, like rect
        state = zoomAt(state, factor, vb.w / 2, vb.h / 2, rect, view(), maxScale);
        apply();
        if (shouldExit(state.scale)) exit();
        return true;
      }
      default:
        return false;
    }
  }

  const detachScroller = attachGestures(scroller, scrollHandlers);

  return {
    active,
    exit,
    handleKey,
    destroy() {
      exit(false);
      detachScroller();
    },
  };
}
