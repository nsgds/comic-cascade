// The reader: two scroll modes (vertical fit-width / horizontal fit-height with
// RTL), virtualized so only pages near the viewport are in the DOM, with page-jump
// navigation, adjustable gap, keyboard control, and URL state for refresh-resume.
// Pinch-zoom is layered on BESIDE this via reader/zoom.js (the SCROLL<->ZOOM
// overlay); this file owns native scroll and hands zoom the integration hooks.
//
// Navigation is authoritative: goTo()/relayout() set the current page directly and
// briefly lock scroll-driven detection (navLock) so the programmatic scroll's own
// events can't re-pick a neighbouring page. Free-scroll detection is edge-aware
// because the browser clamps scrollTop/Left at the extremes (a page narrower than
// the viewport can never be centred).

import { api } from "../api.js";
import * as progress from "../progress.js";
import { computeLayout, pageScrollTarget } from "./layout.js";
import { clampGap, GAP_STEP, loadSettings, saveSettings } from "./settings.js";
import { createZoomController } from "./zoom.js";
import { getTheme, toggleTheme } from "../theme.js";

const OVERSCAN = 1.25; // viewport multiples kept mounted beyond the visible window
const PRELOAD_AHEAD = 4;
const now = () => performance.now();

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// Fullscreen API, with the older WebKit prefixes (desktop/iPad Safari). Returns
// false on iPhone Safari, where the API is unavailable for non-<video> elements —
// so the button is simply hidden there.
const FULLSCREEN_SUPPORTED = !!(
  document.fullscreenEnabled || document.webkitFullscreenEnabled
);
function fullscreenElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}
function requestFullscreen(elem) {
  // The standard API returns a promise that rejects if the request is denied
  // (e.g. iframe permissions-policy, OS block); swallow it to avoid console noise.
  const p = (elem.requestFullscreen || elem.webkitRequestFullscreen)?.call(elem);
  if (p && typeof p.catch === "function") p.catch(() => {});
}
function exitFullscreen() {
  (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
}

export function renderReader(container, { library, path, query }) {
  document.body.classList.add("reading");
  container.innerHTML = "";

  // ---- state ----
  const saved = loadSettings();
  const st = {
    mode: query.get("mode") === "horizontal" ? "horizontal"
        : query.get("mode") === "vertical" ? "vertical" : saved.mode,
    rtl: query.has("rtl") ? query.get("rtl") === "1" : saved.rtl,
    gap: query.has("gap") ? clampGap(query.get("gap")) : saved.gap,
    pinned: saved.pinned, // toolbar pinned vs auto-hide (local pref, not in URL)
  };
  // An explicit page in the URL (refresh mid-read, shared link, continue-reading
  // chip) is authoritative: open there directly, never offer the resume pill.
  const hasExplicitPage = query.has("page");
  const wantPage = Math.max(0, parseInt(query.get("page") || "0", 10) || 0);

  let dims = [];
  let layout = null;
  let currentPage = 0;
  let navLockUntil = 0; // suppress scroll-detection during programmatic scrolls
  let navUnlockTimer = null; // fallback to release the lock if scrollend never fires
  let toolbarTimer = null; // auto-hide inactivity timer (unpinned mode)
  const mounted = new Map(); // index -> img
  const preloads = new Set(); // detached prefetch <img>s, tracked so teardown aborts them
  let scroller, spacer, toolbar, pageInd, rootEl, fsBtn, pinBtn;
  let zoom = null; // SCROLL<->ZOOM controller (zoom.js); null until build()
  let tbMenu = null; // the ⋯ overflow popover
  let menuOpen = false;
  let destroyed = false;
  let resumePill = null; // the ask-first "Resume from p. N?" offer
  // Progress writes stay OFF until the resume question is settled (answered,
  // dismissed, or moot) — otherwise merely opening the comic at page 0 would
  // clobber the position the pill is offering to restore.
  let reportingArmed = hasExplicitPage;
  // True until the first reportProgress() tick. An explicit-page open that lands
  // clamped on the LAST page (deep link into a since-shrunken comic) must not
  // count as "finished" — the user hasn't read anything yet.
  let firstReportTick = true;

  // Reading-view viewport lock. Once a scroll/fling is active, Chrome delivers
  // NON-cancelable touchmoves — the gesture layer's 2-finger preventDefault
  // hatch cannot fire (it rightly checks e.cancelable) and a mid-fling pinch
  // falls through to the BROWSER's viewport zoom, zooming the whole app,
  // toolbar included. Disabling viewport zoom for the reading view only closes
  // that window: Android honors it; iOS ignores the attribute (keeping its
  // accessibility zoom — Safari's own gesture is handled by the gesture* shim).
  // The browse view keeps normal page zoom — this is swapped in build() and
  // restored in teardown().
  const vpMeta = document.querySelector('meta[name="viewport"]');
  const vpOriginal = vpMeta ? vpMeta.content : null;

  const onResize = () => relayout(currentPage);
  const onFullscreenChange = () => {
    syncFsButton();
    relayout(currentPage); // entering/leaving fullscreen changes the viewport size
  };

  function teardown() {
    destroyed = true;
    progress.flush(); // a debounced position write must not die with the view
    if (zoom) zoom.destroy();
    if (vpMeta && vpOriginal !== null) vpMeta.content = vpOriginal;
    clearTimeout(navUnlockTimer);
    clearTimeout(toolbarTimer);
    window.removeEventListener("resize", onResize);
    document.removeEventListener("fullscreenchange", onFullscreenChange);
    document.removeEventListener("webkitfullscreenchange", onFullscreenChange);
    if (scroller) {
      scroller.removeEventListener("scroll", onScroll);
      document.removeEventListener("keydown", onKey);
      scroller.removeEventListener("scrollend", onScrollEnd);
      scroller.removeEventListener("pointerdown", onPointerDown);
      scroller.removeEventListener("pointerup", onPointerUp);
    }
    for (const img of mounted.values()) {
      img.removeAttribute("src"); // let the browser abort in-flight loads
      img.remove();
    }
    mounted.clear();
    for (const im of preloads) im.removeAttribute("src"); // abort prefetches too
    preloads.clear();
    document.body.classList.remove("reading");
  }

  // ---- load ----
  container.appendChild(el("div", "center-msg", "Loading…"));
  // Look up the saved position in parallel with the comic metadata; the reader
  // never waits on it (the pill appears when it resolves, usually instantly).
  // Skipped entirely for explicit-page opens — the answer would go unused.
  const savedPos = hasExplicitPage
    ? Promise.resolve(null)
    : progress.get(library, path).catch(() => null);
  api.comic(library, path).then((meta) => {
    build(meta);
    if (!destroyed && dims.length && !hasExplicitPage) savedPos.then(offerResume);
  }).catch((e) => {
    if (destroyed) return;
    const code = e.status || "error";
    container.innerHTML = "";
    const msg = el("div", "center-msg tree-error");
    msg.append(
      `Can't open this comic (${code}). `,
      Object.assign(el("a", null, "Back"), { href: "#/" }),
    );
    container.appendChild(msg);
  });

  let onScroll; // assigned in build(); referenced by teardown()

  function build(meta) {
    if (destroyed) return;
    if (vpMeta) {
      // APPEND to the original content (it carries viewport-fit=cover, which
      // the toolbar's safe-area cutout padding depends on) — never replace it.
      vpMeta.content = `${vpOriginal}, maximum-scale=1, user-scalable=no`;
    }
    dims = meta.dims && meta.dims.length ? meta.dims : [];
    if (dims.length === 0) {
      container.innerHTML = "";
      container.appendChild(el("div", "center-msg", "No readable pages."));
      return;
    }
    currentPage = Math.min(wantPage, dims.length - 1);

    rootEl = el("div", "reader");
    toolbar = buildToolbar();
    scroller = el("div", "reader-scroller");
    scroller.tabIndex = 0;
    spacer = el("div", "reader-spacer");
    scroller.appendChild(spacer);
    rootEl.append(toolbar, scroller);
    container.innerHTML = "";
    container.appendChild(rootEl);

    let ticking = false;
    onScroll = () => {
      // Get out of the way while reading — but not for programmatic scrolls
      // (relayout/goTo arm the nav lock), so the brief reveal in applyPinState()
      // and on deep-linked load survives. Matches updateCurrentPage's gating.
      if (!st.pinned && now() >= navLockUntil) hideToolbar();
      // Scrolling answers the resume question ("no thanks, reading from here").
      if (resumePill && now() >= navLockUntil) dismissResume();
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(() => {
          ticking = false;
          if (!destroyed) renderVisible();
        });
      }
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    document.addEventListener("keydown", onKey); // document-level so toolbar clicks don't lose nav
    // Single-pointer tap toggles the toolbar when auto-hiding (kept
    // single-pointer so it doesn't conflict with the multi-touch pinch that
    // enters zoom).
    scroller.addEventListener("pointerdown", onPointerDown);
    scroller.addEventListener("pointerup", onPointerUp);
    // Pinch/double-tap/ctrl-wheel enter the zoom overlay; entering dismisses
    // the resume pill (like scrolling does) and lets the toolbar slip away.
    zoom = createZoomController({
      rootEl, scroller, toolbar,
      // The page UNDER the gesture point — at a page seam the viewport-center
      // page (currentPage) is routinely the tapped page's neighbour. Falls back
      // to currentPage when the point misses every mounted rect (page gaps,
      // keyboard-center entry). Zooming a non-current page deliberately does
      // NOT re-commit currentPage: progress/URL keep viewport-center semantics.
      getPage: (cx, cy) => {
        let idx = currentPage;
        if (cx != null) {
          for (const [i, im] of mounted) {
            const r = im.getBoundingClientRect();
            if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) {
              idx = i;
              break;
            }
          }
        }
        return {
          img: mounted.get(idx),
          natural: dims[idx] || null,
          src: api.pageURL(library, path, idx),
        };
      },
      // Finish an in-flight smooth scroll before the overlay measures rects.
      settle: () => {
        if (now() < navLockUntil) scrollToPage(currentPage, "instant");
      },
      onEnter: () => {
        if (resumePill) dismissResume();
        if (!st.pinned) hideToolbar();
      },
    });
    window.addEventListener("resize", onResize);
    if (FULLSCREEN_SUPPORTED) {
      document.addEventListener("fullscreenchange", onFullscreenChange);
      document.addEventListener("webkitfullscreenchange", onFullscreenChange);
    }

    requestAnimationFrame(() => {
      if (destroyed) return;
      applyPinState(); // sets layout (toolbar in-flow vs overlay) + initial visibility
      scroller.focus({ preventScroll: true });
    });
  }

  // ---- toolbar auto-hide ----
  let tapStart = null;
  function onPointerDown(e) {
    tapStart = e.isPrimary ? { x: e.clientX, y: e.clientY, t: now(), id: e.pointerId } : null;
  }
  function onPointerUp(e) {
    const start = tapStart;
    tapStart = null;
    if (!start || e.pointerId !== start.id) return;
    const moved = Math.abs(e.clientX - start.x) > 10 || Math.abs(e.clientY - start.y) > 10;
    if (!moved && now() - start.t < 300) toggleToolbar();
  }

  function applyPinState() {
    rootEl.classList.toggle("autohide", !st.pinned);
    syncPinBtn();
    if (st.pinned) {
      clearTimeout(toolbarTimer);
      toolbar.classList.remove("hidden");
    } else {
      showToolbar(); // visible briefly, then auto-hides
    }
    relayout(currentPage); // toolbar moving in/out of flow changes the scroll area
  }
  function showToolbar() {
    if (destroyed) return;
    toolbar.classList.remove("hidden");
    clearTimeout(toolbarTimer);
    if (!st.pinned) toolbarTimer = setTimeout(hideToolbar, 3000);
  }
  function hideToolbar() {
    if (st.pinned || menuOpen) return; // keep the bar while the ⋯ menu is open
    clearTimeout(toolbarTimer);
    toolbar.classList.add("hidden");
  }
  function toggleToolbar() {
    if (menuOpen) {
      closeMenu(); // a page tap first dismisses the open menu
      return;
    }
    if (st.pinned) return;
    if (toolbar.classList.contains("hidden")) showToolbar();
    else hideToolbar();
  }
  function openMenu() {
    if (!tbMenu) return;
    menuOpen = true;
    tbMenu.hidden = false;
    clearTimeout(toolbarTimer); // don't auto-hide under an open menu
  }
  function closeMenu() {
    if (!tbMenu) return;
    menuOpen = false;
    tbMenu.hidden = true;
    if (!st.pinned) showToolbar(); // re-arm the auto-hide timer
  }
  function syncPinBtn() {
    if (!pinBtn) return;
    pinBtn.classList.toggle("on", st.pinned);
    pinBtn.textContent = st.pinned ? "📌  Toolbar pinned" : "📌  Toolbar auto-hides";
  }

  // ---- read-resume (ask-first) ----
  function offerResume(rec) {
    // A record is only worth offering if it points somewhere real to jump to;
    // anything else (none / page 0 / beyond a shrunken re-scan) just arms writes.
    // A record resolving AFTER the user already entered ZOOM is moot the same
    // way scrolling is ("reading from here") — and the pill would render at
    // z 40 under the z 55 overlay, invisible but interactive.
    if (destroyed || !rec || !(rec.page > 0) || rec.page >= dims.length ||
        (zoom && zoom.active())) {
      reportingArmed = true;
      writeUrl(); // no question to ask — the URL may carry the page immediately
      return;
    }
    resumePill = el("div", "resume-pill");
    resumePill.append(el("span", "resume-pill-text", `Resume from p. ${rec.page + 1} / ${dims.length}?`));
    const go = el("button", "resume-pill-btn", "Resume");
    go.onclick = () => {
      dismissResume();
      goTo(rec.page, "instant");
    };
    const x = Object.assign(el("button", "resume-pill-x", "✕"), { title: "No, stay here" });
    x.setAttribute("aria-label", "Dismiss, stay on this page");
    x.onclick = dismissResume;
    resumePill.append(go, x);
    rootEl.appendChild(resumePill);
  }

  function dismissResume() {
    if (resumePill) {
      resumePill.remove();
      resumePill = null;
    }
    reportingArmed = true; // question settled either way — start recording
    writeUrl(); // the URL may now carry the page (it was withheld while pending)
  }

  function reportProgress() {
    // The write policy (finish-deletes, page-0 skip, disarmed skip, first-tick
    // clamp guard) is progress.reportAction — pure and unit-tested.
    const action = progress.reportAction({
      armed: reportingArmed,
      page: currentPage,
      pageCount: dims.length,
      firstTickAfterExplicitOpen: firstReportTick && hasExplicitPage,
    });
    firstReportTick = false;
    try {
      if (action === "finish") progress.forget(library, path, dims.length);
      else if (action === "record") progress.report(library, path, currentPage, dims.length);
    } catch {
      /* progress must never break page navigation */
    }
  }

  // ---- layout / virtualization ----
  function relayout(preservePage) {
    if (destroyed) return;
    // Geometry is about to change under the overlay's captured rects: leave
    // ZOOM first (v1 policy — resize/rotation/mode/pin changes all land here).
    if (zoom && zoom.active()) zoom.exit(false);
    const vw = scroller.clientWidth;
    const vh = scroller.clientHeight;
    if (vw === 0 || vh === 0) {
      requestAnimationFrame(() => relayout(preservePage));
      return;
    }
    layout = computeLayout(dims, st.mode, st.rtl, st.gap, vw, vh);

    const vertical = st.mode === "vertical";
    scroller.classList.toggle("vertical", vertical);
    scroller.classList.toggle("horizontal", !vertical);

    if (vertical) {
      spacer.style.width = "100%";
      spacer.style.height = `${layout.total}px`;
    } else {
      // total already includes the leading pad, so it's >= the viewport width;
      // RTL edge-pinning is handled by the lead pad in computeLayout (no shift here).
      spacer.style.width = `${layout.total}px`;
      spacer.style.height = "100%";
    }

    for (const img of mounted.values()) {
      img.removeAttribute("src");
      img.remove();
    }
    mounted.clear();

    currentPage = Math.max(0, Math.min(dims.length - 1, preservePage));
    onPageChanged();
    scrollToPage(currentPage, "instant");
    renderVisible();
  }

  function scrollToPage(i, behavior) {
    i = Math.max(0, Math.min(dims.length - 1, i));
    // Lock scroll-driven detection until THIS programmatic scroll finishes, so a
    // long smooth animation (e.g. Home/End) can't churn the page indicator/URL
    // through intermediate pages before settling.
    lockNav(behavior === "smooth" ? 1500 : 250);
    const vertical = st.mode === "vertical";
    const mirror = st.mode === "horizontal" && st.rtl;
    const V = vertical ? scroller.clientHeight : scroller.clientWidth;
    const target = pageScrollTarget(layout.starts[i], layout.extents[i], V, mirror);
    if (vertical) scroller.scrollTo({ top: target, behavior });
    else scroller.scrollTo({ left: target, behavior });
  }

  function lockNav(fallbackMs) {
    navLockUntil = Infinity;
    clearTimeout(navUnlockTimer);
    scroller.removeEventListener("scrollend", onScrollEnd);
    scroller.addEventListener("scrollend", onScrollEnd, { once: true });
    navUnlockTimer = setTimeout(onScrollEnd, fallbackMs); // fallback if no scrollend
  }

  function onScrollEnd() {
    clearTimeout(navUnlockTimer);
    navUnlockTimer = null;
    if (scroller) scroller.removeEventListener("scrollend", onScrollEnd);
    // Release the lock but do NOT force a re-detect: the committed page is correct,
    // and re-running detection at a start-aligned position would mis-pick a
    // neighbour for pages narrower than the viewport.
    navLockUntil = 0;
  }

  function renderVisible() {
    if (destroyed || !layout) return;
    const vertical = st.mode === "vertical";
    const pos = vertical ? scroller.scrollTop : scroller.scrollLeft;
    const size = vertical ? scroller.clientHeight : scroller.clientWidth;
    const lo = pos - size * OVERSCAN;
    const hi = pos + size * (1 + OVERSCAN);

    const needed = new Set();
    for (let i = 0; i < dims.length; i++) {
      const s = layout.starts[i];
      if (s + layout.extents[i] >= lo && s <= hi) needed.add(i);
    }
    for (const [i, img] of mounted) {
      if (!needed.has(i)) {
        img.removeAttribute("src");
        img.remove();
        mounted.delete(i);
      }
    }
    for (const i of needed) {
      if (!mounted.has(i)) mounted.set(i, mountPage(i));
    }
    updateCurrentPage();
  }

  function mountPage(i) {
    const img = new Image();
    img.className = "rpage";
    img.decoding = "async";
    img.src = api.pageURL(library, path, i);
    img.style.position = "absolute";
    if (st.mode === "vertical") {
      img.style.top = `${layout.starts[i]}px`;
      img.style.left = "50%";
      img.style.transform = "translateX(-50%)";
      img.style.width = `${layout.cross[i]}px`;
      img.style.height = `${layout.extents[i]}px`;
    } else {
      img.style.left = `${layout.starts[i]}px`;
      img.style.top = "50%";
      img.style.transform = "translateY(-50%)";
      img.style.height = `${layout.cross[i]}px`;
      img.style.width = `${layout.extents[i]}px`;
    }
    spacer.appendChild(img);
    return img;
  }

  function argEdge(findMax) {
    let bi = 0;
    let bv = layout.starts[0];
    for (let i = 1; i < dims.length; i++) {
      const s = layout.starts[i];
      if (findMax ? s > bv : s < bv) {
        bv = s;
        bi = i;
      }
    }
    return bi;
  }

  function updateCurrentPage() {
    if (now() < navLockUntil) return; // a programmatic scroll is in progress
    const vertical = st.mode === "vertical";
    const pos = vertical ? scroller.scrollTop : scroller.scrollLeft;
    const size = vertical ? scroller.clientHeight : scroller.clientWidth;
    const maxScroll = (vertical ? scroller.scrollHeight : scroller.scrollWidth) - size;

    let best;
    if (maxScroll <= 0) {
      best = 0; // everything fits: the first reading page is "current"
    } else if (pos <= 0) {
      best = argEdge(false); // pinned at min scroll -> page at that edge
    } else if (pos >= maxScroll - 1) {
      best = argEdge(true); // pinned at max scroll (RTL right edge = page 0)
    } else {
      const center = pos + size / 2;
      best = 0;
      let bestDist = Infinity;
      for (let i = 0; i < dims.length; i++) {
        const s = layout.starts[i];
        const e = s + layout.extents[i];
        if (center >= s && center <= e) {
          best = i;
          break;
        }
        const dist = center < s ? s - center : center - e;
        if (dist < bestDist) {
          bestDist = dist;
          best = i;
        }
      }
    }
    if (best !== currentPage) {
      currentPage = best;
      onPageChanged();
    }
  }

  function onPageChanged() {
    if (destroyed) return;
    if (pageInd) pageInd.textContent = `${currentPage + 1} / ${dims.length}`;
    writeUrl();
    reportProgress();
    for (let k = 1; k <= PRELOAD_AHEAD; k++) {
      const j = currentPage + k;
      if (j >= dims.length) continue;
      const im = new Image();
      im.onload = im.onerror = () => preloads.delete(im);
      im.src = api.pageURL(library, path, j);
      preloads.add(im);
    }
  }

  // ---- navigation (authoritative: commit the page, then scroll) ----
  function goTo(i, behavior = "smooth") {
    if (zoom && zoom.active()) zoom.exit(); // navigate = leave ZOOM (arrows too)
    if (resumePill) dismissResume(); // navigating answers the resume question
    i = Math.max(0, Math.min(dims.length - 1, i));
    currentPage = i;
    onPageChanged();
    scrollToPage(i, behavior); // scrollToPage arms the nav lock
  }
  const next = () => goTo(currentPage + 1);
  const prev = () => goTo(currentPage - 1);

  function onKey(e) {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (
      t &&
      (t.tagName === "INPUT" ||
        t.tagName === "TEXTAREA" ||
        t.isContentEditable ||
        (t.closest && t.closest("button, a, select, [role=button]")))
    ) {
      return; // don't hijack typing, or a focused control's own Space/Enter
    }
    // Zoom keys first: Escape/0 exit, +/-/= zoom (and "+" enters from SCROLL).
    // Navigation keys are NOT consumed there — goTo() exits zoom itself, so
    // arrows/Home/End "exit then navigate" without special casing.
    if (zoom && zoom.handleKey(e.key)) {
      e.preventDefault();
      return;
    }
    const horiz = st.mode === "horizontal";
    let handled = true;
    switch (e.key) {
      case " ":
      case "PageDown":
      case "ArrowDown":
        horiz ? (handled = false) : next();
        break;
      case "PageUp":
      case "ArrowUp":
        horiz ? (handled = false) : prev();
        break;
      case "ArrowRight":
        horiz ? (st.rtl ? prev() : next()) : (handled = false);
        break;
      case "ArrowLeft":
        horiz ? (st.rtl ? next() : prev()) : (handled = false);
        break;
      case "Home":
        goTo(0);
        break;
      case "End":
        goTo(dims.length - 1);
        break;
      case "f":
      case "F":
        if (FULLSCREEN_SUPPORTED) toggleFullscreen();
        else handled = false;
        break;
      default:
        handled = false;
    }
    if (handled) e.preventDefault();
  }

  // ---- fullscreen ----
  function toggleFullscreen() {
    if (!FULLSCREEN_SUPPORTED || !rootEl) return;
    if (fullscreenElement() === rootEl) exitFullscreen();
    else requestFullscreen(rootEl);
  }
  function syncFsButton() {
    if (!fsBtn) return;
    const on = fullscreenElement() === rootEl;
    fsBtn.classList.toggle("on", on);
    fsBtn.textContent = on ? "⛶  Exit fullscreen" : "⛶  Fullscreen";
  }

  // The three valid reading modes -> the two underlying fields.
  function setReadingMode(m) {
    if (m === "vertical") st.mode = "vertical";
    else {
      st.mode = "horizontal";
      st.rtl = m === "rtl";
    }
    saveSettings(st);
    syncModeSeg();
    relayout(currentPage);
  }
  function currentReadingMode() {
    return st.mode === "vertical" ? "vertical" : st.rtl ? "rtl" : "ltr";
  }
  let syncModeSeg = () => {}; // assigned in buildToolbar

  // ---- toolbar ----
  // As bare as possible for camera cutouts: just Back on the left, an empty
  // flexible center, and the ⋯ menu + page-nav on the right. Everything else
  // (reading mode, gap, pin, fullscreen) lives in the ⋯ menu.
  function buildToolbar() {
    const bar = el("div", "reader-toolbar");
    // After any toolbar interaction, hand focus back to the scroller so keyboard
    // paging keeps working (and a focused button can't double-act with Space).
    bar.addEventListener("click", () => scroller && scroller.focus({ preventScroll: true }));

    // -- left: back (chevron) + ⋯ menu --
    const back = el("a", "icon-btn back-btn", "❮");
    back.href = "#/";
    back.title = "Back to library";

    const moreBtn = Object.assign(el("button", "icon-btn menu-btn", "Menu"), { title: "Menu" });
    moreBtn.onclick = () => (menuOpen ? closeMenu() : openMenu());

    const left = el("div", "tb-group tb-left");
    left.append(back, moreBtn);

    // -- center: deliberately empty (cutout-safe no-tap zone) --
    const center = el("div", "tb-center");

    // -- right: page nav --
    const navClick = (fn) => () => {
      fn();
      if (!st.pinned) showToolbar(); // button paging re-reveals; keyboard nav doesn't
    };
    const prevBtn = Object.assign(el("button", "icon-btn", "‹"), { title: "Previous page" });
    prevBtn.onclick = navClick(prev);
    const nextBtn = Object.assign(el("button", "icon-btn", "›"), { title: "Next page" });
    nextBtn.onclick = navClick(next);
    pageInd = el("span", "page-ind", "1 / 1");

    const right = el("div", "tb-group tb-right");
    right.append(prevBtn, pageInd, nextBtn);

    // -- the ⋯ overflow menu --
    tbMenu = el("div", "tb-menu");
    tbMenu.hidden = true;

    // reading mode: a labelled list so the active mode is obvious
    tbMenu.append(el("div", "menu-label", "Reading mode"));
    const modeItems = {
      vertical: Object.assign(el("button", "menu-item", "⇅  Vertical"), { title: "Vertical scroll" }),
      ltr: Object.assign(el("button", "menu-item", "→  Left-to-right"), { title: "Horizontal" }),
      rtl: Object.assign(el("button", "menu-item", "←  Right-to-left"), { title: "Horizontal" }),
    };
    for (const [m, b] of Object.entries(modeItems)) {
      b.onclick = () => setReadingMode(m);
      tbMenu.append(b);
    }
    syncModeSeg = () => {
      const cur = currentReadingMode();
      for (const [m, b] of Object.entries(modeItems)) b.classList.toggle("on", m === cur);
    };
    syncModeSeg();

    // page gap
    const setGap = (g) => {
      st.gap = clampGap(g);
      saveSettings(st);
      gapVal.textContent = `${st.gap}px`;
      relayout(currentPage);
    };
    const gapDown = Object.assign(el("button", "icon-btn", "–"), { title: "Less gap" });
    const gapUp = Object.assign(el("button", "icon-btn", "+"), { title: "More gap" });
    const gapVal = el("span", "menu-val", `${st.gap}px`);
    gapDown.onclick = () => setGap(st.gap - GAP_STEP);
    gapUp.onclick = () => setGap(st.gap + GAP_STEP);
    const stepper = el("div", "menu-stepper");
    stepper.append(gapDown, gapVal, gapUp);
    const gapRow = el("div", "tb-menu-row");
    gapRow.append(el("span", null, "Page gap"), stepper);
    tbMenu.append(el("div", "menu-sep"), gapRow);

    // pin / fullscreen
    pinBtn = el("button", "menu-item");
    pinBtn.onclick = () => {
      st.pinned = !st.pinned;
      saveSettings(st);
      applyPinState();
    };
    syncPinBtn();
    tbMenu.append(pinBtn);

    if (FULLSCREEN_SUPPORTED) {
      fsBtn = el("button", "menu-item");
      fsBtn.onclick = toggleFullscreen;
      syncFsButton();
      tbMenu.append(fsBtn);
    }

    const themeItem = el("button", "menu-item");
    const syncThemeItem = () => {
      themeItem.textContent = getTheme() === "dark" ? "☀  Light mode" : "🌙  Dark mode";
    };
    syncThemeItem();
    themeItem.onclick = () => {
      toggleTheme();
      syncThemeItem();
    };
    tbMenu.append(themeItem);

    bar.append(left, center, right, tbMenu);
    return bar;
  }

  // ---- URL state (silent; survives refresh, no history spam) ----
  function writeUrl() {
    if (destroyed) return;
    const q = new URLSearchParams();
    q.set("lib", library);
    q.set("path", path);
    // page= means "an explicitly chosen position" (it suppresses the resume pill
    // and arms writes on load). While the pill is still unanswered we must NOT
    // self-inject page=0: a reload would then read it back as an explicit answer
    // and overwrite the saved position with page 0. Until the resume question is
    // settled, the URL stays page-less, so a reload re-offers the pill.
    if (reportingArmed) q.set("page", String(currentPage));
    q.set("mode", st.mode);
    q.set("rtl", st.rtl ? "1" : "0");
    q.set("gap", String(st.gap));
    history.replaceState(null, "", `#/read?${q.toString()}`);
  }

  return teardown;
}
