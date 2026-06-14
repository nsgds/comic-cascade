// Pure layout geometry for the reader — no DOM, so it is easy to reason about and
// test. Given page dimensions and the current mode, it produces, for every page:
//   extent  — size along the SCROLL axis (height in vertical, width in horizontal)
//   cross   — size along the CROSS axis (the fit dimension; for centering)
//   start   — coordinate along the scroll axis where the page begins (visual order;
//             mirrored for horizontal right-to-left)
// plus the total scrollable size and the leading pad.
//
// Pages are never upscaled: the fit dimension is min(viewport, natural). A leading
// pad before page 0 lets the FIRST page sit flush against the forward (reading)
// edge — bottom in vertical, right in LTR, left in RTL — with empty space behind it.

const FALLBACK = { w: 800, h: 1200 }; // used for pages with unknown/missing dims

export function computeLayout(dims, mode, rtl, gap, viewportW, viewportH) {
  const n = dims.length;
  const extents = new Array(n);
  const cross = new Array(n);

  for (let i = 0; i < n; i++) {
    const d = dims[i] && dims[i].w > 0 && dims[i].h > 0 ? dims[i] : FALLBACK;
    if (mode === "vertical") {
      const dispW = Math.min(viewportW, d.w); // fit width, never upscale
      const scale = dispW / d.w;
      cross[i] = dispW;
      extents[i] = d.h * scale;
    } else {
      const dispH = Math.min(viewportH, d.h); // fit height, never upscale
      const scale = dispH / d.h;
      cross[i] = dispH;
      extents[i] = d.w * scale;
    }
  }

  // Leading pad so the FIRST page can sit flush against the forward edge (bottom
  // in vertical, right in LTR, left in RTL) with empty space behind it. Only has
  // an effect when the first page is smaller than the viewport along the scroll
  // axis; otherwise the page fills/overflows and there's nothing to pad.
  const V = mode === "vertical" ? viewportH : viewportW;
  const lead = n ? Math.max(0, V - extents[0]) : 0;

  // Offsets in reading order (page 0 first), gap between consecutive pages.
  const offsets = new Array(n);
  let acc = lead;
  for (let i = 0; i < n; i++) {
    offsets[i] = acc;
    acc += extents[i] + gap;
  }
  const total = n ? acc - gap : 0;

  // Visual start coordinate. Horizontal RTL mirrors so reading right-to-left
  // (the lead pad then lands on the right, pinning page 0 to the left edge).
  const starts = new Array(n);
  const mirror = mode === "horizontal" && rtl;
  for (let i = 0; i < n; i++) {
    starts[i] = mirror ? total - offsets[i] - extents[i] : offsets[i];
  }

  return { extents, cross, starts, total, lead };
}

// Scroll position that places page i correctly for the forward-edge model:
//  - page SMALLER than the viewport (slack exists) -> pin its forward edge to the
//    viewport's forward edge, leaving empty space behind it;
//  - page that FILLS/overflows the viewport -> align its reading-START edge so you
//    enter at the top (vertical/LTR) or right (RTL), not its trailing edge.
// The caller clamps to [0, maxScroll].
export function pageScrollTarget(start, extent, viewport, mirror) {
  if (mirror) {
    // RTL: forward edge = left; reading-start edge = right.
    return extent >= viewport ? start + extent - viewport : start;
  }
  // vertical/LTR: forward edge = bottom/right; reading-start edge = top/left.
  return extent >= viewport ? start : start + extent - viewport;
}
