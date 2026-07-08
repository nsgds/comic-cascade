"""API integration tests using a temporary library (see conftest.py)."""


def test_libraries(client):
    j = client.get("/api/libraries").json()
    assert j["managed"] is True
    assert "library" in [lib["id"] for lib in j["libraries"]]


def test_healthz(client):
    j = client.get("/api/healthz").json()
    assert j["unar"] is True
    assert j["libraries"][0]["readable"] is True


def test_healthz_does_not_leak_host_paths(client):
    """healthz reports readiness only — no absolute filesystem paths."""
    j = client.get("/api/healthz").json()
    assert "cache_dir" not in j
    assert all("path" not in lib for lib in j["libraries"])


def test_responses_set_nosniff(client):
    """Every response carries X-Content-Type-Options: nosniff."""
    r = client.get("/api/healthz")
    assert r.headers.get("x-content-type-options") == "nosniff"


def test_tree_lists_dirs_first_and_filters_non_comics(client):
    j = client.get("/api/tree", params={"library": "library", "path": ""}).json()
    names = [e["name"] for e in j["entries"]]
    # "Series A" (dir) first; notes.txt hidden by default; comics shown
    assert names[0] == "Series A"
    assert "notes.txt" not in names
    assert "sample.cbz" in names


def test_tree_show_all_reveals_non_comics(client):
    j = client.get(
        "/api/tree", params={"library": "library", "path": "", "show_all": 1}
    ).json()
    names = [e["name"] for e in j["entries"]]
    assert "notes.txt" in names


def test_tree_traversal_confined(client):
    r = client.get("/api/tree", params={"library": "library", "path": "../.."})
    assert r.status_code == 404
    r = client.get("/api/tree", params={"library": "nope", "path": ""})
    assert r.status_code == 404


def test_comic_and_page_roundtrip(client):
    meta = client.get("/api/comic", params={"library": "library", "path": "sample.cbz"}).json()
    assert meta["format"] == "zip"
    assert meta["page_count"] == 3
    # natural order preserved: page1 (80x120) is first
    assert meta["dims"][0] == {"w": 80, "h": 120}

    r = client.get("/api/page", params={"library": "library", "path": "sample.cbz", "index": 0})
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/jpeg"
    assert "immutable" in r.headers["cache-control"]


def test_page_out_of_range(client):
    r = client.get("/api/page", params={"library": "library", "path": "sample.cbz", "index": 999})
    assert r.status_code == 404


def test_corrupt_archive_returns_422(client):
    r = client.get("/api/comic", params={"library": "library", "path": "garbage.cbz"})
    assert r.status_code == 422


def test_empty_archive_returns_422(client):
    r = client.get("/api/comic", params={"library": "library", "path": "empty.cbz"})
    assert r.status_code == 422


def test_non_comic_returns_400(client):
    r = client.get("/api/comic", params={"library": "library", "path": "notes.txt"})
    assert r.status_code == 400


# ---- library management (browse root enabled in conftest) ----


def test_fs_lists_subdirs(client):
    j = client.get("/api/fs", params={"path": ""}).json()
    assert "Series A" in j["dirs"]


def test_fs_confined_to_browse_root(client):
    assert client.get("/api/fs", params={"path": "../.."}).status_code == 404


def test_add_browse_and_remove_library(client):
    r = client.post("/api/libraries", json={"name": "My Series", "path": "Series A"})
    assert r.status_code == 200
    new_id = r.json()["id"]

    ids = [lib["id"] for lib in client.get("/api/libraries").json()["libraries"]]
    assert new_id in ids

    # the new library is independently browsable
    tree = client.get("/api/tree", params={"library": new_id, "path": ""}).json()
    assert any(e["name"] == "issue.cbz" for e in tree["entries"])

    assert client.delete(f"/api/libraries/{new_id}").status_code == 200
    ids_after = [lib["id"] for lib in client.get("/api/libraries").json()["libraries"]]
    assert new_id not in ids_after


def test_reorder_libraries(client):
    r = client.post("/api/libraries", json={"name": "Second", "path": "Series A"})
    assert r.status_code == 200
    sid = r.json()["id"]

    before = [lib["id"] for lib in client.get("/api/libraries").json()["libraries"]]
    assert len(before) >= 2

    rv = client.put("/api/libraries/order", json={"order": list(reversed(before))})
    assert rv.status_code == 200
    assert rv.json()["order"] == list(reversed(before))

    after = [lib["id"] for lib in client.get("/api/libraries").json()["libraries"]]
    assert after == list(reversed(before))

    assert client.delete(f"/api/libraries/{sid}").status_code == 200


def test_admin_allowlist_gates_management(client, monkeypatch):
    """With CASCADE_ADMINS set, only the proxy-identified admin may manage."""
    import app.main as m

    monkeypatch.setattr(m, "USER_HEADER", "X-Remote-User")
    monkeypatch.setattr(m, "ADMINS", frozenset({"alice"}))

    # anonymous (no identity header) -> not an admin
    anon = client.get("/api/libraries").json()
    assert anon["managed"] is True and anon["can_manage"] is False
    order = [lib["id"] for lib in anon["libraries"]]
    assert client.get("/api/fs").status_code == 403
    assert client.put("/api/libraries/order", json={"order": order}).status_code == 403

    # a user not on the allowlist -> still 403
    assert client.get("/api/fs", headers={"X-Remote-User": "mallory"}).status_code == 403

    # the admin -> allowed
    hdr = {"X-Remote-User": "alice"}
    assert client.get("/api/libraries", headers=hdr).json()["can_manage"] is True
    assert client.get("/api/fs", headers=hdr).status_code == 200
    assert (
        client.put("/api/libraries/order", json={"order": order}, headers=hdr).status_code
        == 200
    )


def test_admin_group_gates_management(client, monkeypatch):
    """Management can be granted by group membership from a proxy groups header,
    with no per-user allowlist to maintain."""
    import app.main as m

    monkeypatch.setattr(m, "USER_HEADER", "X-Remote-User")
    monkeypatch.setattr(m, "ADMINS", frozenset())  # no user allowlist
    monkeypatch.setattr(m, "GROUPS_HEADER", "X-Remote-Groups")
    monkeypatch.setattr(m, "ADMIN_GROUPS", frozenset({"comic-admins"}))

    order = [lib["id"] for lib in client.get("/api/libraries").json()["libraries"]]

    # a user NOT in the admin group -> denied
    nonadmin = {"X-Remote-User": "carol", "X-Remote-Groups": "users|viewers"}
    assert client.get("/api/libraries", headers=nonadmin).json()["can_manage"] is False
    assert client.get("/api/fs", headers=nonadmin).status_code == 403

    # a user in the admin group -> allowed (note the pipe-separated groups)
    admin = {"X-Remote-User": "carol", "X-Remote-Groups": "users|comic-admins"}
    assert client.get("/api/libraries", headers=admin).json()["can_manage"] is True
    assert client.get("/api/fs", headers=admin).status_code == 200
    assert (
        client.put("/api/libraries/order", json={"order": order}, headers=admin).status_code
        == 200
    )


def test_add_outside_browse_root_rejected(client):
    r = client.post("/api/libraries", json={"name": "x", "path": "../../etc"})
    assert r.status_code == 400
