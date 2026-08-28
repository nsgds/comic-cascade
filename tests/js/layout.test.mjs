import assert from "node:assert/strict";
import { test } from "node:test";

import { computeLayout, pageScrollTarget } from "../../web/js/reader/layout.js";

// Two pages: 1000x2000 (portrait) and 4000x1000 (wide spread).
const dims = [
  { w: 1000, h: 2000 },
  { w: 4000, h: 1000 },
];

test("vertical: fit width, never upscale, prefix-sum heights", () => {
  // viewport 500 wide: page0 -> width 500 (scaled down), height 1000
  //                    page1 -> width 500 (scaled down), height 125
  const L = computeLayout(dims, "vertical", false, 10, 500, 800);
  assert.deepEqual(L.cross, [500, 500]);
  assert.deepEqual(L.extents, [1000, 125]);
  assert.deepEqual(L.starts, [0, 1010]); // gap 10 between
  assert.equal(L.total, 1135); // 1000 + 10 + 125
});

test("vertical: never upscales a page narrower than the viewport", () => {
  // viewport 5000 wide, page0 natural 1000 -> stays 1000 (no upscale)
  const L = computeLayout([{ w: 1000, h: 2000 }], "vertical", false, 0, 5000, 800);
  assert.equal(L.cross[0], 1000);
  assert.equal(L.extents[0], 2000);
});

test("horizontal LTR: fit height, widths are the scroll extent, with lead pad", () => {
  // viewport 1200 wide x 1000 tall:
  //   page0 (1000x2000) -> height 1000 (scaled 0.5), width 500
  //   page1 (4000x1000) -> height 1000 (no scale),   width 4000 (wide spread, not upscaled)
  //   lead = 1200 - 500 = 700 (page0 narrower than viewport -> pinned right)
  const L = computeLayout(dims, "horizontal", false, 0, 1200, 1000);
  assert.deepEqual(L.cross, [1000, 1000]);
  assert.deepEqual(L.extents, [500, 4000]);
  assert.equal(L.lead, 700);
  assert.deepEqual(L.starts, [700, 1200]);
  assert.equal(L.total, 5200);
});

test("horizontal RTL mirrors start coordinates (lead pad lands on the right)", () => {
  const L = computeLayout(dims, "horizontal", true, 0, 1200, 1000);
  // total 5200 (incl. lead 700); page0 start = 5200-700-500 = 4000, page1 = 5200-1200-4000 = 0
  assert.equal(L.lead, 700);
  assert.deepEqual(L.starts, [4000, 0]);
  assert.equal(L.total, 5200);
});

test("lead pad pins a narrow page to the forward edge (horizontal)", () => {
  const L = computeLayout([{ w: 500, h: 1000 }], "horizontal", false, 0, 1200, 1000);
  assert.equal(L.lead, 700);
  assert.deepEqual(L.starts, [700]); // occupies [700,1200] = right edge
  assert.equal(L.total, 1200);
});

test("lead pad pins a short (wide) page to the bottom (vertical)", () => {
  const L = computeLayout([{ w: 2000, h: 500 }], "vertical", false, 0, 1000, 1000);
  assert.deepEqual(L.extents, [250]); // fit width 1000 -> height 250
  assert.equal(L.lead, 750);
  assert.deepEqual(L.starts, [750]); // occupies [750,1000] = bottom edge
  assert.equal(L.total, 1000);
});

test("no lead pad when the first page fills the scroll axis (tall page, vertical)", () => {
  const L = computeLayout([{ w: 1000, h: 2000 }], "vertical", false, 0, 800, 800);
  assert.equal(L.lead, 0); // height 1600 > viewport 800
  assert.deepEqual(L.starts, [0]);
});

test("null / zero dims fall back instead of producing NaN", () => {
  const L = computeLayout([null, { w: 0, h: 0 }], "vertical", false, 0, 800, 600);
  assert.ok(L.extents.every((x) => Number.isFinite(x) && x > 0));
});

test("empty comic yields zero total", () => {
  const L = computeLayout([], "vertical", false, 8, 800, 600);
  assert.equal(L.total, 0);
  assert.deepEqual(L.starts, []);
});

// ---- tail (the end-of-comic card cell) ----

test("tail extends total one gap past the last page (vertical/LTR); pages untouched", () => {
  const base = computeLayout(dims, "vertical", false, 10, 500, 800);
  const L = computeLayout(dims, "vertical", false, 10, 500, 800, 300);
  assert.deepEqual(L.starts, base.starts); // page geometry identical
  assert.equal(L.tailStart, base.total + 10); // one gap after the last page
  assert.equal(L.total, base.total + 10 + 300);
  assert.equal(base.tailStart, null); // no tail requested -> no cell
});

test("pagesEnd is the pre-tail end, so the reading-end detection guard holds", () => {
  // The last page's forward-pinned rest position is pagesEnd - viewport. With
  // a tail that is BELOW maxScroll (= total - viewport), so detection keyed on
  // maxScroll alone would hand the rest position to centre-line detection —
  // the guard must key on pagesEnd instead. Without a tail the two coincide.
  const base = computeLayout(dims, "vertical", false, 10, 500, 800);
  const L = computeLayout(dims, "vertical", false, 10, 500, 800, 300);
  assert.equal(L.pagesEnd, base.total); // pre-tail end unchanged by the tail
  assert.equal(base.pagesEnd, base.total); // no tail: guard reduces to maxScroll
  assert.ok(L.pagesEnd - 800 < L.total - 800); // rest position < maxScroll
  // RTL: the reading end is the far-left region [0, total - pagesEnd]
  const R = computeLayout(dims, "horizontal", true, 0, 1200, 1000, 400);
  assert.equal(R.total - R.pagesEnd, 400); // gap 0: exactly the tail span
});

test("RTL: the tail lands at the far LEFT (after the last page in reading order)", () => {
  const L = computeLayout(dims, "horizontal", true, 0, 1200, 1000, 400);
  assert.equal(L.tailStart, 0);
  assert.equal(L.total, 5200 + 400); // gap 0 here
  // pages shift right by the tail so the cell fits before them
  assert.deepEqual(L.starts, [4400, 400]);
});

test("no tail cell for an empty comic", () => {
  const L = computeLayout([], "vertical", false, 8, 800, 600, 300);
  assert.equal(L.tailStart, null);
  assert.equal(L.total, 0);
});

// ---- pageScrollTarget: where a jump lands a page ----

test("tall page (fills viewport) aligns to reading-start edge, not the bottom", () => {
  // vertical/LTR: a page taller than the viewport must show its TOP (start), so
  // you enter at the start of the page rather than its trailing edge.
  assert.equal(pageScrollTarget(0, 1200, 900, false), 0);
  assert.equal(pageScrollTarget(2400, 1200, 900, false), 2400);
});

test("short page (slack) pins its forward edge, leaving space behind", () => {
  // non-mirror: target = start + extent - viewport (caller clamps to >=0)
  assert.equal(pageScrollTarget(300, 200, 900, false), 300 + 200 - 900);
});

test("RTL tall page aligns to its right (reading-start) edge", () => {
  assert.equal(pageScrollTarget(0, 1600, 1000, true), 0 + 1600 - 1000);
});

test("RTL short page pins to the left (forward) edge", () => {
  assert.equal(pageScrollTarget(4000, 500, 1200, true), 4000);
});
