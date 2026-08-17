# Changelog

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
