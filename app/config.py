"""Configuration loading for Comic Cascade.

Libraries are resolved in this order (first match wins):

  1. A TOML config file ([[library]] tables) from ``$CASCADE_CONFIG`` or the first
     of ``./cascade.toml``, ``/app/cascade.toml``, ``/config/cascade.toml`` that exists.
  2. ``$CASCADE_LIBRARY`` -> a single library named "Library" at that path.
  3. Every immediate subdirectory of ``/libraries`` (or ``$CASCADE_LIBRARIES_DIR``)
     becomes a library named after the directory.
  4. A single folder mounted at ``/library`` becomes one library named "Library".

Everything is read-only as far as libraries are concerned; the app never writes
into them. The cache directory is the only writable location.
"""

from __future__ import annotations

import os
import re
import tomllib
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

DEFAULT_CONFIG_SEARCH = ("cascade.toml", "/app/cascade.toml", "/config/cascade.toml")
DEFAULT_LIBRARIES_DIR = "/libraries"
DEFAULT_SINGLE_DIR = "/library"
DEFAULT_CACHE_DIR = "/cache"
DEFAULT_BUDGET_BYTES = 6_000_000_000
DEFAULT_EXTRACT_CONCURRENCY = 2
# Per-archive extraction guards against decompression bombs / pathological files.
DEFAULT_MAX_ARCHIVE_BYTES = 4_000_000_000  # max total uncompressed size per comic
DEFAULT_MAX_PDF_PAGES = 3000               # refuse to render absurdly long PDFs


@dataclass(frozen=True)
class Library:
    id: str
    name: str
    path: Path


@dataclass(frozen=True)
class Config:
    libraries: tuple[Library, ...]
    cache_dir: Path
    budget_bytes: int
    extract_concurrency: int
    max_archive_bytes: int
    max_pdf_pages: int
    browse_root: Path | None  # set => UI library management enabled, bounded here

    @property
    def libraries_by_id(self) -> dict[str, Library]:
        return {lib.id: lib for lib in self.libraries}


def _slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.strip().lower()).strip("-")
    return slug or "library"


def _assign_ids(pairs: list[tuple[str, Path]]) -> list[Library]:
    """Turn (name, path) pairs into Libraries with unique, stable slug ids."""
    seen: dict[str, int] = {}
    libs: list[Library] = []
    for name, path in pairs:
        base = _slugify(name)
        if base in seen:
            seen[base] += 1
            lib_id = f"{base}-{seen[base]}"
        else:
            seen[base] = 0
            lib_id = base
        libs.append(Library(id=lib_id, name=name, path=path))
    return libs


def _find_config_file() -> Path | None:
    explicit = os.environ.get("CASCADE_CONFIG")
    if explicit:
        p = Path(explicit)
        return p if p.is_file() else None
    for candidate in DEFAULT_CONFIG_SEARCH:
        p = Path(candidate)
        if p.is_file():
            return p
    return None


def _libraries_from_pairs() -> list[tuple[str, Path]]:
    """Resolve the (name, path) library list per the documented precedence."""
    config_file = _find_config_file()
    if config_file is not None:
        with config_file.open("rb") as fh:
            data = tomllib.load(fh)
        pairs: list[tuple[str, Path]] = []
        for entry in data.get("library", []):
            name = str(entry.get("name") or Path(entry["path"]).name)
            pairs.append((name, Path(entry["path"])))
        if pairs:
            return pairs

    single = os.environ.get("CASCADE_LIBRARY")
    if single:
        return [("Library", Path(single))]

    libs_dir = Path(os.environ.get("CASCADE_LIBRARIES_DIR", DEFAULT_LIBRARIES_DIR))
    if libs_dir.is_dir():
        subdirs = sorted(
            (child for child in libs_dir.iterdir() if child.is_dir()),
            key=lambda p: p.name.lower(),
        )
        if subdirs:
            return [(child.name, child) for child in subdirs]

    # Convention: a single folder mounted at /library "just works" with no config.
    if Path(DEFAULT_SINGLE_DIR).is_dir():
        return [("Library", Path(DEFAULT_SINGLE_DIR))]

    return []


def _scalar_settings() -> tuple[Path, int, int, int, int]:
    """cache dir / budget / concurrency / extraction limits from config then env."""
    cache_dir = DEFAULT_CACHE_DIR
    budget = DEFAULT_BUDGET_BYTES
    concurrency = DEFAULT_EXTRACT_CONCURRENCY
    max_archive_bytes = DEFAULT_MAX_ARCHIVE_BYTES
    max_pdf_pages = DEFAULT_MAX_PDF_PAGES

    config_file = _find_config_file()
    if config_file is not None:
        with config_file.open("rb") as fh:
            data = tomllib.load(fh)
        cache = data.get("cache", {})
        cache_dir = cache.get("dir", cache_dir)
        budget = int(cache.get("budget_bytes", budget))
        server = data.get("server", {})
        concurrency = int(server.get("extract_concurrency", concurrency))
        max_archive_bytes = int(server.get("max_archive_bytes", max_archive_bytes))
        max_pdf_pages = int(server.get("max_pdf_pages", max_pdf_pages))

    cache_dir = os.environ.get("CASCADE_CACHE_DIR", cache_dir)
    budget = int(os.environ.get("CASCADE_CACHE_BUDGET", budget))
    concurrency = int(os.environ.get("CASCADE_EXTRACT_CONCURRENCY", concurrency))
    max_archive_bytes = int(os.environ.get("CASCADE_MAX_ARCHIVE_BYTES", max_archive_bytes))
    max_pdf_pages = int(os.environ.get("CASCADE_MAX_PDF_PAGES", max_pdf_pages))
    return Path(cache_dir), budget, max(1, concurrency), max(1, max_archive_bytes), max(1, max_pdf_pages)


def _browse_root() -> Path | None:
    """Directory the UI library-picker may navigate within. Setting it enables
    UI library management; leaving it unset keeps libraries static (config-only)."""
    root = None
    config_file = _find_config_file()
    if config_file is not None:
        with config_file.open("rb") as fh:
            data = tomllib.load(fh)
        root = data.get("browse", {}).get("root")
    root = os.environ.get("CASCADE_BROWSE_ROOT", root)
    return Path(root) if root else None


@lru_cache(maxsize=1)
def get_config() -> Config:
    libraries = tuple(_assign_ids(_libraries_from_pairs()))
    cache_dir, budget, concurrency, max_archive_bytes, max_pdf_pages = _scalar_settings()
    return Config(
        libraries=libraries,
        cache_dir=cache_dir,
        budget_bytes=budget,
        extract_concurrency=concurrency,
        max_archive_bytes=max_archive_bytes,
        max_pdf_pages=max_pdf_pages,
        browse_root=_browse_root(),
    )
