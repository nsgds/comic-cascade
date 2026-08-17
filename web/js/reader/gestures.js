// Unified gesture input for the zoom overlay (reader/zoom.js): one
// pinch/pan/tap stream from three sources — touch pointer events,
// trackpad/ctrl wheel, and double-click/double-tap. The pointer-tracking REDUCER is pure (no DOM) so
// Node can pin it; `attachGestures` is the thin DOM adapter around it.
//
// Device-verified input strategy (phase-0 spike, Android Chrome 151):
//  * `touch-action` alone does NOT hand a 2-finger gesture to the page —
//    Chrome pointercancels both pointers and keeps the pinch (even in
//    fullscreen, where it then does nothing with it). The working escape
//    hatch is a NON-PASSIVE touchstart/touchmove listener that calls
//    preventDefault() only while 2+ fingers are down: per-gesture, so
//    1-finger native scrolling is untouched, and pinches then stream cleanly.
//  * A pointercancel means the browser took the pointer (e.g. native scroll
//    handoff) — normal, not an error. Reset tracking for that pointer.
//  * A pinch needs two LIVE pointers: a 2nd finger landing after the 1st was
//    scroll-cancelled must not pair with a ghost.
//
// Emitted actions (from the reducer; the adapter forwards them to handlers):
//   {kind: "pinch-start", cx, cy}
//   {kind: "pinch-change", factor, cx, cy}   factor is per-event multiplicative
//   {kind: "pinch-end"}
//   {kind: "pan", dx, dy}                    single live pointer dragging
//   {kind: "none"}
// The consumer (zoom controller) decides what to honor in which mode — e.g.
// "pan" is meaningless in SCROLL (native scroll owns it) and honored in ZOOM.

import { wheelFactor } from "./zoom-math.js";

const NONE = { kind: "none" };

export function createTracker() {
  // pointers: insertion-ordered id -> {x, y}; the two OLDEST live pointers are
  // the pinch pair (extra fingers are ignored until one of the pair lifts).
  return { pointers: new Map(), pinching: false, lastDist: 0, lastPan: null };
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a, b) => ({ cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 });
const pair = (state) => [...state.pointers.values()].slice(0, 2);

// Feed one event ({type, id, x, y}); returns the action to emit. Mutates
// `state` in place (a tracker instance is private to one adapter).
export function trackEvent(state, ev) {
  const { pointers } = state;
  switch (ev.type) {
    case "down": {
      pointers.set(ev.id, { x: ev.x, y: ev.y });
      state.lastPan = pointers.size === 1 ? { x: ev.x, y: ev.y } : null;
      if (pointers.size === 2) {
        const [a, b] = pair(state);
        state.pinching = true;
        state.lastDist = dist(a, b);
        return { kind: "pinch-start", ...mid(a, b) };
      }
      return NONE;
    }
    case "move": {
      const p = pointers.get(ev.id);
      if (!p) return NONE; // cancelled or never seen — the browser owns it
      p.x = ev.x;
      p.y = ev.y;
      if (state.pinching) {
        const [a, b] = pair(state);
        if (![a, b].includes(p)) return NONE; // an extra (3rd+) finger moved
        const d = dist(a, b);
        if (!(state.lastDist > 0)) {
          state.lastDist = d; // fingers started coincident: re-anchor, no factor yet
          return NONE;
        }
        if (d <= 0) return NONE;
        const factor = d / state.lastDist;
        state.lastDist = d;
        return { kind: "pinch-change", factor, ...mid(a, b) };
      }
      if (pointers.size === 1 && state.lastPan) {
        const dx = ev.x - state.lastPan.x;
        const dy = ev.y - state.lastPan.y;
        state.lastPan = { x: ev.x, y: ev.y };
        if (dx === 0 && dy === 0) return NONE;
        return { kind: "pan", dx, dy };
      }
      return NONE;
    }
    case "up":
    case "cancel": {
      if (!pointers.delete(ev.id)) return NONE;
      if (state.pinching && pointers.size < 2) {
        state.pinching = false;
        state.lastDist = 0;
        // A survivor becomes a fresh pan anchor (no jump from the dead midpoint).
        const rest = [...pointers.values()];
        state.lastPan = rest.length === 1 ? { x: rest[0].x, y: rest[0].y } : null;
        return { kind: "pinch-end" };
      }
      if (state.pinching && pointers.size >= 2) {
        // One of 3+ fingers lifted but the pair survives (or re-forms from the
        // oldest two): re-anchor the distance so the scale doesn't jump.
        const [a, b] = pair(state);
        state.lastDist = dist(a, b);
        return NONE;
      }
      state.lastPan = null;
      return NONE;
    }
    default:
      return NONE;
  }
}

