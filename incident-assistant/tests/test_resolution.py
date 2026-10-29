import importlib.util
import json
import os
import sys

os.environ.update({
    "TABLE_NAME": "t",
    "TOPIC_ARN": "arn",
    "AWS_DEFAULT_REGION": "ap-south-1",
})
sys.path.insert(0, "src/api")
_spec = importlib.util.spec_from_file_location("api_app", "src/api/app.py")
api = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(api)


class FakeNotFound(Exception):
    pass


class FakeTable:
    def __init__(self, item=None):
        self.item = item
        self.calls = []
        self.meta = type("Meta", (), {})()
        self.meta.client = type("Client", (), {})()
        self.meta.client.exceptions = type("Exc", (), {"ConditionalCheckFailedException": FakeNotFound})

    def update_item(self, **kwargs):
        self.calls.append(kwargs)
        if self.item is None:
            raise FakeNotFound()
        return {"Attributes": {"incident_id": kwargs["Key"]["incident_id"]}}

    def get_item(self, Key):
        return {"Item": self.item} if self.item else {}


def body(**fields):
    return json.dumps(fields)


def test_resolve_requires_note():
    try:
        api.parse_update(body(status="resolved"))
    except ValueError as exc:
        assert "resolution note" in str(exc)
    else:
        raise AssertionError("resolving without a note should be rejected")


def test_resolve_with_note_is_accepted():
    updates = api.parse_update(body(status="resolved", resolution_note="  Rolled back v2.3.1  "))
    assert updates == {"status": "resolved", "resolution_note": "Rolled back v2.3.1"}


def test_invalid_status_rejected():
    try:
        api.parse_update(body(status="closed"))
    except ValueError as exc:
        assert "status must be one of" in str(exc)
    else:
        raise AssertionError("unknown status should be rejected")


def test_unhashable_status_rejected():
    try:
        api.parse_update(body(status=["resolved"]))
    except ValueError:
        pass
    else:
        raise AssertionError("list status should be rejected")


def test_completed_steps_normalised():
    updates = api.parse_update(body(completed_steps=[2, 0, 2]))
    assert updates == {"completed_steps": [0, 2]}


def test_completed_steps_rejects_bools_and_strings():
    for bad in ([True], ["1"], "1", [-1]):
        try:
            api.parse_update(body(completed_steps=bad))
        except ValueError:
            continue
        raise AssertionError(f"{bad!r} should be rejected")


def test_empty_update_rejected():
    try:
        api.parse_update(body(unknown="x"))
    except ValueError as exc:
        assert "Nothing to update" in str(exc)
    else:
        raise AssertionError("empty update should be rejected")


def test_resolve_sets_resolved_at():
    table = FakeTable(item={"incident_id": "abc"})
    api.table = table
    resp = api.update_incident("abc", body(status="resolved", resolution_note="Fixed", resolved_by="Priya"))
    assert resp["statusCode"] == 200
    call = table.calls[0]
    assert "resolved_at" in call["ExpressionAttributeNames"].values()
    assert "REMOVE" not in call["UpdateExpression"]
    assert call["ReturnValues"] == "ALL_NEW"


def test_reopen_clears_resolved_at():
    table = FakeTable(item={"incident_id": "abc"})
    api.table = table
    api.update_incident("abc", body(status="open"))
    assert "REMOVE #resolved_at" in table.calls[0]["UpdateExpression"]


def test_update_missing_incident_returns_404():
    api.table = FakeTable(item=None)
    resp = api.update_incident("nope", body(status="acknowledged"))
    assert resp["statusCode"] == 404


def test_public_view_hides_internal_fields():
    item = {
        "incident_id": "abc",
        "title": "Checkout failed",
        "status": "resolved",
        "description": "stack trace...",
        "probable_root_cause": "internal",
        "resolution_note": "Rolled back",
        "resolved_by": "Priya",
        "resolved_at": "2026-10-29T10:00:00+00:00",
    }
    view = api.public_view(item)
    assert set(view) == {"incident_id", "title", "status", "resolution_note", "resolved_at"}


def test_public_view_hides_resolution_until_resolved():
    item = {
        "incident_id": "abc",
        "title": "Checkout failed",
        "status": "acknowledged",
        "resolution_note": "old note",
        "resolved_at": "2026-10-29T10:00:00+00:00",
    }
    view = api.public_view(item)
    assert "resolution_note" not in view and "resolved_at" not in view


def test_public_status_unknown_incident_404():
    api.table = FakeTable(item=None)
    assert api.public_status("missing")["statusCode"] == 404


def test_public_status_returns_safe_payload():
    api.table = FakeTable(item={"incident_id": "abc", "title": "t", "status": "open", "resolved_by": "x"})
    resp = api.public_status("abc")
    payload = json.loads(resp["body"])
    assert resp["statusCode"] == 200
    assert "resolved_by" not in payload
    assert payload["status"] == "open"
