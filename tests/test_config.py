"""Unit tests for config parsing helpers."""

import pytest

from app.config import _clean_names, _coerce_name_list


def test_coerce_accepts_list():
    assert _coerce_name_list(["alice", "bob"], "admins") == ["alice", "bob"]
    assert _coerce_name_list([], "admins") == []


def test_coerce_accepts_comma_string():
    # A common mistake (string instead of array) is handled, not silently broken.
    assert _coerce_name_list("alice,bob", "admins") == ["alice", "bob"]


@pytest.mark.parametrize("bad", [123, True, {"alice": True}, 3.5])
def test_coerce_rejects_other_types(bad):
    # Must fail loudly rather than silently produce an empty (i.e. open) allowlist.
    with pytest.raises(ValueError):
        _coerce_name_list(bad, "admins")


def test_clean_names_strips_and_drops_blanks():
    assert _clean_names([" alice ", "", "bob", "   "]) == frozenset({"alice", "bob"})


def test_auth_settings_reads_uid_header_from_env(monkeypatch):
    from app.config import _auth_settings

    monkeypatch.setenv("CASCADE_UID_HEADER", "  X-Authentik-Uid  ")
    *_, uid_header = _auth_settings()
    assert uid_header == "X-Authentik-Uid"  # stripped

    monkeypatch.setenv("CASCADE_UID_HEADER", "   ")
    *_, uid_header = _auth_settings()
    assert uid_header is None  # blank collapses to unset


def test_scalar_settings_reads_page_pixel_cap_from_env(monkeypatch):
    from app.config import DEFAULT_MAX_PAGE_PIXELS, _scalar_settings

    monkeypatch.delenv("CASCADE_MAX_PAGE_PIXELS", raising=False)
    *_, max_page_pixels = _scalar_settings()
    assert max_page_pixels == DEFAULT_MAX_PAGE_PIXELS

    monkeypatch.setenv("CASCADE_MAX_PAGE_PIXELS", "2000000")
    *_, max_page_pixels = _scalar_settings()
    assert max_page_pixels == 2_000_000

    monkeypatch.setenv("CASCADE_MAX_PAGE_PIXELS", "0")
    *_, max_page_pixels = _scalar_settings()
    assert max_page_pixels == 1  # clamped: a zero budget would render nothing
