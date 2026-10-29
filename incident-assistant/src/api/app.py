import json
import os
from collections import Counter
from datetime import datetime, timezone
from decimal import Decimal

import boto3

table = boto3.resource("dynamodb").Table(os.environ["TABLE_NAME"])
RANK = {"critical": 0, "high": 1, "medium": 2, "low": 3}
VALID_STATUS = {"open", "acknowledged", "resolved"}
MAX_NOTE = 2000
MAX_NAME = 100
MAX_STEPS = 20
# Only these fields are returned to customers; internal fields (resolved_by, description, ...) are never exposed.
PUBLIC_FIELDS = ("incident_id", "title", "service", "status", "created_at", "updated_at", "resolved_at", "resolution_note")


def default(o):
    if isinstance(o, Decimal):
        return int(o) if o % 1 == 0 else float(o)
    raise TypeError


def respond(code, payload):
    return {
        "statusCode": code,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
        },
        "body": json.dumps(payload, default=default),
    }



def scan_all(limit=500):
    items, kwargs = [], {}
    while len(items) < limit:
        resp = table.scan(**kwargs)
        items.extend(resp.get("Items", []))
        if "LastEvaluatedKey" not in resp:
            break
        kwargs["ExclusiveStartKey"] = resp["LastEvaluatedKey"]
    return items[:limit]


def parse_update(body):
    """Validates a PATCH body and returns only the fields to store. Raises ValueError with a client-facing message."""
    try:
        data = json.loads(body or "{}")
    except json.JSONDecodeError:
        raise ValueError("Invalid JSON")
    if not isinstance(data, dict):
        raise ValueError("Body must be a JSON object")

    updates = {}
    if "status" in data:
        if not isinstance(data["status"], str) or data["status"] not in VALID_STATUS:
            raise ValueError(f"status must be one of {sorted(VALID_STATUS)}")
        updates["status"] = data["status"]

    if "resolution_note" in data:
        note = str(data["resolution_note"] or "").strip()
        if len(note) > MAX_NOTE:
            raise ValueError(f"resolution_note must be at most {MAX_NOTE} characters")
        updates["resolution_note"] = note

    if "resolved_by" in data:
        updates["resolved_by"] = str(data["resolved_by"] or "").strip()[:MAX_NAME]

    if "completed_steps" in data:
        steps = data["completed_steps"]
        valid = (
            isinstance(steps, list)
            and len(steps) <= MAX_STEPS
            and all(isinstance(s, int) and not isinstance(s, bool) and s >= 0 for s in steps)
        )
        if not valid:
            raise ValueError("completed_steps must be a list of step numbers")
        updates["completed_steps"] = sorted(set(steps))

    if not updates:
        raise ValueError("Nothing to update")
    if updates.get("status") == "resolved" and not updates.get("resolution_note"):
        raise ValueError("A resolution note is required before an incident can be resolved")
    return updates


def update_incident(incident_id, body):
    if not incident_id:
        return respond(400, {"error": "incident_id is required"})
    try:
        updates = parse_update(body)
    except ValueError as exc:
        return respond(400, {"error": str(exc)})

    now = datetime.now(timezone.utc).isoformat()
    fields = {**updates, "updated_at": now}
    if updates.get("status") == "resolved":
        fields["resolved_at"] = now

    names, values, clauses = {}, {}, []
    for n, (field, value) in enumerate(fields.items()):
        names[f"#f{n}"] = field
        values[f":v{n}"] = value
        clauses.append(f"#f{n} = :v{n}")
    expression = "SET " + ", ".join(clauses)
    if "status" in updates and updates["status"] != "resolved":
        names["#resolved_at"] = "resolved_at"
        expression += " REMOVE #resolved_at"

    try:
        resp = table.update_item(
            Key={"incident_id": incident_id},
            UpdateExpression=expression,
            ExpressionAttributeNames=names,
            ExpressionAttributeValues=values,
            ConditionExpression="attribute_exists(incident_id)",
            ReturnValues="ALL_NEW",
        )
    except table.meta.client.exceptions.ConditionalCheckFailedException:
        return respond(404, {"error": "Incident not found"})
    return respond(200, resp["Attributes"])


def public_view(item):
    view = {k: item[k] for k in PUBLIC_FIELDS if k in item}
    if view.get("status") != "resolved":
        view.pop("resolution_note", None)
        view.pop("resolved_at", None)
    return view


def public_status(incident_id):
    if not incident_id:
        return respond(400, {"error": "incident_id is required"})
    item = table.get_item(Key={"incident_id": incident_id}).get("Item")
    if not item:
        return respond(404, {"error": "Incident not found"})
    return respond(200, public_view(item))


def handler(event, context):
    method = event.get("httpMethod", "GET")
    path = event.get("path", "")
    params = event.get("queryStringParameters") or {}
    path_params = event.get("pathParameters") or {}

    if method == "PATCH":
        return update_incident(path_params.get("incident_id", ""), event.get("body"))

    if "/status/" in path:
        return public_status(path_params.get("incident_id", ""))

    items = scan_all()

    if path.endswith("/patterns"):
        counts = Counter(i["fingerprint"] for i in items if "fingerprint" in i)
        examples = {i["fingerprint"]: i for i in items if "fingerprint" in i}
        patterns = [
            {
                "title": examples[fp].get("title", ""),
                "service": examples[fp].get("service", ""),
                "occurrences": n,
                "latest_root_cause": examples[fp].get("probable_root_cause", ""),
            }
            for fp, n in counts.most_common(10)
            if n > 1
        ]
        return respond(200, {"recurring_incidents": patterns})

    wanted = params.get("severity")
    if wanted:
        items = [i for i in items if i.get("severity") == wanted]
    items.sort(key=lambda i: i.get("created_at", ""), reverse=True)
    items.sort(key=lambda i: RANK.get(i.get("severity"), 9))
    return respond(200, {"count": len(items), "incidents": items[:50]})

