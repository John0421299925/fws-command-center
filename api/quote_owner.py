"""
FWS Auto Quotation Agent — who may act on a quote.

Version: v1.0
v1.0: first release. Only the person who requested a quote may approve or
      send it. A quote with no recorded requester can be acted on only by
      John or James. The check runs here, on the server, so the Command Centre
      page cannot skip it.

The Command Centre proxy sends the logged-in person's email in X-Requested-By
and the shared secret in X-CC-Secret. A request without the right secret is
refused before anything else happens.
"""
import os
import re

import requests

from .shared_logic import HUBSPOT_API_BASE, HUBSPOT_API_KEY, JAMES_EMAIL, JOHN_EMAIL

PROXY_SECRET = os.getenv("CC_PROXY_SECRET")
REQUESTED_BY = re.compile(r"REQUESTED_BY:([^\s]+)")


def caller_from_request(req):
    """The logged-in person's email, or None if the secret is missing or wrong."""
    if not PROXY_SECRET or req.headers.get("X-CC-Secret") != PROXY_SECRET:
        return None
    caller = (req.headers.get("X-Requested-By") or "").strip().lower()
    return caller or None


def requester_of(content):
    """The email recorded as REQUESTED_BY on the ticket, lower-cased, or None."""
    match = REQUESTED_BY.search(content or "")
    return match.group(1).strip().lower() if match else None


def may_act(content, caller):
    """Pure rule, no network: the requester acts on their own quote; unowned quotes are for John and James."""
    if not caller:
        return False
    owner = requester_of(content)
    if owner is None:
        return caller in {JAMES_EMAIL.lower(), JOHN_EMAIL.lower()}
    return caller == owner


def ticket_content(ticket_id):
    resp = requests.get(
        f"{HUBSPOT_API_BASE}/crm/v3/objects/tickets/{ticket_id}",
        headers={"Authorization": f"Bearer {HUBSPOT_API_KEY}"},
        params={"properties": "content"},
    )
    resp.raise_for_status()
    return resp.json().get("properties", {}).get("content", "") or ""


def caller_may_act(ticket_id, caller):
    return may_act(ticket_content(ticket_id), caller)
