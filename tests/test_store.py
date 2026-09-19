"""Unit tests for LibraryStore behaviour independent of the running app."""

import pytest

from app.config import Config, Library
from app.libraries import InvalidLibrary, LibraryStore, ManagementDisabled


def _config(tmp_path, browse_root):
    return Config(
        libraries=(Library("seed", "Seed", tmp_path),),
        cache_dir=tmp_path,
        budget_bytes=1,
        extract_concurrency=1,
        max_archive_bytes=4_000_000_000,
        max_pdf_pages=3000,
        max_page_pixels=8_000_000,
        browse_root=browse_root,
        user_header=None,
        admins=frozenset(),
        groups_header=None,
        admin_groups=frozenset(),
        uid_header=None,
    )


def test_unmanaged_refuses_mutation(tmp_path):
    store = LibraryStore(_config(tmp_path, browse_root=None))
    assert store.managed is False
    with pytest.raises(ManagementDisabled):
        store.add("x", "y")
    with pytest.raises(ManagementDisabled):
        store.remove("seed")


def test_managed_add_remove_persists(tmp_path):
    (tmp_path / "Manga").mkdir()
    cfg = _config(tmp_path, browse_root=tmp_path)
    store = LibraryStore(cfg)
    assert store.managed is True

    lib = store.add("Manga", "Manga")
    assert store.by_id(lib.id).path == (tmp_path / "Manga")

    # a fresh store over the same cache dir reloads the persisted state
    reloaded = LibraryStore(cfg)
    assert reloaded.by_id(lib.id) is not None

    assert store.remove(lib.id) is True
    assert store.by_id(lib.id) is None


def test_add_rejects_path_outside_root(tmp_path):
    store = LibraryStore(_config(tmp_path, browse_root=tmp_path))
    with pytest.raises(InvalidLibrary):
        store.add("escape", "../../etc")


def test_reorder_persists(tmp_path):
    (tmp_path / "Manga").mkdir()
    (tmp_path / "Comics").mkdir()
    cfg = _config(tmp_path, browse_root=tmp_path)
    store = LibraryStore(cfg)
    a = store.add("Manga", "Manga")
    b = store.add("Comics", "Comics")
    assert [lib.id for lib in store.libraries()] == ["seed", a.id, b.id]

    store.reorder([b.id, a.id, "seed"])
    assert [lib.id for lib in store.libraries()] == [b.id, a.id, "seed"]

    # unknown ids are ignored; libraries omitted from the list are kept (defensive)
    store.reorder([a.id, "ghost"])
    assert [lib.id for lib in store.libraries()] == [a.id, b.id, "seed"]

    # the new order survives a reload from disk
    reloaded = LibraryStore(cfg)
    assert [lib.id for lib in reloaded.libraries()] == [a.id, b.id, "seed"]


def test_unmanaged_refuses_reorder(tmp_path):
    store = LibraryStore(_config(tmp_path, browse_root=None))
    with pytest.raises(ManagementDisabled):
        store.reorder(["seed"])
