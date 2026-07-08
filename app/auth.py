"""Optional, proxy-delegated identity + library-management authorization.

Comic Cascade never authenticates anyone itself. If the deployer configures a
trusted identity header (``CASCADE_USER_HEADER``), the app reads the current user
from it — the header is expected to be set by a forward-auth reverse proxy
(Authentik, Authelia, oauth2-proxy, Tailscale Serve, …). With no header
configured the app stays anonymous and global, exactly as before.

``can_manage`` gates *library management* (add / remove / reorder, and the
directory picker). Reading and browsing are never gated here.
"""

from __future__ import annotations

import re

from fastapi import Request

# Proxies join multiple groups into one header value with different separators
# (Authentik uses "|", Authelia / oauth2-proxy use ","). Split on either so the
# feature works across proxies without per-deployment configuration.
_GROUP_SEP = re.compile(r"[|,]")


def current_user(request: Request, user_header: str | None) -> str | None:
    """The identity the proxy asserts for this request, or None when no header is
    configured or present."""
    if not user_header:
        return None
    value = request.headers.get(user_header)
    return value.strip() if value and value.strip() else None


def user_groups(request: Request, groups_header: str | None) -> frozenset[str]:
    """The groups the proxy asserts for this request (empty when no header is
    configured or present)."""
    if not groups_header:
        return frozenset()
    value = request.headers.get(groups_header)
    if not value:
        return frozenset()
    return frozenset(g.strip() for g in _GROUP_SEP.split(value) if g.strip())


def can_manage(
    user: str | None,
    *,
    managed: bool,
    admins: frozenset[str],
    groups: frozenset[str] = frozenset(),
    admin_groups: frozenset[str] = frozenset(),
) -> bool:
    """Whether this request may manage libraries.

    - ``managed`` must be True (a browse root is configured) — else management is off.
    - With no allowlists (neither ``admins`` nor ``admin_groups``), management is open
      to anyone who reaches the app (today's behavior).
    - Otherwise the request must match: a ``user`` on the ``admins`` list, OR one of
      the request's ``groups`` in ``admin_groups``. Fail closed — an unidentified
      request (no header) matches nothing."""
    if not managed:
        return False
    if not admins and not admin_groups:
        return True
    if user is not None and user in admins:
        return True
    return bool(groups & admin_groups)
