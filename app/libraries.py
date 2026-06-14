"""Runtime library registry.

When a browse root is configured (UI management enabled), the set of libraries
becomes mutable and is persisted to ``<cache>/libraries.json`` — seeded once from
the static config so an existing deployment carries its libraries over. Without a
browse root the registry is just the immutable, config-derived list and the
add/remove operations are refused.

Adds are confined to the browse root: a library may point at the browse root or
any directory beneath it, nothing outside.
"""

from __future__ import annotations

import json
import os
import re
import threading
from pathlib import Path

from .config import Config, Library, get_config


class ManagementDisabled(Exception):
    """Raised when add/remove is attempted but no browse root is configured."""


class InvalidLibrary(Exception):
    """Raised when a requested library path is outside the browse root / not a dir."""


def _slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.strip().lower()).strip("-")
    return slug or "library"


class LibraryStore:
    def __init__(self, config: Config):
        self.browse_root = config.browse_root.resolve() if config.browse_root else None
        self.state_file = config.cache_dir / "libraries.json"
        self._lock = threading.Lock()
        self._libs: dict[str, Library] = {}
        self._load_or_seed(config)

    @property
    def managed(self) -> bool:
        return self.browse_root is not None

    # ---- reads ----
    def libraries(self) -> list[Library]:
        return list(self._libs.values())

    def by_id(self, library_id: str) -> Library | None:
        return self._libs.get(library_id)

    # ---- mutations (require management) ----
    def add(self, name: str, rel_path: str) -> Library:
        if not self.managed:
            raise ManagementDisabled()
        target = self._confine(rel_path)
        with self._lock:
            for lib in self._libs.values():
                if lib.path == target:
                    raise InvalidLibrary("that folder is already a library")
            display = name.strip() or target.name or "Library"
            lib = Library(id=self._unique_id(display), name=display, path=target)
            self._libs[lib.id] = lib
            self._save()
        return lib

    def remove(self, library_id: str) -> bool:
        if not self.managed:
            raise ManagementDisabled()
        with self._lock:
            existed = self._libs.pop(library_id, None) is not None
            if existed:
                self._save()
        return existed

    def reorder(self, ids: list[str]) -> None:
        """Reorder the libraries to match ``ids``. IDs not present are ignored;
        any existing library missing from ``ids`` is appended in its current
        order (defensive — keeps a stale client from dropping a library)."""
        if not self.managed:
            raise ManagementDisabled()
        with self._lock:
            ordered = {lid: self._libs[lid] for lid in ids if lid in self._libs}
            for lid, lib in self._libs.items():
                ordered.setdefault(lid, lib)
            if list(ordered) != list(self._libs):
                self._libs = ordered
                self._save()

    def list_subdirs(self, rel_path: str) -> dict:
        """Immediate subdirectories of <browse_root>/<rel_path>, for the picker."""
        if not self.managed:
            raise ManagementDisabled()
        base = self._confine(rel_path, must_be_dir=True)
        rel = "" if base == self.browse_root else str(base.relative_to(self.browse_root))
        dirs = []
        try:
            with os.scandir(base) as it:
                for entry in it:
                    if entry.name.startswith("."):
                        continue
                    try:
                        if entry.is_dir():
                            dirs.append(entry.name)
                    except OSError:
                        continue
        except OSError:
            raise InvalidLibrary("cannot read directory")
        dirs.sort(key=str.lower)
        return {"path": rel, "dirs": dirs}

    # ---- internals ----
    def _confine(self, rel_path: str, must_be_dir: bool = True) -> Path:
        assert self.browse_root is not None
        target = (self.browse_root / rel_path.lstrip("/")).resolve()
        if target != self.browse_root and not target.is_relative_to(self.browse_root):
            raise InvalidLibrary("path is outside the browse root")
        if must_be_dir and not target.is_dir():
            raise InvalidLibrary("not a directory")
        return target

    def _unique_id(self, name: str) -> str:
        base = _slugify(name)
        if base not in self._libs:
            return base
        n = 2
        while f"{base}-{n}" in self._libs:
            n += 1
        return f"{base}-{n}"

    def _load_or_seed(self, config: Config) -> None:
        if self.managed and self.state_file.is_file():
            self._load()
            return
        # seed from the static, config-derived libraries
        for lib in config.libraries:
            self._libs[lib.id] = lib
        if self.managed:
            self._save()

    def _load(self) -> None:
        try:
            data = json.loads(self.state_file.read_text())
        except (OSError, json.JSONDecodeError):
            return
        for entry in data.get("libraries", []):
            lib = Library(id=entry["id"], name=entry["name"], path=Path(entry["path"]))
            self._libs[lib.id] = lib

    def _save(self) -> None:
        payload = {
            "libraries": [
                {"id": lib.id, "name": lib.name, "path": str(lib.path)}
                for lib in self._libs.values()
            ]
        }
        tmp = self.state_file.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(payload, indent=2))
        tmp.replace(self.state_file)


store = LibraryStore(get_config())
