"""Per-user reading progress: the ProgressStore and the /api/progress endpoints.

The conftest configures CASCADE_USER_HEADER=X-Test-User and
CASCADE_UID_HEADER=X-Test-Uid; requests that send neither are anonymous and the
server tier must be completely inert for them.
"""

import os
import time
from pathlib import Path

from app.progress import ProgressStore

LIB_DIR = Path(os.environ["CASCADE_LIBRARY"])  # set by conftest before app import

ALICE = {"X-Test-User": "alice"}
BOB = {"X-Test-User": "bob"}


# ---- store unit tests --------------------------------------------------------


def test_store_roundtrip(tmp_path):
    s = ProgressStore(tmp_path / "p.db")
    assert s.get("u", "lib", "a.cbz") is None
    s.upsert("u", "lib", "a.cbz", 4, 10)
    row = s.get("u", "lib", "a.cbz")
    assert (row["page"], row["total"]) == (4, 10)
    s.upsert("u", "lib", "a.cbz", 7, 10)  # update, same key
    assert s.get("u", "lib", "a.cbz")["page"] == 7
    assert s.delete("u", "lib", "a.cbz") is True
    assert s.delete("u", "lib", "a.cbz") is False  # already gone
    assert s.get("u", "lib", "a.cbz") is None


def test_store_recent_orders_filters_and_limits(tmp_path):
    s = ProgressStore(tmp_path / "p.db")
    s.upsert("u", "lib", "old.cbz", 1, 5)
    time.sleep(0.02)  # distinct updated_at
    s.upsert("u", "lib", "new.cbz", 2, 5)
    s.upsert("u", "lib", "unstarted.cbz", 0, 5)  # page 0: stored but never listed
    s.upsert("other", "lib", "theirs.cbz", 3, 5)  # another user's row

    recent = s.recent("u")
    assert [r["path"] for r in recent] == ["new.cbz", "old.cbz"]

    for i in range(15):
        s.upsert("u", "lib", f"bulk{i}.cbz", 1, 5)
    assert len(s.recent("u")) == 10  # hard cap
    assert len(s.recent("u", limit=3)) == 3


def test_store_tombstones_listed_separately(tmp_path):
    s = ProgressStore(tmp_path / "p.db")
    s.upsert("u", "lib", "reading.cbz", 3, 10)
    s.upsert("u", "lib", "forgotten.cbz", 0, 10)   # tombstone
    s.upsert("other", "lib", "theirs.cbz", 0, 10)  # another user's tombstone
    assert [r["path"] for r in s.recent("u")] == ["reading.cbz"]
    stones = s.tombstones("u")
    assert [(r["path"], r["page"]) for r in stones] == [("forgotten.cbz", 0)]


# ---- API: anonymous requests => the server tier is inert ----------------------


def test_progress_inert_without_identity(client):
    assert client.get("/api/libraries").json()["progress"] is False

    r = client.get("/api/progress", params={"library": "library", "path": "sample.cbz"})
    assert r.status_code == 200 and r.json()["position"] is None

    body = {"library": "library", "path": "sample.cbz", "page": 1, "total": 3}
    assert client.post("/api/progress", json=body).status_code == 204  # no-op
    assert client.delete(
        "/api/progress", params={"library": "library", "path": "sample.cbz"}
    ).status_code == 204  # no-op

    r = client.get("/api/progress/recent")
    assert r.status_code == 200 and r.json()["items"] == []

    # the no-op POST really stored nothing for anyone
    r = client.get(
        "/api/progress", params={"library": "library", "path": "sample.cbz"}, headers=ALICE
    )
    assert r.json()["position"] is None


# ---- API: identified requests --------------------------------------------------