// How long after the last ctrl-wheel tick a wheel-pinch is considered ended
// (wheel streams have no phases of their own).
const WHEEL_END_MS = 200;
// Double-tap: second tap within this window and radius toggles the preset zoom.
const DBLTAP_MS = 300;
const DBLTAP_PX = 30;
// Compat dblclick synthesized from a touch double-tap arrives within this
// window of the tap; treat it as an echo, not a fresh double-click.
const DBLCLICK_ECHO_MS = 700;
// Module-global: the echo crosses adapter instances (tap on the scroller, echo
// on the overlay). -Infinity, NOT 0: performance.now() is small right after
// page load, and 0 would swallow a legitimate double-click in the first 700ms.
let lastTouchDoubleTap = -Infinity;

// Wire a gesture area. handlers: {onPinch({phase, factor?, cx, cy}), onPan({dx,
// dy}), onDoubleTap({cx, cy})} — all optional. Returns detach().
export function attachGestures(el, handlers) {
  const onPinch = handlers.onPinch || (() => {});
  const onPan = handlers.onPan || (() => {});
  const onDoubleTap = handlers.onDoubleTap || (() => {});
  const tracker = createTracker();

  const forward = (action) => {
    switch (action.kind) {
      case "pinch-start":
        onPinch({ phase: "start", cx: action.cx, cy: action.cy });
        break;
      case "pinch-change":
        onPinch({ phase: "change", factor: action.factor, cx: action.cx, cy: action.cy });
        break;
      case "pinch-end":
        onPinch({ phase: "end" });
        break;
      case "pan":
        onPan({ dx: action.dx, dy: action.dy });
        break;
    }
  };

  const pe = (type) => (e) => {
    // Skip hover MOVES only. "up"/"cancel" must always reach the reducer: a
    // mouse pointerup has buttons===0 by spec (the released button is already
    // excluded), so a broader guard here swallowed every mouse release and the
    // ghost pointer made the next touch a spurious pinch on hybrid devices.
    if (e.pointerType === "mouse" && type === "move" && e.buttons === 0) return;
    forward(trackEvent(tracker, { type, id: e.pointerId, x: e.clientX, y: e.clientY }));
  };
  const onDown = pe("down");
  const onMove = pe("move");
  const onUp = pe("up");
  const onCancel = pe("cancel");

  // The Android escape hatch (see header). `cancelable` guard: a touchmove the
  // browser already committed to scrolling can't be prevented — don't try.
  const onTouch = (e) => {
    if (e.touches.length >= 2 && e.cancelable) e.preventDefault();
  };

  // Trackpad pinch / ctrl-scroll arrives as ctrl-wheel with no start/end —
  // synthesize the phases around an idle timeout so the consumer sees the same
  // shape as a touch pinch.
  let wheelTimer = null;
  const endWheelPinch = () => {
    wheelTimer = null;
    onPinch({ phase: "end" });
  };
  const onWheel = (e) => {
    if (!e.ctrlKey) {
      // Plain wheel: only ours when the consumer asked for it (the ZOOM overlay
      // pans with it). Without a handler, native scrolling keeps the event.
      if (handlers.onWheelPan) {
        e.preventDefault();
        handlers.onWheelPan({ dx: -e.deltaX, dy: -e.deltaY });
      }
      return;
    }
    e.preventDefault();     // the browser must never page-zoom on trackpad pinch
    if (wheelTimer === null) onPinch({ phase: "start", cx: e.clientX, cy: e.clientY });
    else clearTimeout(wheelTimer);
    wheelTimer = setTimeout(endWheelPinch, WHEEL_END_MS);
    onPinch({ phase: "change", factor: wheelFactor(e.deltaY), cx: e.clientX, cy: e.clientY });
  };

  // Double-tap (touch) — dblclick covers mouse. A tap only counts if the
  // pointer lived alone (never part of a pinch), barely moved, and was brief —
  // otherwise a drag-end or pinch-release could fake half a double-tap.
  // Deliberately does not debounce the reader's single-tap toolbar toggle; the
  // zoom controller decides how the two interact when it wires in.
  const downs = new Map(); // pointerId -> {x, y, t, solo}
  let lastTap = null;
  const onTapCancel = (e) => {
    // pointercancel is the NORMAL scroll handoff (no pointerup follows), so
    // without this the map gains one dead entry per scroll flick, forever.
    downs.delete(e.pointerId);
  };
  const onTapDown = (e) => {
    if (e.pointerType === "mouse") return;
    const solo = tracker.pointers.size === 1; // tracker already saw this down
    if (!solo) for (const d of downs.values()) d.solo = false;
    downs.set(e.pointerId, { x: e.clientX, y: e.clientY, t: performance.now(), solo });
  };
  const onTapUp = (e) => {
    if (e.pointerType === "mouse") return;
    const d = downs.get(e.pointerId);
    downs.delete(e.pointerId);
    const now = performance.now();
    const isTap = d && d.solo && now - d.t < DBLTAP_MS &&
      Math.hypot(e.clientX - d.x, e.clientY - d.y) < 10 &&
      tracker.pointers.size === 0;
    if (!isTap) {
      lastTap = null;
      return;
    }
    if (
      lastTap &&
      now - lastTap.t < DBLTAP_MS &&
      Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < DBLTAP_PX
    ) {
      lastTap = null;
      lastTouchDoubleTap = now;
      onDoubleTap({ cx: e.clientX, cy: e.clientY });
      return;
    }
    lastTap = { x: e.clientX, y: e.clientY, t: now };
  };
  const onDblClick = (e) => {
    e.preventDefault();
    // A touch double-tap makes the browser synthesize a compat dblclick that
    // hit-tests AFTER our handler ran — i.e. against the overlay the double-tap
    // just created, which would instantly toggle back out. The echo window is
    // module-global because the tap fires on one element (scroller) and its
    // echo lands on another (overlay), each with its own adapter instance.
    if (performance.now() - lastTouchDoubleTap < DBLCLICK_ECHO_MS) return;
    onDoubleTap({ cx: e.clientX, cy: e.clientY });
  };

  // iOS Safari defensive shim (no iOS hardware to verify against — see
  // OVERVIEW.md §13): swallow Safari's own gesture so it can't zoom the page; modern
  // iOS delivers the same pointer events as Android, which we already handle.
  const onGesture = (e) => e.preventDefault();

  el.addEventListener("pointerdown", onDown);
  el.addEventListener("pointerdown", onTapDown); // after onDown: tracker sees it first
  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerup", onUp);
  el.addEventListener("pointercancel", onCancel);
  el.addEventListener("pointerup", onTapUp);
  el.addEventListener("pointercancel", onTapCancel);
  el.addEventListener("dblclick", onDblClick);
  el.addEventListener("touchstart", onTouch, { passive: false });
  el.addEventListener("touchmove", onTouch, { passive: false });
  el.addEventListener("wheel", onWheel, { passive: false });
  for (const t of ["gesturestart", "gesturechange", "gestureend"]) {
    el.addEventListener(t, onGesture);
  }

  return function detach() {
    clearTimeout(wheelTimer);
    el.removeEventListener("pointerdown", onDown);
    el.removeEventListener("pointerdown", onTapDown);
    el.removeEventListener("pointermove", onMove);
    el.removeEventListener("pointerup", onUp);
    el.removeEventListener("pointercancel", onCancel);
    el.removeEventListener("pointerup", onTapUp);
    el.removeEventListener("pointercancel", onTapCancel);
    el.removeEventListener("dblclick", onDblClick);
    el.removeEventListener("touchstart", onTouch);
    el.removeEventListener("touchmove", onTouch);
    el.removeEventListener("wheel", onWheel);
    for (const t of ["gesturestart", "gesturechange", "gestureend"]) {
      el.removeEventListener(t, onGesture);
    }
  };
}
