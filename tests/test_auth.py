"""Unit tests for the optional proxy-identity + management-authorization helpers."""

from app.auth import can_manage, current_user, user_groups


class _Req:
    def __init__(self, headers):
        self.headers = headers


def test_current_user_reads_configured_header():
    req = _Req({"X-Remote-User": "alice"})
    assert current_user(req, "X-Remote-User") == "alice"
    assert current_user(req, None) is None              # no header configured
    assert current_user(_Req({}), "X-Remote-User") is None  # header absent


def test_current_user_strips_blank_to_none():
    assert current_user(_Req({"X-U": "  bob  "}), "X-U") == "bob"
    assert current_user(_Req({"X-U": "   "}), "X-U") is None


def test_user_groups_splits_on_pipe_or_comma():
    # Authentik joins with "|"; Authelia / oauth2-proxy use ",". Both work.
    assert user_groups(_Req({"G": "admins|users"}), "G") == frozenset({"admins", "users"})
    assert user_groups(_Req({"G": "admins, users"}), "G") == frozenset({"admins", "users"})
    # group names may contain spaces
    assert user_groups(_Req({"G": "authentik Admins|Viewers"}), "G") == frozenset(
        {"authentik Admins", "Viewers"}
    )
    assert user_groups(_Req({"G": ""}), "G") == frozenset()    # present but empty
    assert user_groups(_Req({}), "G") == frozenset()           # absent
    assert user_groups(_Req({"G": "x"}), None) == frozenset()  # not configured


def test_can_manage_rules():
    # management off entirely (no browse root)
    assert can_manage("alice", managed=False, admins=frozenset()) is False
    # no allowlist => open to anyone (today's behavior) once management is on
    assert can_manage(None, managed=True, admins=frozenset()) is True
    assert can_manage("alice", managed=True, admins=frozenset()) is True
    # user allowlist => only listed users; an unidentified user fails closed
    admins = frozenset({"alice", "bob"})
    assert can_manage("alice", managed=True, admins=admins) is True
    assert can_manage("carol", managed=True, admins=admins) is False
    assert can_manage(None, managed=True, admins=admins) is False


def test_can_manage_by_group():
    admin_groups = frozenset({"comic-admins"})
    # in an admin group => allowed, even with no user allowlist match
    assert can_manage(
        "carol", managed=True, admins=frozenset(), groups=frozenset({"comic-admins"}),
        admin_groups=admin_groups,
    ) is True
    # not in any admin group => denied
    assert can_manage(
        "carol", managed=True, admins=frozenset(), groups=frozenset({"users"}),
        admin_groups=admin_groups,
    ) is False
    # user allowlist OR group membership — either grants access
    assert can_manage(
        "alice", managed=True, admins=frozenset({"alice"}), groups=frozenset(),
        admin_groups=admin_groups,
    ) is True
    # admin_groups configured but request has no groups => fails closed
    assert can_manage(
        None, managed=True, admins=frozenset(), groups=frozenset(),
        admin_groups=admin_groups,
    ) is False