def test_progress_roundtrip_and_isolation(client):
    assert client.get("/api/libraries", headers=ALICE).json()["progress"] is True

    body = {"library": "library", "path": "sample.cbz", "page": 1, "total": 3}
    assert client.post("/api/progress", json=body, headers=ALICE).status_code == 204

    pos = client.get(
        "/api/progress", params={"library": "library", "path": "sample.cbz"}, headers=ALICE
    ).json()["position"]
    assert (pos["page"], pos["total"]) == (1, 3) and pos["updated_at"] > 0

    # bob sees nothing of alice's — the user key is server-derived, not a parameter
    assert (
        client.get(
            "/api/progress", params={"library": "library", "path": "sample.cbz"}, headers=BOB
        ).json()["position"]
        is None
    )
    assert client.get("/api/progress/recent", headers=BOB).json()["items"] == []

    items = client.get("/api/progress/recent", headers=ALICE).json()["items"]
    assert [(i["library"], i["path"], i["page"]) for i in items] == [("library", "sample.cbz", 1)]

    # finished => the client deletes; everything about it is forgotten
    assert (
        client.delete(
            "/api/progress", params={"library": "library", "path": "sample.cbz"}, headers=ALICE
        ).status_code
        == 204
    )
    assert (
        client.get(
            "/api/progress", params={"library": "library", "path": "sample.cbz"}, headers=ALICE
        ).json()["position"]
        is None
    )
    assert client.get("/api/progress/recent", headers=ALICE).json()["items"] == []


def test_progress_prefers_uid_over_username(client):
    both = {"X-Test-Uid": "uid-1", "X-Test-User": "alice"}
    body = {"library": "library", "path": "Series A/issue.cbz", "page": 2, "total": 3}
    assert client.post("/api/progress", json=body, headers=both).status_code == 204

    # same uid, renamed user => progress survives the rename
    renamed = {"X-Test-Uid": "uid-1", "X-Test-User": "alice-renamed"}
    assert client.get(
        "/api/progress", params={"library": "library", "path": "Series A/issue.cbz"},
        headers=renamed,
    ).json()["position"]["page"] == 2

    # different uid, same username => NOT the same person
    imposter = {"X-Test-Uid": "uid-2", "X-Test-User": "alice"}
    assert (
        client.get(
            "/api/progress", params={"library": "library", "path": "Series A/issue.cbz"},
            headers=imposter,
        ).json()["position"]
        is None
    )
    client.delete(
        "/api/progress", params={"library": "library", "path": "Series A/issue.cbz"},
        headers=both,
    )


def test_progress_validation(client):
    def post(over):
        body = {"library": "library", "path": "sample.cbz", "page": 1, "total": 3, **over}
        return client.post("/api/progress", json=body, headers=ALICE).status_code

    assert post({"page": -1}) == 400
    assert post({"page": 3}) == 400          # page must be < total
    assert post({"total": 0}) == 400
    assert post({"total": 200_000}) == 400   # sanity cap
    assert post({"library": "nope"}) == 404
    assert post({"path": "../outside.cbz"}) == 404   # confinement
    assert post({"path": "notes.txt"}) == 404        # not a comic
    assert post({"path": "missing.cbz"}) == 404      # no such file

    r = client.get("/api/progress", params={"library": "nope", "path": "x"}, headers=ALICE)
    assert r.status_code == 404


def test_progress_scope_partitions_local_storage_per_user(client):
    """/api/libraries carries an opaque per-user scope token (partitions the
    client's localStorage on shared browsers). Anonymous => null; stable per
    identity; different identities differ; keyed by uid when present (so a
    rename keeps the same scope => same local bucket)."""
    assert client.get("/api/libraries").json()["progress_scope"] is None

    s_alice = client.get("/api/libraries", headers=ALICE).json()["progress_scope"]
    s_bob = client.get("/api/libraries", headers=BOB).json()["progress_scope"]
    assert s_alice and s_bob and s_alice != s_bob
    assert client.get("/api/libraries", headers=ALICE).json()["progress_scope"] == s_alice
    assert s_alice != "alice" and len(s_alice) == 16  # opaque, not the identity

    # uid-keyed: same uid + renamed username => same scope
    s_u1 = client.get(
        "/api/libraries", headers={"X-Test-Uid": "u1", "X-Test-User": "alice"}
    ).json()["progress_scope"]
    s_u1_renamed = client.get(
        "/api/libraries", headers={"X-Test-Uid": "u1", "X-Test-User": "alice-renamed"}
    ).json()["progress_scope"]
    assert s_u1 == s_u1_renamed != s_alice


