import io
import math
import zipfile
from pathlib import Path

import pytest
from PIL import Image

from app.archives import (
    PDF_REOPEN_INTERVAL,
    PDF_RENDER_SCALE,
    ArchiveError,
    _collect_images,
    extract_to,
    page_dimensions,
    pdf_page_scale,
    sniff_format,
)


def _jpeg(w, h):
    buf = io.BytesIO()
    Image.new("RGB", (w, h), (128, 128, 128)).save(buf, "JPEG")
    return buf.getvalue()


def _pdf(path, w, h, pages=1, widen=0):
    """A PDF whose page box is w x h POINTS (resolution=72 => 1px == 1pt).

    ``widen`` grows each successive page by that many points, so page order is
    recoverable from the rendered dimensions alone.
    """
    imgs = [
        Image.new("RGB", (w + i * widen, h), (200, 100, 50)) for i in range(pages)
    ]
    imgs[0].save(
        path, "PDF", resolution=72, save_all=True, append_images=imgs[1:]
    )
    return path


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


def test_pdf_page_scale_caps_output_pixels():
    """A page small enough renders at the target scale; a big one is scaled to fit
    the pixel budget — the guard against 80-megapixel print-resolution pages."""
    assert pdf_page_scale((612, 792), 8_000_000) == PDF_RENDER_SCALE  # US Letter
    scale = pdf_page_scale((2859, 3750), 8_000_000)  # 39in wide, ~43MP at 2.0
    assert scale < PDF_RENDER_SCALE
    assert 2859 * scale * 3750 * scale == pytest.approx(8_000_000, rel=0.01)
    # Degenerate boxes must not raise.
    assert pdf_page_scale((0, 0), 8_000_000) == PDF_RENDER_SCALE

    # An extreme aspect ratio passes the AREA test at full scale while its long
    # axis alone busts the budget — the cap must bound that axis too. (No minimum
    # scale: pdfium ceils each axis, so even a tiny scale renders >= 1px.)
    for box in ((0.001, 1_000_000), (1, 20_000_000), (5000, 0.5)):
        scale = pdf_page_scale(box, 8_000_000)
        rendered = math.ceil(box[0] * scale) * math.ceil(box[1] * scale)
        assert rendered <= 8_000_000 + math.ceil(box[0] * scale) + math.ceil(box[1] * scale)


def test_pdf_render_respects_page_pixel_cap(tmp_path):
    """An oversized page is rendered smaller rather than allocating a bitmap big
    enough to get the process OOM-killed mid-extraction (which reaches the reader
    as a dead upstream, not an error)."""
    src = _pdf(tmp_path / "big.pdf", 800, 1000)

    fmt, pages = extract_to(src, tmp_path / "out", max_page_pixels=500_000)
    assert fmt == "pdf"
    dims = page_dimensions(tmp_path / "out", pages)[0]
    # +w+h: pdfium rounds each axis up to a whole pixel, so the budget can be
    # exceeded by at most one row plus one column.
    assert dims["w"] * dims["h"] <= 500_000 + dims["w"] + dims["h"]

    # Control: with headroom the same page renders at the full target scale.
    _, pages = extract_to(src, tmp_path / "out2", max_page_pixels=8_000_000)
    dims = page_dimensions(tmp_path / "out2", pages)[0]
    assert (dims["w"], dims["h"]) == (int(800 * PDF_RENDER_SCALE), int(1000 * PDF_RENDER_SCALE))


def test_pdf_longer_than_reopen_interval_renders_every_page_in_order(tmp_path):
    """The renderer reopens the document periodically to bound memory; no page may
    be skipped, repeated or reordered across a reopen boundary."""
    n = PDF_REOPEN_INTERVAL * 2 + 3
    src = _pdf(tmp_path / "long.pdf", 60, 80, pages=n, widen=1)

    _, pages = extract_to(src, tmp_path / "out")
    assert len(pages) == n
    dims = page_dimensions(tmp_path / "out", pages)
    widths = [d["w"] for d in dims]
    assert widths == sorted(widths)  # strictly increasing == original order
    assert len(set(widths)) == n     # no page rendered twice


def test_pdf_rendered_size_capped_by_max_bytes(tmp_path):
    """max_bytes bounds rendered PDF output too, not just archive extraction."""
    src = _pdf(tmp_path / "long.pdf", 800, 1000, pages=3)
    with pytest.raises(ArchiveError):
        extract_to(src, tmp_path / "out", max_bytes=1024)


def test_pdf_page_count_cap(tmp_path):
    src = _pdf(tmp_path / "long.pdf", 200, 300, pages=3)
    with pytest.raises(ArchiveError):
        extract_to(src, tmp_path / "out", max_pages=2)


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
