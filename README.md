# Comic Cascade

A minimal, self-hosted comic & manga reader. Point it at a folder of comics and
read them in your browser as **one smooth, endless scroll** — no page-flipping,
no apps, nothing between you and the pages. No accounts and no tracking: the
only thing it ever records is your own reading position.

> ⚠️ **Comic Cascade has no authentication of its own.** Don't expose it directly
> to the internet — put it behind your own reverse proxy / SSO. See
> [Security](#security).

## Features

- **An endless-scroll reader.** A comic is one continuous strip, not a stack of
  pages to flip through:
  - **Vertical** (fit-width) — the whole comic reads like a webtoon: scroll it
    the way you scroll a web page.
  - **Horizontal** (fit-height) — a filmstrip running **left-to-right** or
    **right-to-left** (manga), scrolled or paged sideways.
  - **Virtualized** — only the pages near the viewport are in the DOM, so a
    300-page comic scrolls as lightly as a 10-page one.
  - Pages are **never upscaled** beyond their native resolution; the first page
    sits flush against the reading edge; the counter follows the page crossing
    the centre line.
  - Page-jump buttons and full keyboard navigation, adjustable page gap,
    fullscreen, an auto-hiding/pinnable toolbar, and a light/dark theme.
  - **Deep-linkable** — the URL carries your mode/direction/gap/page, so a
    refresh (or a shared link) lands exactly where you were.
- **Read-resume** — reopening a comic offers "Resume from p. N?", and a
  "Continue reading" row above the tree jumps you back in with one tap. Works
  per-device out of the box (localStorage); with a reverse proxy that forwards
  identity, positions follow you **across devices** (see
  [CONFIG.md](CONFIG.md#reading-progress-read-resume)). Finishing a comic
  forgets it.
- **File-explorer browsing** — your real folder and file names, as a lazy tree
  (no pre-scan of huge libraries, no metadata scraping, no renaming).
- **Formats:** CBR (RAR), CBZ (Zip *and* 7-Zip-disguised), and PDF.
- **Multiple libraries**, optionally **add/removable from the UI** (see
  [CONFIG.md](CONFIG.md)).
- **Optional multi-user authorization** — behind a forward-auth proxy
  (Authentik, Authelia, oauth2-proxy, …), library management can be restricted
  to specific users or IdP groups, and reading positions become per-user. No
  app accounts, ever; identity comes entirely from your proxy.
- **Read-only & cache-light** — never writes to your library; extracts each
  comic once into an LRU-bounded disk cache.

## Quick start

### Docker Compose (recommended)

```bash
git clone <this-repo> comic-cascade && cd comic-cascade
# edit docker-compose.yml: point the ./comics volume at your comics folder
docker compose up -d
# open http://localhost:8080
```

**Choosing your comic folders = choosing your mounts.** With no config file,
every immediate subdirectory of `/libraries` becomes a library — so mounting
`./comics:/libraries/comics:ro` gives you a "comics" library, and each extra
`-v …:/libraries/<name>:ro` line adds another. (Prefer picking folders in the
UI? See [UI library management](CONFIG.md#ui-library-management).)

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

Libraries, the cache, in-UI library management, and the optional proxy-identity
features are all configurable via a TOML file or environment variables. Full
reference: **[CONFIG.md](CONFIG.md)**. The short version:

| Goal | How |
|---|---|
| One folder | mount it at `/library`, or set `CASCADE_LIBRARY=/path` |
| Several folders, auto-named | mount each under `/libraries/<name>` |
| Explicit names/paths | a [`cascade.toml`](cascade.example.toml) with `[[library]]` tables |
| Add/remove/reorder libraries in the UI | set `CASCADE_BROWSE_ROOT=/some/root` (off by default) |
| Restrict who may manage libraries | identity headers + `CASCADE_ADMINS` / `CASCADE_ADMIN_GROUPS` |
| Cross-device read-resume | identity headers (`CASCADE_USER_HEADER`, optionally `CASCADE_UID_HEADER`) |
| Cache size / location | `[cache]` in TOML or `CASCADE_CACHE_DIR` / `CASCADE_CACHE_BUDGET` |

## Reading

| Action | Control |
|---|---|
| Browse | click folders to expand; click a comic to open |
| Show/hide non-comic files | the "show all files" toggle (top bar) |
| Reading mode / direction | **Menu → Reading mode** (Vertical / L→R / R→L) |
| Next / previous page | the `‹ ›` buttons; arrow keys (←/→ in horizontal, ↑/↓ in vertical); Space / PageDown / PageUp (vertical); Home / End jump to first / last |
| Resume where you left off | the "Continue reading" row, or the "Resume from p. N?" pill on reopening |
| Page gap, pin toolbar, fullscreen, theme | the **Menu** (and the `f` key for fullscreen) |
| Light / dark | the ☀/🌙 button (library) or **Menu → … mode** (reader) |

Zooming currently uses your browser's native pinch-zoom (works outside
fullscreen).

## Security

Comic Cascade ships **no authentication** — anyone who can reach the port can
read every configured library. That's intentional: auth is the deployer's job.
**Do not expose it directly to the internet.** Put it behind a reverse proxy
that adds TLS + auth, e.g.:

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

If your proxy is a **forward-auth gate** that sets identity headers, Comic
Cascade can additionally restrict *library management* to specific users or
groups, and store reading positions per user — see
[CONFIG.md](CONFIG.md#restricting-who-can-manage-optional). The headers are only
as trustworthy as your setup: the proxy must set them itself, strip any
client-supplied copies, and be the only way to reach the app.

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

- **Backend** (`app/`): a small FastAPI API. `/api/tree` lists one directory at
  a time; `/api/comic` extracts an archive once into a disk cache
  (content-sniffed and routed: PDF → pypdfium2, Zip → `zipfile` with an `unar`
  fallback, RAR/7z → `unar`) and returns per-page dimensions; `/api/page` serves
  the cached page images. An SQLite index drives LRU eviction; a second small
  SQLite store holds per-user reading positions when the proxy supplies an
  identity. Path access is confined to the configured libraries.
- **Frontend** (`web/`): vanilla ES modules — a lazy file tree and the reader.
  The endless scroll is a virtualizer over absolutely-positioned pages computed
  from their real dimensions; the scroll hot paths are imperative DOM code with
  no framework re-renders. Reading positions live in a small two-tier store
  (localStorage always; mirrored to the server when identity is present).

## Dependencies & licensing

Comic Cascade is **0BSD** (do anything, no attribution required). Its Python
dependencies are permissive (FastAPI/MIT, uvicorn/BSD, Pillow, pypdfium2/Apache).
The Docker image bundles **`unar`** (The Unarchiver, LGPL/GPL) and
calls it as a **separate subprocess**, so its license does not affect this
project's — exactly like any Linux distro shipping GPL binaries.

## License

[0BSD](LICENSE) — Zero-Clause BSD.