def test_tombstone_rows_are_served_to_merges_but_are_not_positions(client):
    """Forgetting is a page-0 tombstone POST (not a DELETE). The tombstone must
    reach other devices: GET returns it, and recent CARRIES it (page 0) so client
    merges can shadow stale local copies — but no page>0 position is listed."""
    body = {"library": "library", "path": "sample.cbz", "page": 0, "total": 3}
    assert client.post("/api/progress", json=body, headers=ALICE).status_code == 204
    pos = client.get(
        "/api/progress", params={"library": "library", "path": "sample.cbz"}, headers=ALICE
    ).json()["position"]
    assert pos["page"] == 0 and pos["updated_at"] > 0  # visible to the merge

    items = client.get("/api/progress/recent", headers=ALICE).json()["items"]
    stones = [i for i in items if i["path"] == "sample.cbz"]
    assert len(stones) == 1 and stones[0]["page"] == 0  # the shadow travels
    assert all(i["page"] == 0 for i in items if i["path"] == "sample.cbz")

    # a NEWER position write resurrects the comic (re-reading works)
    body = {"library": "library", "path": "sample.cbz", "page": 2, "total": 3}
    assert client.post("/api/progress", json=body, headers=ALICE).status_code == 204
    items = client.get("/api/progress/recent", headers=ALICE).json()["items"]
    assert [i["page"] for i in items if i["path"] == "sample.cbz"] == [2]
    client.delete(
        "/api/progress", params={"library": "library", "path": "sample.cbz"}, headers=ALICE
    )


def test_uid_and_username_namespaces_are_disjoint(client):
    """A username equal to someone else's uid must not address their rows
    (keys are tier-prefixed: "uid:…" vs "user:…")."""
    by_uid = {"X-Test-Uid": "1027"}
    by_name = {"X-Test-User": "1027"}
    body = {"library": "library", "path": "sample.cbz", "page": 1, "total": 3}
    assert client.post("/api/progress", json=body, headers=by_uid).status_code == 204
    assert (
        client.get(
            "/api/progress", params={"library": "library", "path": "sample.cbz"},
            headers=by_name,
        ).json()["position"]
        is None
    )
    client.delete(
        "/api/progress", params={"library": "library", "path": "sample.cbz"}, headers=by_uid
    )


def test_progress_paths_are_canonicalized(client):
    """Alias spellings of one comic collapse into one row — no row-inflation DoS,
    no duplicate continue-reading chips."""
    aliases = ["./sample.cbz", "Series A/../sample.cbz", "sample.cbz"]
    for i, alias in enumerate(aliases, start=1):
        body = {"library": "library", "path": alias, "page": i, "total": 5}
        assert client.post("/api/progress", json=body, headers=ALICE).status_code == 204

    items = client.get("/api/progress/recent", headers=ALICE).json()["items"]
    ours = [i for i in items if "sample" in i["path"]]
    assert len(ours) == 1                       # one row, not three
    assert ours[0]["path"] == "sample.cbz"      # stored canonical
    assert ours[0]["page"] == 3                 # last write won

    # reads canonicalize the same way
    pos = client.get(
        "/api/progress", params={"library": "library", "path": "./sample.cbz"},
        headers=ALICE,
    ).json()["position"]
    assert pos["page"] == 3
    client.delete(
        "/api/progress", params={"library": "library", "path": "sample.cbz"}, headers=ALICE
    )


