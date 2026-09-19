# Changelog

## 0.4.1 — 2026-09-19

- **Large PDFs open again.** Pages are now rendered at 144 DPI *or* whatever
  scale keeps them under a pixel budget (`max_page_pixels`, default 8 million),
  whichever is smaller. Print-resolution PDFs define pages tens of inches wide,
  where 144 DPI meant a 40–80 megapixel bitmap — hundreds of MB for a single
  page, which exhausted a memory-limited container mid-extraction and killed the
  server process. The reader saw that as a proxy `502` ("can't open this comic")
  with nothing in the app's log, since the process died before it could answer.
  Rendered pages stay around 2500×3300 — above what any screen or the reader's
  zoom can use.
- Each page's bitmap is released before the next is rendered, and the document
  itself is reopened periodically — pdfium keeps every parsed stream while a
  document is open, so peak memory otherwise tracked the *file's* size rather
  than the page budget. A 2 GB, 217-page book peaked at 1961 MB before and 692 MB
  after (and renders faster); a 161-page book that died at page 55 under a 1 GB
  limit now completes with a 445 MB peak.
- **PDF rendering is serialized.** pdfium is not thread-safe, and extracting two
  large PDFs at once could kill the whole process; other formats still extract
  concurrently.
- Half-written extraction directories left behind by a killed process are swept
  at startup. They were invisible to the cache index and never reclaimed.
- The per-comic byte cap (`max_archive_bytes`) now bounds **rendered PDF output**
  too, not just archive extraction.
- New setting: `[server] max_page_pixels` / `CASCADE_MAX_PAGE_PIXELS`. Existing
  cached comics are unaffected (the cache is not re-rendered).

## 0.4.0 — 2026-08-28

- **"Up next" end card** — scrolling past a comic's last page reveals a card
  offering the next comic in the same folder (or, on the folder's last comic,
  a jump back to the folder). It sits after the pages in the scroll flow, so
  it never covers the last page's art and needs no dismissing; pressing
  next-page on the last page brings it into view. Follows the server's
  natural sort, never crosses into other folders, and opens the next comic
  fresh so its own resume offer still works.
- **Finishing an issue no longer loses your place.** The "continue reading"
  chip now stays at the last page (✓-marked) — in a series, "at the end of
  issue N" *is* your place, and tapping the chip lands you back at the end of
  issue N, one scroll (or next-page press) from the end card offering
  issue N+1. The chip hands off automatically: once the next issue
  records a position of its own, the finished one is forgotten, so the row
  tracks your frontier per series instead of accumulating a history. Backing
  out of the next issue before reading anything keeps the previous chip.
- **Back returns to your place** — the reader's Back button (and a failed
  comic's error screen) now deep-links to the comic's folder: the tree
  auto-expands along the path and the comic's row is highlighted and centered,
  instead of resetting to a collapsed root. Browse locations are shareable the
  same way (`#/?lib=…&sel=…`).
- **The top bar and "Continue reading" row stay pinned** while the library
  tree scrolls. (The top bar was always meant to — `body { height: 100% }`
  capped its sticky range at one screenful; it is `min-height` now.)
- **The reader's ⋯ menu shows the current filename** (and its folder) at the
  top, so you can check what you're reading without adding anything to the
  toolbar. Long names scroll horizontally in place — the menu never grows or
  wraps to fit them.
- Hardening out of a multi-agent adversarial review of the release diff: a
  `#/read` URL missing its path param degrades to the 404 error screen again
  instead of crashing the reader; the edge-pinned page detection keys on the
  pages' end rather than max-scroll, so a drag toward the end card can never
  flip the committed last page back to its neighbour (or re-record over a
  fresh finish); `--topbar-h` publishes the exact fractional bar height.
- Tests: 65 pytest + 71 node — new suites for the layout tail (and the
  `pagesEnd` detection-guard contract), the browse deep-link reveal rule,
  the next-comic sibling lookup, and the rewritten progress write policy.

## 0.3.0 — 2026-08-17

