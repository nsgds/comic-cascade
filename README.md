# Comic Cascade

A minimal, self-hosted comic & manga reader. Point it at a folder of comics and
read them in your browser — folder-tree browsing, a fast scrolling reader, and
nothing else getting in the way. No accounts, no database of your habits, no
tracking; it only ever reads your files.

> ⚠️ **Comic Cascade has no authentication of its own.** Don't expose it directly
> to the internet — put it behind your own reverse proxy / SSO. See
> [Security](#security).

## Features

- **File-explorer browsing** — your real folder and file names, as a lazy tree
  (no pre-scan of huge libraries, no metadata scraping).
- **Formats:** CBR (RAR), CBZ (Zip *and* 7-Zip-disguised), and PDF.
- **Multiple libraries**, optionally **add/removable from the UI** (see
  [CONFIG.md](CONFIG.md)).
- **A real reader:**
  - vertical (fit-width) and horizontal (fit-height) scroll modes, with an
    LTR/RTL reading direction;
  - virtualized — only the pages near the viewport are in the DOM, so a
    300-page comic stays light;
  - pages are **never upscaled** beyond their native resolution;
  - the first page sits flush against the reading edge; the counter follows the
    page crossing the centre;
  - page-jump (buttons + keyboard), adjustable page gap, fullscreen, an
    auto-hiding/pinnable toolbar, and a light/dark theme;
  - deep-linkable — the URL remembers your mode/direction/gap/page, so a refresh
    resumes exactly where you were.
- **Read-only & cache-light** — never writes to your library; extracts each comic
  once into an LRU-bounded disk cache.

## Quick start

### Docker Compose (recommended)

```bash
git clone <this-repo> comic-cascade && cd comic-cascade
# edit docker-compose.yml: point the ./comics volume at your comics folder
docker compose up -d
# open http://localhost:8080
```

With no config file, **every immediate subdirectory of `/libraries` becomes a
library** — so mounting `./comics:/libraries/comics:ro` gives you a "comics"
library. Add more `-v …:/libraries/<name>:ro` volumes for more libraries.

### Plain `docker run` (single folder)

```bash
docker build -t comic-cascade .
docker run -d -p 8080:8080 \
  -v /path/to/your/comics:/library:ro \
  -v cascade-cache:/cache \
  comic-cascade
```

A folder mounted at `/library` becomes one library named "Library" with zero
config.

## Configuration

Libraries, the cache, and optional in-UI library management are all configurable
via a TOML file or environment variables. Full reference: **[CONFIG.md](CONFIG.md)**.
The short version:

| Goal | How |
|---|---|
| One folder | mount it at `/library`, or set `CASCADE_LIBRARY=/path` |
| Several folders, auto-named | mount each under `/libraries/<name>` |
| Explicit names/paths | a [`cascade.toml`](cascade.example.toml) with `[[library]]` tables |
| Add/remove/reorder libraries in the UI | set `CASCADE_BROWSE_ROOT=/some/root` (off by default) |
| Cache size / location | `[cache]` in TOML or `CASCADE_CACHE_DIR` / `CASCADE_CACHE_BUDGET` |

## Reading

| Action | Control |
|---|---|
| Browse | click folders to expand; click a comic to open |
| Show/hide non-comic files | the "show all files" toggle (top bar) |
| Reading mode / direction | **Menu → Reading mode** (Vertical / L→R / R→L) |
| Next / previous page | the `‹ ›` buttons; arrow keys (←/→ in horizontal, ↑/↓ in vertical); Space / PageDown / PageUp (vertical); Home / End jump to first / last |
| Page gap, pin toolbar, fullscreen, theme | the **Menu** (and the `f` key for fullscreen) |
| Light / dark | the ☀/🌙 button (library) or **Menu → … mode** (reader) |

Zooming currently uses your browser's native pinch-zoom (works outside
fullscreen).

## Security

Comic Cascade ships **no authentication** — anyone who can reach the port can
read every configured library, and (if `CASCADE_BROWSE_ROOT` is set) browse that
root. That's intentional: auth is the deployer's job. **Do not expose it directly
to the internet.** Put it behind a reverse proxy that adds TLS + auth, e.g.:

```caddyfile
# Caddy — add your own auth (basic_auth, forward_auth to an SSO, etc.)
comics.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

```nginx
# nginx — front with auth_basic or auth_request
location / {
    proxy_pass http://127.0.0.1:8080;
    # auth_basic "Comics"; auth_basic_user_file /etc/nginx/.htpasswd;
}
```

The container runs as a **non-root** user (UID 1000). A fresh named volume mounted
at `/cache` inherits the right ownership automatically; if you **bind-mount** a host
directory for the cache instead, `chown 1000:1000` it (or set `user:` in compose to
match a UID that can read your libraries and write the cache). Hardening details and
known limitations are in [`SECURITY.md`](SECURITY.md).

## Development

The backend is FastAPI; the frontend is plain ES modules (**no build step**).

```bash
# Python tests (need `unar` on PATH for the CBR/7z extraction tests)
sudo apt-get install -y unar          # or: brew install unar
pip install -r requirements-dev.txt
pytest

# Frontend logic tests (Node 18+; package.json marks the ES modules)
node --test tests/js/

# Run locally without Docker (needs `unar` on PATH for CBR/7z)
pip install -r requirements.txt
CASCADE_LIBRARY=/path/to/comics CASCADE_CACHE_DIR=/tmp/cc-cache \
  uvicorn app.main:app --reload
```

## How it works

- **Backend** (`app/`): a small read-only FastAPI API. `/api/tree` lists one
  directory at a time; `/api/comic` extracts an archive once into a disk cache
  (content-sniffed and routed: PDF → pypdfium2, Zip → `zipfile` with an `unar`
  fallback, RAR/7z → `unar`) and returns
  per-page dimensions; `/api/page` serves the cached page images. An SQLite index
  drives LRU eviction. Path access is confined to the configured libraries.
- **Frontend** (`web/`): vanilla ES modules — a lazy file tree and the reader,
  whose virtualization and scroll hot paths are imperative DOM code with no
  framework re-renders.

## Dependencies & licensing

Comic Cascade is **0BSD** (do anything, no attribution required). Its Python
dependencies are permissive (FastAPI/MIT, uvicorn/BSD, Pillow, pypdfium2/Apache).
The Docker image bundles **`unar`** (The Unarchiver, LGPL/GPL) and
calls it as a **separate subprocess**, so its license does not affect this
project's — exactly like any Linux distro shipping GPL binaries.

## License

[0BSD](LICENSE) — Zero-Clause BSD.
