"""Comic Cascade FastAPI application.

Read-only API (all GET) plus the static frontend. Routes are registered before the
catch-all static mount so ``/api/*`` always takes precedence over ``index.html``.
"""

from __future__ import annotations

import hashlib
import logging
import os
import shutil
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import __version__
from .archives import ArchiveError
from .auth import can_manage, current_user, user_groups
from .cache import ArchiveCache
from .config import get_config
from .libraries import InvalidLibrary, ManagementDisabled, store
from .paths import get_library, safe_resolve
from .progress import RECENT_LIMIT, ProgressStore
from .util import ext_of, is_comic, natural_sort_key

log = logging.getLogger("cascade")

_cfg = get_config()
# Optional proxy-identity gating for library management (see app/auth.py).
USER_HEADER = _cfg.user_header
ADMINS = _cfg.admins
GROUPS_HEADER = _cfg.groups_header
ADMIN_GROUPS = _cfg.admin_groups
# Optional stable per-user id header for read-progress (falls back to the username).
UID_HEADER = _cfg.uid_header


def _progress_user(request: Request) -> str | None:
    """The key that owns this request's reading progress, or None when the server
    tier is off (no identity configured or asserted). Prefers the stable uid header
    over the username so a rename doesn't orphan progress. ALWAYS derived
    server-side — never a request parameter — so one user can't address another's.

    Keys are tier-prefixed ("uid:…" / "user:…") so a username can never collide
    with another user's uid (some IdPs hand out short/numeric uids). Consequence:
    turning CASCADE_UID_HEADER on later re-keys progress (documented in CONFIG.md)."""
    uid = current_user(request, UID_HEADER)
    if uid is not None:
        return f"uid:{uid}"
    name = current_user(request, USER_HEADER)
    return f"user:{name}" if name is not None else None


def _can_manage(request: Request) -> bool:
    """Whether this request is allowed to manage libraries (by user or by group)."""
    return can_manage(
        current_user(request, USER_HEADER),
        managed=store.managed,
        admins=ADMINS,
        groups=user_groups(request, GROUPS_HEADER),
        admin_groups=ADMIN_GROUPS,
    )


def _require_manage(request: Request) -> None:
    """403 unless this request is allowed to manage libraries."""
    if not store.managed:
        raise HTTPException(status_code=403, detail="library management is disabled")
    if not _can_manage(request):
        raise HTTPException(status_code=403, detail="not authorized to manage libraries")

CACHE = ArchiveCache(
    _cfg.cache_dir,
    _cfg.budget_bytes,
    _cfg.extract_concurrency,
    max_archive_bytes=_cfg.max_archive_bytes,
    max_pdf_pages=_cfg.max_pdf_pages,
)

PROGRESS = ProgressStore(_cfg.cache_dir / "progress.db")

_MEDIA_TYPES = {
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "png": "image/png",
    "gif": "image/gif",
    "webp": "image/webp",
    "bmp": "image/bmp",
    "avif": "image/avif",
}

try:  # PDF support is optional at runtime; report it in healthz.
    import pypdfium2  # noqa: F401

    HAS_PDFIUM = True
except Exception:  # pragma: no cover - import guard
    HAS_PDFIUM = False

WEB_DIR = Path(__file__).resolve().parent.parent / "web"

app = FastAPI(title="Comic Cascade", version=__version__)


@app.middleware("http")
async def revalidate_static(request, call_next):
    """Make the browser revalidate the frontend (HTML/JS/CSS) on every load so a
    deploy shows up on a normal refresh — no hard-refresh needed. Page images
    (/api/page) keep their own immutable caching; other /api/* is left untouched."""
    response = await call_next(request)
    path = request.url.path
    if not path.startswith("/api/") and "cache-control" not in response.headers:
        response.headers["Cache-Control"] = "no-cache"
    # Never let a browser MIME-sniff served bytes into something executable.
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    return response


class AddLibrary(BaseModel):
    name: str = ""
    path: str


class ReorderLibraries(BaseModel):
    order: list[str]


@app.get("/api/libraries")
def list_libraries(request: Request) -> dict:
    user = _progress_user(request)
    return {
        "libraries": [{"id": lib.id, "name": lib.name} for lib in store.libraries()],
        "managed": store.managed,
        "can_manage": _can_manage(request),
        # True when THIS request carries a proxy identity => server-side read
        # progress is available; the client falls back to localStorage otherwise.
        "progress": user is not None,
        # Opaque per-user token the client uses to PARTITION its localStorage
        # progress, so two accounts sharing one browser profile don't see each
        # other's local chips. A short hash, not the identity itself — nothing
        # about the user needs to live in storage keys.
        "progress_scope": hashlib.sha256(user.encode()).hexdigest()[:16] if user else None,
    }


@app.post("/api/libraries")
def add_library(body: AddLibrary, request: Request) -> dict:
    _require_manage(request)
    try:
        lib = store.add(body.name, body.path)
    except ManagementDisabled:
        raise HTTPException(status_code=403, detail="library management is disabled")
    except InvalidLibrary as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"id": lib.id, "name": lib.name}


