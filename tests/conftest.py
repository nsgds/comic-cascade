"""Test fixtures: a temporary library + cache, wired via env BEFORE app import.

Setting CASCADE_LIBRARY / CASCADE_CACHE_DIR at import time means the app's
cached config (and the ArchiveCache built in app.main) pick up these temp dirs.
"""

import io
import os
import tempfile
import zipfile
from pathlib import Path

import pytest
from PIL import Image

LIB_DIR = Path(tempfile.mkdtemp(prefix="cc-test-lib-"))
CACHE_DIR = Path(tempfile.mkdtemp(prefix="cc-test-cache-"))


def _jpeg(w: int, h: int, color) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (w, h), color).save(buf, "JPEG")
    return buf.getvalue()


def _make_fixtures() -> None:
    # sample.cbz: 3 pages added out of order + a non-image entry to be filtered.
    with zipfile.ZipFile(LIB_DIR / "sample.cbz", "w") as z:
        z.writestr("page10.jpg", _jpeg(100, 150, (10, 10, 10)))
        z.writestr("page2.jpg", _jpeg(120, 160, (20, 20, 20)))
        z.writestr("page1.jpg", _jpeg(80, 120, (30, 30, 30)))
        z.writestr("ComicInfo.xml", b"<ComicInfo/>")

    # empty.cbz: a valid zip with no image entries.
    with zipfile.ZipFile(LIB_DIR / "empty.cbz", "w") as z:
        z.writestr("readme.txt", b"no images here")

    # garbage.cbz: not an archive at all.
    (LIB_DIR / "garbage.cbz").write_bytes(b"this is definitely not a zip or rar")

    # a non-comic file and a nested directory
    (LIB_DIR / "notes.txt").write_text("hello")
    (LIB_DIR / "Series A").mkdir(exist_ok=True)
    (LIB_DIR / "Series A" / "issue.cbz").write_bytes((LIB_DIR / "sample.cbz").read_bytes())


_make_fixtures()
os.environ["CASCADE_LIBRARY"] = str(LIB_DIR)
os.environ["CASCADE_CACHE_DIR"] = str(CACHE_DIR)
os.environ["CASCADE_BROWSE_ROOT"] = str(LIB_DIR)  # enables UI library management
os.environ.pop("CASCADE_CONFIG", None)


@pytest.fixture(scope="session")
def client():
    from fastapi.testclient import TestClient

    from app.main import app

    return TestClient(app)
