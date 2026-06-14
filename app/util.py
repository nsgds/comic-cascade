"""Small shared helpers: comic-format classification and natural sorting."""

from __future__ import annotations

import re

# Supported comic container formats (lower-case, no leading dot).
COMIC_EXTS = frozenset({"cbz", "cbr", "pdf"})

# Image entries we serve as pages (everything else inside an archive is ignored).
IMAGE_EXTS = frozenset({"jpg", "jpeg", "png", "gif", "webp", "bmp", "avif"})

_NUM_RE = re.compile(r"(\d+)")


def ext_of(name: str) -> str:
    """Lower-case extension without the dot (``""`` if none)."""
    dot = name.rfind(".")
    return name[dot + 1 :].lower() if dot >= 0 else ""


def is_comic(name: str) -> bool:
    return ext_of(name) in COMIC_EXTS


def is_image(name: str) -> bool:
    return ext_of(name) in IMAGE_EXTS


def natural_sort_key(s: str):
    """Sort key so that 'page2' < 'page10' and case is ignored.

    Splits a string into alternating non-digit / digit runs and compares digit
    runs numerically. Each element is a uniform ``(type_rank, number, text)``
    tuple so that a numeric run and a text run never compare directly — otherwise
    a folder containing both '100 Bullets' and 'Batman' would raise TypeError
    (int vs str). Numbers sort before text at a given position.
    """
    key = []
    for part in _NUM_RE.split(s):
        if part == "":
            continue
        if part.isdigit():
            key.append((0, int(part), ""))
        else:
            key.append((1, 0, part.lower()))
    return key
