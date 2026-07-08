"""Per-user reading-position store (the server tier of read-resume).

One row per (user, comic): the page a user is on, plus the total at the time it
was written. Identity comes from the trusted proxy headers (see app/auth.py) —
the store never sees a request, only an opaque user key. Rows live in their own
SQLite file in the cache dir (``progress.db``), following the same
connection-per-op + lock pattern as :mod:`app.cache`.

"Forgetting" a comic (finished it / dismissed its chip) is a client-written
page-0 TOMBSTONE row, not a deletion: the tombstone participates in the client's
freshest-wins merge so the forget propagates to every device (a deleted row
couldn't shadow another device's stale localStorage copy). Page-0 rows are
invisible everywhere (recent() filters them; the reader only offers page > 0),
so nothing user-facing accumulates. The DELETE endpoint remains for true
removal, but the app itself never calls it.
"""

from __future__ import annotations

import sqlite3
import threading
import time
from pathlib import Path

RECENT_LIMIT = 10  # hard cap for the "continue reading" row


class ProgressStore:
    def __init__(self, db_path: Path):
        self.db_path = db_path
        self._lock = threading.Lock()
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_db()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=30)
        conn.execute("PRAGMA journal_mode=WAL")
        return conn

    def _init_db(self) -> None:
        with self._lock, self._connect() as conn:
            conn.execute(
                """CREATE TABLE IF NOT EXISTS progress (
                       user TEXT NOT NULL,
                       library TEXT NOT NULL,
                       path TEXT NOT NULL,
                       page INTEGER NOT NULL,
                       total INTEGER NOT NULL,
                       updated_at REAL NOT NULL,
                       PRIMARY KEY (user, library, path)
                   )"""
            )

    def get(self, user: str, library: str, path: str) -> dict | None:
        with self._lock, self._connect() as conn:
            row = conn.execute(
                "SELECT page, total, updated_at FROM progress"
                " WHERE user=? AND library=? AND path=?",
                (user, library, path),
            ).fetchone()
        if row is None:
            return None
        return {"page": int(row[0]), "total": int(row[1]), "updated_at": float(row[2])}

    def upsert(self, user: str, library: str, path: str, page: int, total: int) -> None:
        with self._lock, self._connect() as conn:
            conn.execute(
                """INSERT INTO progress(user, library, path, page, total, updated_at)
                   VALUES(?,?,?,?,?,?)
                   ON CONFLICT(user, library, path) DO UPDATE SET
                       page=excluded.page, total=excluded.total,
                       updated_at=excluded.updated_at""",
                (user, library, path, page, total, time.time()),
            )

    def delete(self, user: str, library: str, path: str) -> bool:
        with self._lock, self._connect() as conn:
            cur = conn.execute(
                "DELETE FROM progress WHERE user=? AND library=? AND path=?",
                (user, library, path),
            )
        return cur.rowcount > 0

    def tombstones(self, user: str, limit: int = 100) -> list[dict]:
        """This user's page-0 tombstone rows, newest first. Served alongside
        recent() so OTHER devices' merges can shadow their stale local copies —
        a tombstone that never leaves the server propagates nothing."""
        limit = max(1, min(int(limit), 500))
        with self._lock, self._connect() as conn:
            rows = conn.execute(
                "SELECT library, path, total, updated_at FROM progress"
                " WHERE user=? AND page = 0 ORDER BY updated_at DESC LIMIT ?",
                (user, limit),
            ).fetchall()
        return [
            {
                "library": r[0],
                "path": r[1],
                "page": 0,
                "total": int(r[2]),
                "updated_at": float(r[3]),
            }
            for r in rows
        ]

    def recent(self, user: str, limit: int = RECENT_LIMIT) -> list[dict]:
        """Most-recently-updated rows for one user, newest first. Rows at page 0
        are stored (they're truth) but not shown — nothing to continue from.
        Callers may scan past RECENT_LIMIT (the API filters rows whose library is
        temporarily missing, and hidden rows must not starve visible ones)."""
        limit = max(1, min(int(limit), 500))
        with self._lock, self._connect() as conn:
            rows = conn.execute(
                "SELECT library, path, page, total, updated_at FROM progress"
                " WHERE user=? AND page > 0 ORDER BY updated_at DESC LIMIT ?",
                (user, limit),
            ).fetchall()
        return [
            {
                "library": r[0],
                "path": r[1],
                "page": int(r[2]),
                "total": int(r[3]),
                "updated_at": float(r[4]),
            }
            for r in rows
        ]
