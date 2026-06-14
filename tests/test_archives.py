import io
import zipfile
from pathlib import Path

import pytest
from PIL import Image

from app.archives import (
    ArchiveError,
    _collect_images,
    extract_to,
    page_dimensions,
    sniff_format,
)


def _jpeg(w, h):
    buf = io.BytesIO()
    Image.new("RGB", (w, h), (128, 128, 128)).save(buf, "JPEG")
    return buf.getvalue()


def test_sniff_format(tmp_path):
    z = tmp_path / "a.cbz"
    with zipfile.ZipFile(z, "w") as zf:
        zf.writestr("x.jpg", b"x")
    assert sniff_format(z) == "zip"

    (tmp_path / "b.pdf").write_bytes(b"%PDF-1.7\n...")
    assert sniff_format(tmp_path / "b.pdf") == "pdf"

    (tmp_path / "c.bin").write_bytes(b"7z\xbc\xaf\x27\x1c....")
    assert sniff_format(tmp_path / "c.bin") == "7z"

    (tmp_path / "d.bin").write_bytes(b"not an archive")
    assert sniff_format(tmp_path / "d.bin") == "unknown"


def test_extract_zip_natural_order_and_filtering(tmp_path):
    src = tmp_path / "comic.cbz"
    with zipfile.ZipFile(src, "w") as zf:
        zf.writestr("page10.jpg", _jpeg(10, 20))
        zf.writestr("page2.jpg", _jpeg(30, 40))
        zf.writestr("page1.jpg", _jpeg(50, 60))
        zf.writestr("ComicInfo.xml", b"<x/>")  # filtered

    dest = tmp_path / "out"
    fmt, pages = extract_to(src, dest)
    assert fmt == "zip"
    assert len(pages) == 3  # xml dropped
    # natural order: page1 (50x60), page2 (30x40), page10 (10x20)
    dims = page_dimensions(dest, pages)
    assert [d["w"] for d in dims] == [50, 30, 10]


def test_empty_archive_raises(tmp_path):
    src = tmp_path / "empty.cbz"
    with zipfile.ZipFile(src, "w") as zf:
        zf.writestr("readme.txt", b"nothing")
    with pytest.raises(ArchiveError):
        extract_to(src, tmp_path / "out")


def test_garbage_archive_raises(tmp_path):
    src = tmp_path / "garbage.cbz"
    src.write_bytes(b"this is not an archive at all")
    with pytest.raises(ArchiveError):
        extract_to(src, tmp_path / "out")


def test_zip_decompression_bomb_rejected(tmp_path):
    """An archive whose uncompressed size exceeds max_bytes is refused."""
    src = tmp_path / "big.cbz"
    with zipfile.ZipFile(src, "w") as zf:
        zf.writestr("page1.jpg", _jpeg(200, 200))
    with pytest.raises(ArchiveError):
        extract_to(src, tmp_path / "out", max_bytes=64)  # tiny cap


def test_corrupt_pdf_raises_archive_error(tmp_path):
    """A file that sniffs as PDF but won't open raises ArchiveError, not a 500."""
    src = tmp_path / "broken.pdf"
    src.write_bytes(b"%PDF-1.7\nnot really a pdf body")
    with pytest.raises(ArchiveError):
        extract_to(src, tmp_path / "out")


def test_collect_images_skips_symlinks_and_escapes(tmp_path):
    """Symlinks (and anything resolving outside the extraction dir) are never
    collected — a malicious RAR/7z can't smuggle in page.jpg -> /etc/passwd."""
    raw = tmp_path / "_raw"
    raw.mkdir()
    real = raw / "page1.jpg"
    real.write_bytes(_jpeg(10, 10))

    secret = tmp_path / "secret.jpg"  # lives OUTSIDE raw
    secret.write_bytes(_jpeg(10, 10))
    (raw / "evil.jpg").symlink_to(secret)  # symlinked image pointing outside

    collected = {p.name for p in _collect_images(raw)}
    assert collected == {"page1.jpg"}  # the symlink is excluded
