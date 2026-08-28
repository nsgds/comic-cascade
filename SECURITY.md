# Security

## Reporting a vulnerability

Please report security issues privately via **GitHub Security Advisories**
("Report a vulnerability" on the repository's Security tab) rather than a public
issue. You'll get a response as soon as is practical for a hobby project.

## Threat model

Comic Cascade is a **read-only** comic reader with **no built-in authentication —
by design**. It binds a port and expects to be fronted by your own reverse proxy
/ SSO if you need access control (see the README "Security" section). "Add
authentication" is therefore intentionally out of scope for the app itself.

What the app *does* defend against — even for an allowed/LAN user, and for an
**untrusted comic file** placed in a library (e.g. on a shared NAS):

- **Path traversal** — every library/path is resolved and confined to its root
  (`app/paths.py`); requests can't read files outside the configured libraries.
- **Zip-Slip** — extracted pages are written by index (`00000.jpg` …), never using
  archive-internal names as output paths.
- **Symlink smuggling** — symlinks inside a RAR/7z are never followed or served;
  only regular files that resolve *inside* the extraction dir are used.
- **Decompression bombs** — extraction is capped by `max_archive_bytes` (total
  uncompressed) and PDFs by `max_pdf_pages`; oversized comics are rejected `422`.
- **Command injection** — `unar` is run with an argument list (never a shell) and a
  `--` end-of-options separator; a single output file is size-limited via `RLIMIT_FSIZE`.
- **SQL injection** — all queries against the cache index and the per-user
  progress store are parameterized.
- **Info disclosure** — `/api/healthz` reports readiness only (no host paths) and
  extraction errors are logged server-side, not returned to clients.
- **Container** — the image runs as a non-root user; responses send
  `X-Content-Type-Options: nosniff`.

## Proxy-trusted identity (optional)

`CASCADE_USER_HEADER` + `CASCADE_ADMINS` (and/or `CASCADE_GROUPS_HEADER` +
`CASCADE_ADMIN_GROUPS`) let you restrict library management to named users or
groups, using an identity your forward-auth proxy injects. The app performs **no**
authentication itself — it trusts the header(s). That trust is only valid if
your proxy **sets the header and strips any client-supplied copy**, and the app is
reachable **only** through the proxy. Exposed directly, the header is trivially
spoofable. Unset by default (anonymous/global). It gates *management only* —
reading is always open — and fails closed (no recognized identity ⇒ not an admin).

The same trusted headers (plus the optional `CASCADE_UID_HEADER`) also key
**per-user reading progress** (`/api/progress*`), so the spoofing caveat covers
progress privacy too: reachable without the proxy, a forged header can read or
overwrite another user's reading positions. The progress user is always derived
server-side from these headers, never accepted as a request parameter.

## Known limitations

- **Cache eviction race:** under heavy concurrent extraction pressure, an archive
  being streamed by an in-flight `/api/page` request can be evicted, yielding a
  retriable error for that page (no data loss). A simple retry succeeds.
- **Decompression-bomb residual (many tiny files):** the per-comic byte cap plus a
  512 MB free-space floor bound disk use, but a pathological many-files archive may
  briefly consume disk before being rolled back.
- **Directory picker exposure:** when `CASCADE_BROWSE_ROOT` is set (UI library
  management), the picker exposes that root's directory structure to anyone who can
  reach the app — unless management is restricted via `CASCADE_ADMINS` /
  `CASCADE_ADMIN_GROUPS` (see Proxy-trusted identity above), which also gates the
  picker (403). Keep it unset — or set an admin allowlist — for unauthenticated
  installs.

## Supported versions

Security fixes target the latest release.
