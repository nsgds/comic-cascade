# Configuration reference

Everything is optional — with no config and a folder mounted at `/library` (or
subfolders under `/libraries`), Comic Cascade just works. Configure more via a
TOML file and/or environment variables.

## Libraries

A "library" is a root folder Comic Cascade browses. Libraries are resolved in
this order — **the first source that yields any library wins**:

1. **TOML config file** with `[[library]]` tables (see below). The file is found
   at `$CASCADE_CONFIG`, or the first of `./cascade.toml`, `/app/cascade.toml`,
   `/config/cascade.toml`.
2. **`$CASCADE_LIBRARY`** — a single library named "Library" at that path.
3. **`/libraries/*`** (override the parent with `$CASCADE_LIBRARIES_DIR`) — every
   immediate subdirectory becomes a library named after the folder.
4. **`/library`** — a single folder mounted here becomes one library named
   "Library".

All library paths are mounted **read-only**; Comic Cascade never writes into them.

### Example `cascade.toml`

```toml
[[library]]
name = "Comics"
path = "/libraries/comics"

[[library]]
name = "Manga"
path = "/libraries/manga"

[cache]
dir = "/cache"
budget_bytes = 6_000_000_000   # ~6 GB soft cap; LRU-evicted past this

[server]
extract_concurrency = 2          # max archives extracted at once
max_archive_bytes = 4_000_000_000  # reject a comic that unpacks past this (bomb guard)
max_pdf_pages = 3000             # refuse to render PDFs longer than this

[browse]
root = "/libraries"            # enables UI library management (see below)
```

Mount it into the container: `-v ./cascade.toml:/app/cascade.toml:ro`.

## UI library management

If — and only if — a **browse root** is configured, the UI gains a directory
picker to **add and remove libraries** (persisted to `<cache>/libraries.json`,
seeded once from the static config). The picker is confined to the browse root.

- Enable with `[browse] root = "/path"` in TOML, or `CASCADE_BROWSE_ROOT=/path`.
- **Off by default** — without it, libraries are fixed by the config above. Keep
  it off for unauthenticated installs; the picker exposes that root's directory
  structure to anyone who can reach the app.
- Docker reality: the picker can only reach folders **already mounted** into the
  container, so it's bounded by what you mount under the browse root.

## Cache

Extracted pages are cached on disk and evicted least-recently-read once over the
budget. Use a real disk volume, **not tmpfs** (it would count against RAM).

| Setting | TOML | Env | Default |
|---|---|---|---|
| Cache directory | `[cache] dir` | `CASCADE_CACHE_DIR` | `/cache` |
| Size budget (bytes) | `[cache] budget_bytes` | `CASCADE_CACHE_BUDGET` | `6000000000` |

## Extraction limits

Defenses against malicious or pathological comic files (decompression bombs,
absurdly long PDFs). A comic that exceeds these is rejected with a `422`.

| Setting | TOML | Env | Default |
|---|---|---|---|
| Max uncompressed bytes per comic | `[server] max_archive_bytes` | `CASCADE_MAX_ARCHIVE_BYTES` | `4000000000` |
| Max PDF pages rendered | `[server] max_pdf_pages` | `CASCADE_MAX_PDF_PAGES` | `3000` |

## Environment variables (summary)

| Variable | Purpose |
|---|---|
| `CASCADE_CONFIG` | Path to the TOML config file |
| `CASCADE_LIBRARY` | Single library path (named "Library") |
| `CASCADE_LIBRARIES_DIR` | Parent dir to auto-scan for libraries (default `/libraries`) |
| `CASCADE_BROWSE_ROOT` | Enables + bounds UI library management |
| `CASCADE_CACHE_DIR` | Cache directory (default `/cache`) |
| `CASCADE_CACHE_BUDGET` | Cache size budget in bytes |
| `CASCADE_EXTRACT_CONCURRENCY` | Max simultaneous archive extractions (default 2) |
| `CASCADE_MAX_ARCHIVE_BYTES` | Max uncompressed size per comic (default 4 GB) |
| `CASCADE_MAX_PDF_PAGES` | Max PDF pages rendered (default 3000) |

Environment variables override the corresponding TOML values.
