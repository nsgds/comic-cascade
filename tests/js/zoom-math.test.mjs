// Pins the zoom transform rules before any overlay/gesture code exists: the
// focal-point invariant, the pan clamps, the scale caps, and the exit
// threshold. The coordinate model is documented in zoom-math.js — these tests
// are also its executable spec.
import test from "node:test";
import assert from "node:assert/strict";

import {
  EXIT_SCALE, MIN_MAX_SCALE, PAN_SLACK_FRAC,
  clampPan, clampStep, cssTransform, initialState, maxScaleFor, panBy,
  presetScale, shouldExit, slackFor, visibleRect, wheelFactor, zoomAt,
} from "../../web/js/reader/zoom-math.js";

// A viewport-filling-width page (vertical fit-width mode) and a smaller,
// centered page — the two shapes the reader actually produces.
const VIEWPORT = { w: 800, h: 600 };
const FULL = { x: 0, y: 0, w: 800, h: 1200 };     // taller than the viewport
const SMALL = { x: 200, y: 100, w: 400, h: 400 }; // smaller than the viewport both ways

const approx = (a, b, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) <= eps, `${a} !~ ${b}`);

test("zoomAt preserves the content under the focal point", () => {
  // Zoom 2x about the viewport center; the content point that was under the
  // focal point must still be under it afterwards.
  const s0 = initialState();
  const cx = 400, cy = 300;
  const s1 = zoomAt(s0, 2, cx, cy, FULL, VIEWPORT, 8);
  assert.equal(s1.scale, 2);
  // content coordinate under (cx, cy) before: u = (cx - rect.x - tx) / scale
  const u0 = (cx - FULL.x - s0.tx) / s0.scale;
  const u1 = (cx - FULL.x - s1.tx) / s1.scale;
  approx(u0, u1);
  const v0 = (cy - FULL.y - s0.ty) / s0.scale;
  const v1 = (cy - FULL.y - s1.ty) / s1.scale;
  approx(v0, v1);
});

test("zoomAt about a corner keeps that corner fixed", () => {
  // Focal point at the page's top-left corner (0,0 content): tx/ty must not move.
  const s1 = zoomAt(initialState(), 1.5, FULL.x, FULL.y, FULL, VIEWPORT, 8);
  approx(s1.tx, 0);
  approx(s1.ty, 0);
  assert.equal(s1.scale, 1.5);
});

test("zoom in then out at the same focal point returns to identity", () => {
  const s1 = zoomAt(initialState(), 1.8, 500, 400, FULL, VIEWPORT, 8);
  const s2 = zoomAt(s1, 1 / 1.8, 500, 400, FULL, VIEWPORT, 8);
  approx(s2.scale, 1);
  approx(s2.tx, 0);
  approx(s2.ty, 0);
});

test("scale clamps to [1, maxScale] and a capped zoom still pan-clamps", () => {
  const below = zoomAt(initialState(), 0.5, 400, 300, FULL, VIEWPORT, 8);
  assert.equal(below.scale, 1);
  let s = initialState();
  for (let i = 0; i < 6; i++) s = zoomAt(s, 2, 400, 300, FULL, VIEWPORT, 3);
  assert.equal(s.scale, 3);
  const r = visibleRect(s, FULL);
  assert.ok(r.x <= 0 && r.x + r.w >= VIEWPORT.w); // no gap at the edges
});

test("one event cannot step the scale more than MAX_STEP", () => {
  const s1 = zoomAt(initialState(), 100, 400, 300, FULL, VIEWPORT, 50);
  assert.equal(s1.scale, 2); // 100x asked, one 2x step granted
  assert.equal(clampStep(0.001), 0.5);
});

test("clampPan: a covered axis pans to the slack margin past flush, never further", () => {
  // Pan way off in every direction at 2x (1600x2400 in 800x600): the page may
  // overshoot flush by the slack margin — an edge panel can be pulled toward
  // the middle of the screen — but can't be flung off it.
  const mx = VIEWPORT.w * PAN_SLACK_FRAC;
  const my = VIEWPORT.h * PAN_SLACK_FRAC;
  const c = clampPan({ scale: 2, tx: 9999, ty: -9999 }, FULL, VIEWPORT);
  const r = visibleRect(c, FULL);
  assert.equal(r.x, mx);                       // left edge rests at the slack bound
  assert.equal(r.y + r.h, VIEWPORT.h - my);    // bottom edge likewise
  // a drag WITHIN the slack sticks where it's put (no snap-back to flush)
  const gentle = clampPan({ scale: 2, tx: mx / 2, ty: 0 }, FULL, VIEWPORT);
  approx(gentle.tx, mx / 2);
});

