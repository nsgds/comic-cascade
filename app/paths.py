"""Per-library path resolution with traversal confinement.

Every filesystem access goes through :func:`safe_resolve`, which guarantees the
resolved target stays inside the requested library's root even in the presence of
``..`` segments or escaping symlinks. Unknown libraries and escape attempts both
return 404 (not 403) so the API never confirms what lives outside a library.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import HTTPException

from .config import Library
from .libraries import store


def get_library(library_id: str) -> Library:
    lib = store.by_id(library_id)
    if lib is None:
        raise HTTPException(status_code=404, detail="unknown library")
    return lib


def safe_resolve(library_id: str, rel: str) -> Path:
    """Resolve ``rel`` under the given library, confined to its root.

    Raises 404 if the library is unknown or the path escapes the root.
    """
    lib = get_library(library_id)
    root = lib.path.resolve()
    # Treat the relative path as rooted; strip leading slashes so an absolute-looking
    # value can't jump to the filesystem root.
    target = (root / rel.lstrip("/")).resolve()
    if target != root and not target.is_relative_to(root):
        raise HTTPException(status_code=404, detail="not found")
    return target
