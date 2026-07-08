# Changelog

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
