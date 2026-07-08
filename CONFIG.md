# Configuration reference

Everything is optional — with no config and a folder mounted at `/library` (or
subfolders under `/libraries`), Comic Cascade just works. Configure more via a
TOML file and/or environment variables.

Settings are read once at startup; **restart the container to apply a change.**

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
# user_header = "X-Remote-User"   # trust this proxy-set identity header (off by default)
# admins = ["alice", "bob"]       # only these users may manage libraries
# groups_header = "X-Remote-Groups"  # proxy-set groups header (off by default)
# admin_groups = ["admins"]       # users in any of these groups may manage libraries
# uid_header = "X-Remote-Uid"     # stable per-user id; keys reading progress (off by default)

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

### Restricting who can manage (optional)

By default, anyone who can reach the app (i.e. anyone your proxy lets through) can
manage libraries when a browse root is set. To limit management to specific **users
or groups**, tell Comic Cascade which headers your **forward-auth proxy** sets, and
list the admins. This works with any proxy that forwards identity headers — it is
not tied to a particular one:

| What your proxy sets | header (example) | groups header (example) |
|---|---|---|
| Authentik | `X-Authentik-Username` | `X-Authentik-Groups` |
| Authelia | `Remote-User` | `Remote-Groups` |
| oauth2-proxy | `X-Forwarded-User` | `X-Forwarded-Groups` |

- `CASCADE_USER_HEADER` — the header carrying the current username. The app does
  **no** login of its own; identity comes entirely from your proxy.
- `CASCADE_ADMINS` — comma-separated usernames allowed to manage. (Use the TOML
  `admins = ["a", "b"]` array for usernames containing commas.)
- `CASCADE_GROUPS_HEADER` — the header carrying the user's groups (the value may be
  `|`- or `,`-separated; both are handled).
- `CASCADE_ADMIN_GROUPS` — group names that grant management. A user in **any** of
  them may manage — handy for reusing your IdP's existing admin group instead of
  maintaining a username list.

A request may manage if its user is in `CASCADE_ADMINS` **or** any of its groups is
in `CASCADE_ADMIN_GROUPS`. Non-admins see no manage button and get a `403`; reading
and browsing stay open to all. Example (Authentik, gate on an "admins" group):

```
CASCADE_USER_HEADER=X-Authentik-Username
CASCADE_GROUPS_HEADER=X-Authentik-Groups
CASCADE_ADMIN_GROUPS=admins
```

All off by default. It **fails closed**: with an admin list set but no matching
identity/groups header reaching the app, nobody is an admin — so configure the
header(s) too. Libraries remain **global**; this only controls *who may edit them*.

> **Important:** an identity header is only as trustworthy as your setup. Your
> proxy must **set the header itself and strip any client-supplied copy**, and the
> app must be reachable **only** through that proxy. If a client can talk to the
> app directly, it can simply send the header and impersonate any user.

## Reading progress (read-resume)

Your position in each comic is always remembered **per device** in the browser's
`localStorage` — nothing to configure, works with zero identity. Reopening a
comic offers "Resume from p. N?", and the browse view shows a "Continue reading"
row. Finishing a comic forgets it (it reopens from the start).

If your proxy supplies an identity (`CASCADE_USER_HEADER`, above), progress is
**also stored server-side per user** (`<cache>/progress.db`), so your position
follows you across devices. This turns on automatically whenever a request
carries the identity header — there is no separate switch, and without identity
the app stores nothing. With identity, the browser-local copy is also
**partitioned per user** (via an opaque token, never the identity itself), so
accounts sharing one browser profile don't see each other's positions; without
identity, the local copy is per-browser — anyone using that browser shares it.

- `CASCADE_UID_HEADER` (optional) — a header carrying a **stable per-user id**
  (e.g. Authentik's `X-Authentik-Uid`). If set and present, it keys progress
  instead of the username, so renaming a user doesn't orphan their positions.
  Falls back to `CASCADE_USER_HEADER` when absent. Set it from day one if you
  can: uid- and username-keyed rows are separate namespaces, so **enabling it
  later re-keys everyone's progress** (existing positions start over).

The same trust warning as above applies: these headers must come from your
proxy, never from clients.

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
| `CASCADE_USER_HEADER` | Trusted proxy header carrying the current user (off by default) |
| `CASCADE_ADMINS` | Comma-separated allowlist of users who may manage libraries |
| `CASCADE_GROUPS_HEADER` | Trusted proxy header carrying the user's groups (off by default) |
| `CASCADE_ADMIN_GROUPS` | Comma-separated groups whose members may manage libraries |
| `CASCADE_UID_HEADER` | Trusted proxy header with a stable per-user id; keys reading progress (off by default) |
| `CASCADE_CACHE_DIR` | Cache directory (default `/cache`) |
| `CASCADE_CACHE_BUDGET` | Cache size budget in bytes |
| `CASCADE_EXTRACT_CONCURRENCY` | Max simultaneous archive extractions (default 2) |
| `CASCADE_MAX_ARCHIVE_BYTES` | Max uncompressed size per comic (default 4 GB) |
| `CASCADE_MAX_PDF_PAGES` | Max PDF pages rendered (default 3000) |

Environment variables override the corresponding TOML values.