test("clampPan: centers on an axis where the page is smaller than the viewport", () => {
  // SMALL at 1x is 400x400 in an 800x600 viewport: both axes center, regardless
  // of where the pan tried to put it.
  const c = clampPan({ scale: 1, tx: -500, ty: 500 }, SMALL, VIEWPORT);
  const r = visibleRect(c, SMALL);
  approx(r.x, 200);
  approx(r.y, 100);
  // at 1.6x (640x640) the width still centers but the height (640 > 600)
  // clamps — to the TAPERED slack bound: barely covered, barely any slack
  const c2 = clampPan({ scale: 1.6, tx: 0, ty: 9999 }, SMALL, VIEWPORT);
  const r2 = visibleRect(c2, SMALL);
  approx(r2.x, (VIEWPORT.w - 640) / 2);
  approx(r2.y, slackFor(640, VIEWPORT.h)); // = (640-600)/2 = 20, not the full 150
});

test("panBy moves within the clamp and no further", () => {
  const s = zoomAt(initialState(), 2, 400, 300, FULL, VIEWPORT, 8);
  const p = panBy(s, -10_000, 0, FULL, VIEWPORT);
  const r = visibleRect(p, FULL);
  // dragged hard left: right edge rests at the slack bound past flush
  assert.equal(r.x + r.w, VIEWPORT.w - VIEWPORT.w * PAN_SLACK_FRAC);
  assert.equal(p.scale, s.scale);      // pan never changes scale
});

test("zoomAt preserves the focal point for an OFFSET rect too", () => {
  // Mutation-testing showed the FULL-rect tests let a rect.x/rect.y sign error
  // pass (the terms cancel at origin). This rect sits at (200,100) AND covers
  // the viewport on both axes at 1.5x, so clampPan doesn't move the result and
  // the focal invariant must hold exactly where the offset terms matter.
  const OFF = { x: 200, y: 100, w: 700, h: 700 };
  const s0 = initialState();
  const cx = 400, cy = 300;
  const s1 = zoomAt(s0, 1.5, cx, cy, OFF, VIEWPORT, 8);
  const u0 = (cx - OFF.x - s0.tx) / s0.scale;
  const u1 = (cx - OFF.x - s1.tx) / s1.scale;
  approx(u0, u1);
  const v0 = (cy - OFF.y - s0.ty) / s0.scale;
  const v1 = (cy - OFF.y - s1.ty) / s1.scale;
  approx(v0, v1);
  assert.equal(s1.scale, 1.5);
});

test("slack tapers to zero at the covered/centered crossing (no teleport)", () => {
  // slackFor converges the covered branch's bounds to the centered value as the
  // scaled dimension approaches the viewport, so a zoom-out crossing cannot
  // jump the page (a fixed slack allowed a ~195px one-frame snap — reproduced
  // before the fix with exactly this geometry).
  assert.equal(slackFor(800, 800), 0);                     // at the crossing: none
  assert.equal(slackFor(810, 800), 5);                     // barely covered: tiny
  assert.equal(slackFor(1600, 800), 800 * PAN_SLACK_FRAC); // deep zoom: full slack
  // The verifier's repro: fit-height page 424px wide centered in an 800px box.
  const rect = { x: 188, y: 0, w: 424, h: 600 };
  const vp = { w: 800, h: 600 };
  let s = zoomAt(initialState(), 1.9, 400, 300, rect, vp, 8); // w = 805.6, covered
  s = panBy(s, 10_000, 0, rect, vp);                          // drag to the slack bound
  const before = visibleRect(s, rect).x;
  const after = visibleRect(zoomAt(s, 0.98, 400, 300, rect, vp, 8), rect).x; // crosses
  assert.ok(Math.abs(after - before) < 8,
    `crossing jumped ${Math.abs(after - before)}px (was ~195px pre-fix)`);
});

test("exit threshold and preset targets", () => {
  assert.ok(shouldExit(1));
  assert.ok(shouldExit(EXIT_SCALE));
  assert.ok(!shouldExit(1.03));
  assert.equal(presetScale(8), 2);
  assert.equal(presetScale(1.5), 1.5); // never past the cap
});

test("maxScaleFor: native 1:1 when past the floor, floor otherwise", () => {
  assert.equal(maxScaleFor(4000, 800), 5);            // big scan: to native
  assert.equal(maxScaleFor(900, 800), MIN_MAX_SCALE); // small page: floor wins
  assert.equal(maxScaleFor(0, 800), MIN_MAX_SCALE);   // missing dims: floor
});

test("wheelFactor: negative deltaY zooms in, bounded per event", () => {
  assert.ok(wheelFactor(-53) > 1);
  assert.ok(wheelFactor(40) < 1);
  approx(wheelFactor(-40) * wheelFactor(40), 1, 1e-12); // symmetric
  assert.equal(wheelFactor(-1e6), 2);                   // clamped
});

test("cssTransform matches the visibleRect model", () => {
  const s = { scale: 2.5, tx: -30, ty: 12 };
  assert.equal(cssTransform(s), "translate(-30px, 12px) scale(2.5)");
  const r = visibleRect(s, SMALL);
  assert.equal(r.w, 1000);
  assert.equal(r.x, 170);
});
