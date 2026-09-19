"""Cache-directory hygiene that the API tests don't cover."""

import json

from app.cache import ArchiveCache


def _cache(tmp_path):
    return ArchiveCache(tmp_path, budget_bytes=10**9, concurrency=1)


def test_startup_sweeps_orphaned_extraction_dirs(tmp_path):
    """A dir with no meta file is a half-written extraction whose process died
    (an OOM kill runs no cleanup): invisible to readers and to the LRU index, so
    it must not keep occupying the volume. Anything with meta stays."""
    cache = _cache(tmp_path)
    orphan = cache.archives / "deadbeef"
    orphan.mkdir()
    (orphan / "00000.jpg").write_bytes(b"x" * 10)
    keep = cache.archives / "cafe"
    keep.mkdir()
    (keep / "00000.jpg").write_bytes(b"y" * 10)
    (cache.meta / "cafe.json").write_text(json.dumps({"format": "zip", "pages": [], "dims": []}))

    _cache(tmp_path)  # restart

    assert not orphan.exists()
    assert (keep / "00000.jpg").exists()