@app.delete("/api/libraries/{library_id}")
def remove_library(library_id: str, request: Request) -> dict:
    _require_manage(request)
    try:
        removed = store.remove(library_id)
    except ManagementDisabled:
        raise HTTPException(status_code=403, detail="library management is disabled")
    if not removed:
        raise HTTPException(status_code=404, detail="unknown library")
    return {"removed": library_id}


@app.put("/api/libraries/order")
def reorder_libraries(body: ReorderLibraries, request: Request) -> dict:
    _require_manage(request)
    try:
        store.reorder(body.order)
    except ManagementDisabled:
        raise HTTPException(status_code=403, detail="library management is disabled")
    return {"order": [lib.id for lib in store.libraries()]}


@app.get("/api/fs")
def browse_fs(request: Request, path: str = "") -> dict:
    """List immediate subdirectories under the browse root (for the add-library
    directory picker). Confined to the browse root; 403 unless allowed to manage."""
    _require_manage(request)
    try:
        return store.list_subdirs(path)
    except ManagementDisabled:
        raise HTTPException(status_code=403, detail="library management is disabled")
    except InvalidLibrary as exc:
        raise HTTPException(status_code=404, detail=str(exc))


# ---- per-user reading progress (server tier of read-resume) -----------------
#
# Only live when the request carries a proxy identity (see _progress_user);
# without one, every endpoint below is a harmless no-op so an unconfigured
# deployment behaves exactly as before (the client keeps its localStorage tier).
# The user key is always derived server-side from trusted headers — it is never
# accepted as a request parameter, so no request can address another user's rows.


class ProgressUpdate(BaseModel):
    library: str
    path: str
    page: int
    total: int


# Sanity caps: progress keys are stored verbatim, so bound what a request may
# persist (a library id is a short slug; no sane comic path approaches 1 KiB).
_MAX_LIBRARY_LEN = 200
_MAX_PATH_LEN = 1024
# Rows scanned per recent() call: enough to find RECENT_LIMIT visible entries
# even when the newest rows are hidden (their library is currently missing).
_RECENT_SCAN = 100


def _progress_key(library: str, path: str) -> str:
    """The CANONICAL relative path used to key a progress row.

    Resolves the request path inside the library (404s escapes/unknown libraries,
    like every other endpoint) and re-derives the relative path from the result,
    so alias spellings ("./a.cbz", "x/../a.cbz") collapse into ONE row per comic —
    a user cannot grow the store, or fill their continue-reading row, with
    variants of the same file."""
    if len(library) > _MAX_LIBRARY_LEN or len(path) > _MAX_PATH_LEN:
        raise HTTPException(status_code=400, detail="library/path too long")
    target = safe_resolve(library, path)
    root = get_library(library).path.resolve()
    return target.relative_to(root).as_posix() if target != root else ""


@app.get("/api/progress")
def get_progress(request: Request, library: str, path: str) -> dict:
    """This user's saved position for one comic (or null)."""
    user = _progress_user(request)
    if user is None:
        return {"position": None}
    return {"position": PROGRESS.get(user, library, _progress_key(library, path))}


@app.post("/api/progress", status_code=204)
def set_progress(body: ProgressUpdate, request: Request) -> None:
    """Upsert this user's position. 204 on success; a no-op (also 204) without an
    identity. Invalid input still 400/404s — sendBeacon callers never read the
    response, so nothing depends on the code."""
    user = _progress_user(request)
    if user is None:
        return  # server tier off: silently inert, client owns localStorage
    if not (0 <= body.page < body.total <= 100_000):
        raise HTTPException(status_code=400, detail="invalid page/total")
    rel = _progress_key(body.library, body.path)
    src = safe_resolve(body.library, rel)
    if not src.is_file() or not is_comic(src.name):
        raise HTTPException(status_code=404, detail="not found")
    PROGRESS.upsert(user, body.library, rel, body.page, body.total)


@app.delete("/api/progress", status_code=204)
def delete_progress(request: Request, library: str, path: str) -> None:
    """Forget this user's position (finished the comic, or dismissed the chip).

    Deliberately does NOT require the library/path to still resolve: deletion only
    touches this user's own row, and requiring resolution would make rows for a
    since-removed library immortal."""
    user = _progress_user(request)
    if user is None:
        return
    if len(library) > _MAX_LIBRARY_LEN or len(path) > _MAX_PATH_LEN:
        raise HTTPException(status_code=400, detail="library/path too long")
    try:
        rel = _progress_key(library, path)
    except HTTPException:
        rel = path  # library gone / unresolvable: the row (if any) is keyed raw
    PROGRESS.delete(user, library, rel)


