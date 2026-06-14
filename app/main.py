"""Comic Cascade FastAPI application.

Read-only API (all GET) plus the static frontend. Routes are registered before the
catch-all static mount so ``/api/*`` always takes precedence over ``index.html``.
"""

from __future__ import annotations

import logging
import os
import shutil
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import __version__
from .archives import ArchiveError
from .cache import ArchiveCache
from .config import get_config
from .libraries import InvalidLibrary, ManagementDisabled, store
from .paths import safe_resolve
from .util import ext_of, is_comic, natural_sort_key

log = logging.getLogger("cascade")

_cfg = get_config()
CACHE = ArchiveCache(
    _cfg.cache_dir,
    _cfg.budget_bytes,
    _cfg.extract_concurrency,
    max_archive_bytes=_cfg.max_archive_bytes,
    max_pdf_pages=_cfg.max_pdf_pages,
)

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
def list_libraries() -> dict:
    return {
        "libraries": [{"id": lib.id, "name": lib.name} for lib in store.libraries()],
        "managed": store.managed,
    }


@app.post("/api/libraries")
def add_library(body: AddLibrary) -> dict:
    try:
        lib = store.add(body.name, body.path)
    except ManagementDisabled:
        raise HTTPException(status_code=403, detail="library management is disabled")
    except InvalidLibrary as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"id": lib.id, "name": lib.name}


@app.delete("/api/libraries/{library_id}")
def remove_library(library_id: str) -> dict:
    try:
        removed = store.remove(library_id)
    except ManagementDisabled:
        raise HTTPException(status_code=403, detail="library management is disabled")
    if not removed:
        raise HTTPException(status_code=404, detail="unknown library")
    return {"removed": library_id}


@app.put("/api/libraries/order")
def reorder_libraries(body: ReorderLibraries) -> dict:
    try:
        store.reorder(body.order)
    except ManagementDisabled:
        raise HTTPException(status_code=403, detail="library management is disabled")
    return {"order": [lib.id for lib in store.libraries()]}


@app.get("/api/fs")
def browse_fs(path: str = "") -> dict:
    """List immediate subdirectories under the browse root (for the add-library
    directory picker). Confined to the browse root; 403 if management is off."""
    try:
        return store.list_subdirs(path)
    except ManagementDisabled:
        raise HTTPException(status_code=403, detail="library management is disabled")
    except InvalidLibrary as exc:
        raise HTTPException(status_code=404, detail=str(exc))


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