def test_progress_rejects_oversized_names(client):
    long_path = "a/" * 600 + "x.cbz"  # > 1024 chars
    body = {"library": "library", "path": long_path, "page": 1, "total": 3}
    assert client.post("/api/progress", json=body, headers=ALICE).status_code == 400
    assert (
        client.delete(
            "/api/progress", params={"library": "library", "path": long_path}, headers=ALICE
        ).status_code
        == 400
    )


def test_recent_hides_but_keeps_unknown_library_rows(client):
    """Rows for a currently-missing library are invisible but NOT pruned — the
    library may come back. And they must not starve visible entries (the scan
    continues past them)."""
    from app.main import PROGRESS

    user_key = "user:alice"  # ALICE sends X-Test-User: alice
    for i in range(12):  # newer than anything else alice has
        PROGRESS.upsert(user_key, "ghost-lib", f"gone{i}.cbz", 1, 5)

    body = {"library": "library", "path": "sample.cbz", "page": 1, "total": 3}
    assert client.post("/api/progress", json=body, headers=ALICE).status_code == 204
    # make the 12 ghost rows the newest again
    for i in range(12):
        PROGRESS.upsert(user_key, "ghost-lib", f"gone{i}.cbz", 2, 5)

    items = client.get("/api/progress/recent", headers=ALICE).json()["items"]
    assert all(i["library"] != "ghost-lib" for i in items)          # hidden
    assert any(i["path"] == "sample.cbz" for i in items)            # not starved
    assert PROGRESS.get(user_key, "ghost-lib", "gone0.cbz") is not None  # kept

    # rows for a removed library must still be deletable (no immortal rows)
    assert (
        client.delete(
            "/api/progress", params={"library": "ghost-lib", "path": "gone0.cbz"},
            headers=ALICE,
        ).status_code
        == 204
    )
    assert PROGRESS.get(user_key, "ghost-lib", "gone0.cbz") is None
    for i in range(1, 12):
        PROGRESS.delete(user_key, "ghost-lib", f"gone{i}.cbz")
    client.delete(
        "/api/progress", params={"library": "library", "path": "sample.cbz"}, headers=ALICE
    )


def test_progress_inert_when_headers_unconfigured(client, monkeypatch):
    """The true default deployment (no identity headers CONFIGURED at all) must be
    inert even for requests that happen to send identity-looking headers."""
    import app.main as m

    monkeypatch.setattr(m, "USER_HEADER", None)
    monkeypatch.setattr(m, "UID_HEADER", None)
    assert client.get("/api/libraries", headers=ALICE).json()["progress"] is False
    body = {"library": "library", "path": "sample.cbz", "page": 1, "total": 3}
    assert client.post("/api/progress", json=body, headers=ALICE).status_code == 204
    r = client.get(
        "/api/progress", params={"library": "library", "path": "sample.cbz"}, headers=ALICE
    )
    assert r.json()["position"] is None
    assert client.get("/api/progress/recent", headers=ALICE).json()["items"] == []
    # the no-op POST really stored nothing, under either key namespace
    assert m.PROGRESS.get("user:alice", "library", "sample.cbz") is None
    assert m.PROGRESS.get("uid:alice", "library", "sample.cbz") is None


def test_recent_prunes_deleted_comics(client):
    doomed = LIB_DIR / "doomed.cbz"
    doomed.write_bytes((LIB_DIR / "sample.cbz").read_bytes())
    try:
        body = {"library": "library", "path": "doomed.cbz", "page": 1, "total": 3}
        assert client.post("/api/progress", json=body, headers=ALICE).status_code == 204
        assert any(
            i["path"] == "doomed.cbz"
            for i in client.get("/api/progress/recent", headers=ALICE).json()["items"]
        )
    finally:
        doomed.unlink()

    # the comic is gone but its library is fine => the row is hidden AND pruned
    items = client.get("/api/progress/recent", headers=ALICE).json()["items"]
    assert all(i["path"] != "doomed.cbz" for i in items)
    assert (
        client.get(
            "/api/progress", params={"library": "library", "path": "doomed.cbz"}, headers=ALICE
        ).json()["position"]
        is None
    )
