"""Disk-backed extracted-page cache with LRU eviction.

A comic is extracted once into ``<cache>/archives/<hash>/`` and its page list +
dimensions stored in ``<cache>/meta/<hash>.json``. An SQLite index tracks size
and last-access time so the least-recently-read *whole archives* can be evicted
when the cache exceeds its byte budget.

Concurrency:
  * one :class:`asyncio.Lock` per archive hash so concurrent openers await a
    single extraction;
  * a global semaphore bounds simultaneous extractions (CPU/memory/IO);
  * the blocking extraction itself runs in a worker thread.

The cache key includes the source file's mtime+size, so a replaced file gets a
fresh entry automatically and the stale one ages out by LRU.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import shutil
import sqlite3
import threading
import time
import weakref
from pathlib import Path

from .archives import ArchiveError, extract_to, page_dimensions

MIN_FREE_BYTES = 512 * 1024 * 1024  # keep at least this much free on the cache volume


class ArchiveCache:
    def __init__(
        self,
        cache_dir: Path,
        budget_bytes: int,
        concurrency: int,
        max_archive_bytes: int = 4_000_000_000,
        max_pdf_pages: int = 3000,
        max_page_pixels: int = 8_000_000,
    ):
        self.root = Path(cache_dir)
        self.archives = self.root / "archives"
        self.meta = self.root / "meta"
        self.db_path = self.root / "index.db"
        self.budget = budget_bytes
        self.max_archive_bytes = max_archive_bytes
        self.max_pdf_pages = max_pdf_pages
        self.max_page_pixels = max_page_pixels
        self.archives.mkdir(parents=True, exist_ok=True)
        self.meta.mkdir(parents=True, exist_ok=True)

        self._db_lock = threading.Lock()
        self._init_db()
        self._sweep_orphans()

        # WeakValueDictionary: a per-archive lock is collected once no opener holds
        # it, so the map can't grow without bound across many distinct comics.
        self._locks: "weakref.WeakValueDictionary[str, asyncio.Lock]" = (
            weakref.WeakValueDictionary()
        )
        self._locks_guard = asyncio.Lock()
        self._sem = asyncio.Semaphore(max(1, concurrency))

    def _sweep_orphans(self) -> None:
        """Delete extraction dirs that have no meta file.

        Such a dir is a half-written extraction whose process died before it could
        clean up (an OOM kill leaves no chance to run ``except``), so it is invisible
        to both the reader and the LRU index while still occupying the volume. Safe
        ONLY here, at construction: once serving, a meta-less dir is an extraction
        in flight.
        """
        try:
            for d in self.archives.iterdir():
                if d.is_dir() and not (self.meta / f"{d.name}.json").exists():
                    shutil.rmtree(d, ignore_errors=True)
        except OSError:  # unreadable cache dir is the caller's problem, not fatal here
            pass

    # ---- public API -------------------------------------------------------

    async def get_comic(self, library: str, rel: str, src: Path) -> tuple[str, dict]:
        """Return (hash, meta) for a comic, extracting + caching on first access.

        meta = {"format", "pages": [...], "dims": [...]}. Raises ArchiveError.
        """
        h = self._key(library, rel, src)
        meta = self._read_meta(h)
        if meta is not None:
            self._touch(h)
            return h, meta

        lock = await self._lock_for(h)
        async with lock:
            meta = self._read_meta(h)  # another waiter may have finished it
            if meta is not None:
                self._touch(h)
                return h, meta
            async with self._sem:
                meta = await asyncio.to_thread(self._extract_blocking, h, library, rel, src)
            self._touch(h)
            return h, meta

    def page_path(self, h: str, page_name: str) -> Path:
        return self.archives / h / page_name

    def healthy(self) -> bool:
        try:
            self.root.mkdir(parents=True, exist_ok=True)
            return True
        except OSError:
            return False

    # ---- extraction (runs in a worker thread) -----------------------------

    def _extract_blocking(self, h: str, library: str, rel: str, src: Path) -> dict:
        self._evict_to_budget(exclude={h})
        self._ensure_free_space(exclude={h})

        dest = self.archives / h
        if dest.exists():
            shutil.rmtree(dest, ignore_errors=True)
        try:
            fmt, pages = extract_to(
                src,
                dest,
                max_bytes=self.max_archive_bytes,
                max_pages=self.max_pdf_pages,
                max_page_pixels=self.max_page_pixels,
            )
            dims = page_dimensions(dest, pages)
        except ArchiveError:
            shutil.rmtree(dest, ignore_errors=True)
            raise
        except OSError as exc:  # e.g. ENOSPC mid-extraction
            shutil.rmtree(dest, ignore_errors=True)
            raise ArchiveError(f"extraction failed: {exc}")

        meta = {"format": fmt, "pages": pages, "dims": dims}
        (self.meta / f"{h}.json").write_text(json.dumps(meta))
        size = _dir_size(dest)
        self._db_upsert(h, library, rel, size, len(pages))
        self._evict_to_budget(exclude={h})
        return meta

    # ---- locking ----------------------------------------------------------

    async def _lock_for(self, h: str) -> asyncio.Lock:
        async with self._locks_guard:
            lock = self._locks.get(h)
            if lock is None:
                lock = asyncio.Lock()
                self._locks[h] = lock
            return lock

    def _busy_hashes(self) -> set[str]:
        return {h for h, lk in list(self._locks.items()) if lk.locked()}

    # ---- eviction ---------------------------------------------------------

    def _evict_to_budget(self, exclude: set[str]) -> None:
        total = self._db_total_bytes()
        if total <= self.budget:
            return
        target = int(self.budget * 0.8)
        protected = exclude | self._busy_hashes()
        for h, b in self._db_lru():
            if total <= target:
                break
            if h in protected:
                continue
            self._remove(h)
            total -= b

    def _ensure_free_space(self, exclude: set[str]) -> None:
        protected = exclude | self._busy_hashes()
        for h, b in self._db_lru():
            try:
                free = shutil.disk_usage(self.archives).free
            except OSError:
                return
            if free >= MIN_FREE_BYTES:
                return
            if h in protected:
                continue
            self._remove(h)

    def _remove(self, h: str) -> None:
        shutil.rmtree(self.archives / h, ignore_errors=True)
        (self.meta / f"{h}.json").unlink(missing_ok=True)
        self._db_delete(h)

    # ---- metadata + key ---------------------------------------------------

    def _key(self, library: str, rel: str, src: Path) -> str:
        st = src.stat()
        raw = f"{library}\0{rel}\0{int(st.st_mtime)}\0{st.st_size}"
        return hashlib.sha1(raw.encode("utf-8")).hexdigest()

    def _read_meta(self, h: str) -> dict | None:
        meta_file = self.meta / f"{h}.json"
        if not meta_file.is_file() or not (self.archives / h).is_dir():
            return None
        try:
            return json.loads(meta_file.read_text())
        except (OSError, json.JSONDecodeError):
            return None

    # ---- sqlite (serialized via _db_lock; connection-per-op) --------------

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=30)
        conn.execute("PRAGMA journal_mode=WAL")
        return conn

    def _init_db(self) -> None:
        with self._db_lock, self._connect() as conn:
            conn.execute(
                """CREATE TABLE IF NOT EXISTS cache (
                       hash TEXT PRIMARY KEY,
                       library TEXT, rel TEXT,
                       bytes INTEGER, pages INTEGER,
                       last_access REAL, created REAL
                   )"""
            )

    def _db_upsert(self, h, library, rel, size, pages) -> None:
        now = time.time()
        with self._db_lock, self._connect() as conn:
            conn.execute(
                """INSERT INTO cache(hash, library, rel, bytes, pages, last_access, created)
                   VALUES(?,?,?,?,?,?,?)
                   ON CONFLICT(hash) DO UPDATE SET
                       bytes=excluded.bytes, pages=excluded.pages, last_access=excluded.last_access""",
                (h, library, rel, size, pages, now, now),
            )

    def _touch(self, h: str) -> None:
        with self._db_lock, self._connect() as conn:
            conn.execute("UPDATE cache SET last_access=? WHERE hash=?", (time.time(), h))

    def _db_delete(self, h: str) -> None:
        with self._db_lock, self._connect() as conn:
            conn.execute("DELETE FROM cache WHERE hash=?", (h,))

    def _db_total_bytes(self) -> int:
        with self._db_lock, self._connect() as conn:
            row = conn.execute("SELECT COALESCE(SUM(bytes), 0) FROM cache").fetchone()
        return int(row[0])

    def _db_lru(self) -> list[tuple[str, int]]:
        with self._db_lock, self._connect() as conn:
            rows = conn.execute(
                "SELECT hash, bytes FROM cache ORDER BY last_access ASC"
            ).fetchall()
        return [(r[0], int(r[1])) for r in rows]


def _dir_size(path: Path) -> int:
    total = 0
    for p in path.rglob("*"):
        try:
            if p.is_file():
                total += p.stat().st_size
        except OSError:
            pass
    return total
