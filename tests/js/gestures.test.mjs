// Pins the pure pointer-tracking reducer behind attachGestures: the pinch
// lifecycle, per-event factors, pan deltas, and — straight from the phase-0
// Android spike — the pointercancel semantics ("the browser took that pointer")
// and the ghost-pairing edge (a 2nd finger landing after the 1st was
// scroll-cancelled must not pinch against a ghost).
import test from "node:test";
import assert from "node:assert/strict";

import { createTracker, trackEvent } from "../../web/js/reader/gestures.js";

const down = (id, x, y) => ({ type: "down", id, x, y });
const move = (id, x, y) => ({ type: "move", id, x, y });
const up = (id, x, y = 0) => ({ type: "up", id, x, y });
const cancel = (id, x = 0, y = 0) => ({ type: "cancel", id, x, y });

const approx = (a, b, eps = 1e-12) =>
  assert.ok(Math.abs(a - b) <= eps, `${a} !~ ${b}`);

test("pinch lifecycle: start on 2nd finger, factors track distance, end on lift", () => {
  const t = createTracker();
  assert.equal(trackEvent(t, down(1, 100, 300)).kind, "none");
  const start = trackEvent(t, down(2, 300, 300)); // 200px apart
  assert.equal(start.kind, "pinch-start");
  assert.equal(start.cx, 200);
  assert.equal(start.cy, 300);
  const c1 = trackEvent(t, move(2, 500, 300)); // 400px apart -> 2x
  assert.equal(c1.kind, "pinch-change");
  approx(c1.factor, 2);
  assert.equal(c1.cx, 300);
  const c2 = trackEvent(t, move(1, 300, 300)); // 200px apart -> 0.5x of current
  approx(c2.factor, 0.5);
  assert.equal(trackEvent(t, up(2)).kind, "pinch-end");
  assert.equal(trackEvent(t, up(1)).kind, "none");
});

test("per-event factors compose to the total distance ratio", () => {
  const t = createTracker();
  trackEvent(t, down(1, 0, 0));
  trackEvent(t, down(2, 100, 0));
  let product = 1;
  for (const x of [150, 220, 330, 250]) {
    product *= trackEvent(t, move(2, x, 0)).factor;
  }
  approx(product, 2.5); // 100px -> 250px overall
});

test("single live pointer drags emit pan deltas", () => {
  const t = createTracker();
  trackEvent(t, down(1, 50, 50));
  const p1 = trackEvent(t, move(1, 60, 45));
  assert.deepEqual(p1, { kind: "pan", dx: 10, dy: -5 });
  const p2 = trackEvent(t, move(1, 60, 45)); // no movement -> silence
  assert.equal(p2.kind, "none");
});

test("a move for an unknown/cancelled pointer is ignored (browser owns it)", () => {
  const t = createTracker();
  assert.equal(trackEvent(t, move(9, 1, 1)).kind, "none");
  trackEvent(t, down(1, 0, 0));
  trackEvent(t, cancel(1)); // native scroll handoff (the spike's normal case)
  assert.equal(trackEvent(t, move(1, 50, 50)).kind, "none");
});

test("ghost pairing: 2nd finger after a scroll-cancelled 1st pans, never pinches", () => {
  // The spike edge case: finger 1 down -> browser claims it for scroll
  // (pointercancel) -> finger 2 lands. Only one LIVE pointer exists.
  const t = createTracker();
  trackEvent(t, down(1, 100, 100));
  trackEvent(t, cancel(1));
  assert.equal(trackEvent(t, down(2, 200, 200)).kind, "none"); // no pinch-start
  assert.equal(trackEvent(t, move(2, 210, 200)).kind, "pan");
});

test("cancel mid-pinch ends it; the survivor pans from a fresh anchor", () => {
  const t = createTracker();
  trackEvent(t, down(1, 0, 0));
  trackEvent(t, down(2, 100, 0));
  assert.equal(trackEvent(t, cancel(2)).kind, "pinch-end");
  // Survivor's first move measures from its own position — no midpoint jump.
  const p = trackEvent(t, move(1, 7, 3));
  assert.deepEqual(p, { kind: "pan", dx: 7, dy: 3 });
});

test("a 3rd finger neither restarts the pinch nor pollutes its factor", () => {
  const t = createTracker();
  trackEvent(t, down(1, 0, 0));
  trackEvent(t, down(2, 100, 0));
  assert.equal(trackEvent(t, down(3, 500, 500)).kind, "none");
  assert.equal(trackEvent(t, move(3, 600, 600)).kind, "none"); // extra finger ignored
  const c = trackEvent(t, move(2, 200, 0)); // the real pair still tracks
  approx(c.factor, 2);
  // Lifting a pair finger with a 3rd present re-anchors silently (no scale jump):
  assert.equal(trackEvent(t, up(2, 200)).kind, "none");
  const c2 = trackEvent(t, move(3, 600, 600)); // now part of the new pair
  assert.equal(c2.kind, "pinch-change");
  approx(c2.factor, 1); // same distance as the re-anchor -> no jump
});

test("coincident fingers re-anchor instead of wedging the factor stream", () => {
  const t = createTracker();
  trackEvent(t, down(1, 100, 100));
  assert.equal(trackEvent(t, down(2, 100, 100)).kind, "pinch-start"); // dist 0
  assert.equal(trackEvent(t, move(2, 150, 100)).kind, "none"); // re-anchor at 50px
  const c = trackEvent(t, move(2, 200, 100)); // 100px vs 50px anchor
  assert.equal(c.kind, "pinch-change");
  approx(c.factor, 2);
});