@app.get("/api/progress/recent")
def recent_progress(request: Request) -> dict:
    """This user's in-progress comics, newest first (the "continue reading" row).

    Rows whose comic has been deleted are pruned; rows whose whole library is
    missing — or that hit any filesystem error (NFS hiccup, permissions) — are
    hidden but KEPT: a transient failure must never destroy a reading position.
    Scans past hidden rows (up to _RECENT_SCAN) so a batch of newest-but-hidden
    rows can't starve the row of perfectly valid older entries.

    The response also carries this user's page-0 TOMBSTONES (forgets): the client
    merges them so a forget on one device shadows every other device's stale
    localStorage copy. They are shadows, not positions — no file validation, and
    the client filters them out of the visible row after the merge."""
    user = _progress_user(request)
    if user is None:
        return {"items": []}
    items: list[dict] = []
    for row in PROGRESS.recent(user, limit=_RECENT_SCAN):
        if len(items) >= RECENT_LIMIT:
            break
        lib = store.by_id(row["library"])
        if lib is None:
            continue  # library may come back — hide, keep
        try:
            exists = safe_resolve(row["library"], row["path"]).is_file()
        except (HTTPException, OSError):
            continue  # unresolvable or transient I/O error — hide, keep
        if not exists:
            try:
                root_ok = lib.path.is_dir()
            except OSError:
                root_ok = False
            if root_ok:  # library root reachable => the comic itself is gone
                PROGRESS.delete(user, row["library"], row["path"])
            continue
        items.append(row)
    return {"items": items + PROGRESS.tombstones(user)}


@app.get("/api/tree")
def tree(
    library: str,
    path: str = "",
    show_all: bool = Query(False),
) -> dict:
    """List the immediate children of one directory (never recurses).

    Folders are returned first, then files, each natural-sorted. Non-comic files
    are omitted unless ``show_all`` is set. Hidden entries (dotfiles) are always
    omitted.
    """
    target = safe_resolve(library, path)
    if not target.is_dir():
        raise HTTPException(status_code=404, detail="not a directory")

    dirs: list[dict] = []
    files: list[dict] = []
    with os.scandir(target) as it:
        for entry in it:
            name = entry.name
            if name.startswith("."):
                continue
            try:
                if entry.is_dir():
                    dirs.append({"name": name, "type": "dir"})
                    continue
            except OSError:
                continue
            if is_comic(name):
                files.append({"name": name, "type": "comic", "ext": ext_of(name)})
            elif show_all:
                files.append({"name": name, "type": "other", "ext": ext_of(name)})

    dirs.sort(key=lambda e: natural_sort_key(e["name"]))
    files.sort(key=lambda e: natural_sort_key(e["name"]))
    return {"library": library, "path": path, "entries": dirs + files}


@app.get("/api/comic")
async def comic(library: str, path: str) -> dict:
    """Metadata for one comic: page count + per-page dimensions. Triggers
    extraction (and caching) on first access."""
    src = safe_resolve(library, path)
    if not src.is_file():
        raise HTTPException(status_code=404, detail="not found")
    if not is_comic(src.name):
        raise HTTPException(status_code=400, detail="not a comic")
    try:
        _, meta = await CACHE.get_comic(library, path, src)
    except ArchiveError as exc:
        log.warning("comic extraction failed for %s:%s — %s", library, path, exc)
        raise HTTPException(status_code=422, detail="could not open this comic")
    return {
        "library": library,
        "path": path,
        "format": meta["format"],
        "page_count": len(meta["pages"]),
        "dims": meta["dims"],
    }


@app.get("/api/page")
async def page(library: str, path: str, index: int) -> FileResponse:
    """Serve a single page image (original bytes / rendered PDF page)."""
    src = safe_resolve(library, path)
    if not src.is_file():
        raise HTTPException(status_code=404, detail="not found")
    try:
        h, meta = await CACHE.get_comic(library, path, src)
    except ArchiveError as exc:
        log.warning("page extraction failed for %s:%s — %s", library, path, exc)
        raise HTTPException(status_code=422, detail="could not open this comic")
    pages = meta["pages"]
    if index < 0 or index >= len(pages):
        raise HTTPException(status_code=404, detail="page out of range")
    fpath = CACHE.page_path(h, pages[index])
    media = _MEDIA_TYPES.get(ext_of(pages[index]), "application/octet-stream")
    return FileResponse(
        fpath,
        media_type=media,
        headers={
            "Cache-Control": "public, max-age=31536000, immutable",
            "ETag": f'"{h}-{index}"',
        },
    )


@app.get("/api/healthz")
def healthz() -> dict:
    cfg = get_config()

    # Report readiness only — absolute host paths are deliberately NOT exposed.
    libraries = [
        {
            "id": lib.id,
            "name": lib.name,
            "readable": lib.path.is_dir() and os.access(lib.path, os.R_OK),
        }
        for lib in store.libraries()
    ]

    cache_writable = False
    try:
        cfg.cache_dir.mkdir(parents=True, exist_ok=True)
        cache_writable = os.access(cfg.cache_dir, os.W_OK)
    except OSError:
        cache_writable = False

    has_unar = shutil.which("unar") is not None
    all_libs_ok = bool(libraries) and all(item["readable"] for item in libraries)
    ok = has_unar and HAS_PDFIUM and cache_writable and all_libs_ok

    return {
        "status": "ok" if ok else "degraded",
        "version": __version__,
        "unar": has_unar,
        "pypdfium2": HAS_PDFIUM,
        "cache_writable": cache_writable,
        "libraries": libraries,
    }


# Static frontend (mounted last so it does not shadow the API routes above).
app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
