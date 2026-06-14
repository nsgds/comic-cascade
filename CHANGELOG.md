# Changelog

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