- **Pinch-zoom in the reader** — the long-standing gap: the Fullscreen API
  disables the browser's native page zoom. Pinch out on a page (or double-tap;
  double-click / Ctrl-scroll on desktop; `+` key) to zoom, up to the larger of
  3× and the image's native resolution; drag, plain scroll or a pinch to
  pan/adjust; pinch back to fit — or double-tap, Escape or `0` — to click back
  into normal scrolling exactly where you were. Works in and out of
  fullscreen, anchors to the page under your fingers (not just the "current"
  page), and pans with a tapered slack margin so a panel at the page's rim can
  be pulled toward the middle of the screen. Layout still never upscales;
  explicit zoom may.
- Architecturally the zoom is an overlay BESIDE the virtualized reader (the
  scroll state is frozen and restored by construction, never transformed), with
  input unified across touch pointers, trackpad ctrl-wheel and double-tap. The
  touch strategy is device-verified against Android Chrome's gesture stealing
  (per-gesture `preventDefault` plus a reading-view viewport lock; the
  browser's accessibility "force enable zoom" override is tolerated
  gracefully). Details in OVERVIEW.md §8.
- **OVERVIEW.md** — a reviewer-facing architecture map of the whole project,
  kept in sync with code by contract stated in its header.
- The machine-specific compose override is now gitignored, keeping the
  published repo host-agnostic.
- Pillow bumped to 12.3.0 — image-decoding CVE fixes (flagged by pip-audit /
  Dependabot; Pillow decodes untrusted comic pages here, so these are squarely
  in this app's threat model).
- Tests: 65 pytest + 56 node — new suites for the zoom transform math
  (mutation-hardened focal-invariant tests), the gesture pointer reducer, and
  the DOM gesture adapter driven through a real EventTarget.

## 0.2.0 — 2026-07-08

- **Multi-user management authorization** (optional, off by default): trust a
  forward-auth proxy's identity/groups headers (`CASCADE_USER_HEADER`,
  `CASCADE_GROUPS_HEADER`) and restrict library management to listed users
  (`CASCADE_ADMINS`) and/or groups (`CASCADE_ADMIN_GROUPS`). Fails closed;
  reading stays open to all; without configuration, behavior is unchanged.
- **Read-resume**: per-comic reading positions with an ask-first "Resume from
  p. N?" pill in the reader and a "Continue reading" row (text chips) above the
  tree. Always works per-device via `localStorage`; when the proxy supplies an
  identity, positions are also stored server-side per user
  (`<cache>/progress.db`) and follow you across devices. Optional
  `CASCADE_UID_HEADER` keys progress by a stable id so renames don't orphan it.
  Finishing a comic (or dismissing its chip) forgets its position, and the
  forget propagates across devices (page-0 tombstones that shadow stale local
  copies in the merge). With identity, browser-local positions are partitioned
  per user (opaque scope token), so accounts sharing one browser profile don't
  see each other's positions. New endpoints:
  `GET/POST/DELETE /api/progress`, `GET /api/progress/recent` — the user is
  always derived server-side from trusted headers, never from a request
  parameter.

## 0.1.0 — 2026-06-14

Initial self-hostable release.

- **Browse** comic folders as a lazy file tree (real folder/file names), with a
  show/hide toggle for non-comic files.
- **Formats:** CBR (RAR), CBZ (Zip and 7-Zip-disguised), PDF.
- **Multiple libraries** via TOML / env / `/libraries` auto-scan / `/library`,
  with optional **add, remove, and drag-and-drop reorder** (or keyboard ↑/↓)
  **from the UI** (behind a configured browse root); the library order sets the
  order of the picker.
- **Reader:** vertical (fit-width) and horizontal (fit-height) scroll modes with
  LTR/RTL; viewport-window virtualization (only near-viewport pages in the DOM);
  never upscales; forward-edge first-page
  alignment with centre-line page counter; page-jump (buttons + keyboard);
  adjustable gap; fullscreen; pinnable/auto-hiding toolbar; light/dark theme
  (pure-black / pure-white reading canvas); URL deep-link / refresh-resume.
- **Read-only** on your library; extract-once **disk cache** with LRU eviction.
- No accounts, no auth (deploy behind your own proxy), no tracking.
- **Hardened for untrusted comic files:** path/symlink confinement, Zip-Slip-safe
  extraction, decompression-bomb + PDF-page caps (`max_archive_bytes` /
  `max_pdf_pages`), safe `unar` invocation, sanitized errors, a path-free
  `/api/healthz`, `nosniff`, pinned deps, and a non-root container. See
  [`SECURITY.md`](SECURITY.md).
