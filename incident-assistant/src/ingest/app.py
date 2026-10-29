import json
import os
import hashlib
import uuid
from datetime import datetime, timezone

import boto3

sqs = boto3.client("sqs")
QUEUE_URL = os.environ["QUEUE_URL"]


def normalize_generic(body: dict) -> dict:
    """Custom webhook format: {source, title, description, service, severity_hint}"""
    return {
        "source": str(body.get("source", "webhook")),
        "title": str(body.get("title", "Untitled alert"))[:200],
        "description": str(body.get("description", ""))[:2000],
        "service": str(body.get("service", "unknown")),
        "severity_hint": str(body.get("severity_hint", "")).lower(),
    }


def normalize_cloudwatch(event: dict) -> dict:
    """EventBridge 'CloudWatch Alarm State Change' format."""
    detail = event.get("detail", {}) or {}
    state = detail.get("state", {}) or {}
    cfg = detail.get("configuration", {}) or {}

    service = "aws"
    metrics = cfg.get("metrics") or []
    if metrics:
        service = (
            (metrics[0].get("metricStat") or {}).get("metric", {}).get("namespace", "aws")
        )

    return {
        "source": "cloudwatch",
        "title": f"Alarm: {detail.get('alarmName', 'unknown')}",
        "description": str(state.get("reason", ""))[:2000],
        "service": service,
        "severity_hint": "",
    }


def make_fingerprint(alert: dict) -> str:
    """Same source+service+title => same 'type' of incident (for pattern analysis)."""
    raw = f"{alert['source']}|{alert['service']}|{alert['title']}".lower()
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


CORS_HEADERS = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
}


def respond(code, payload):
    return {"statusCode": code, "headers": CORS_HEADERS, "body": json.dumps(payload)}


def handler(event, context):
    # EventBridge events have a 'detail-type'; API Gateway events have 'body'
    if "detail-type" in event:
        alert = normalize_cloudwatch(event)
        api_call = False
    else:
        api_call = True
        try:
            body = json.loads(event.get("body") or "{}")
        except json.JSONDecodeError:
            return respond(400, {"error": "Invalid JSON"})
        if not isinstance(body, dict) or "title" not in body:
            return respond(400, {"error": "'title' is required"})
        alert = normalize_generic(body)

    alert["incident_id"] = str(uuid.uuid4())
    alert["fingerprint"] = make_fingerprint(alert)
    alert["created_at"] = datetime.now(timezone.utc).isoformat()

    sqs.send_message(QueueUrl=QUEUE_URL, MessageBody=json.dumps(alert))
    print(f"Queued incident {alert['incident_id']} from {alert['source']}")

    if api_call:
        return respond(202, {"incident_id": alert["incident_id"], "status": "queued"})

    return {"status": "queued"}
