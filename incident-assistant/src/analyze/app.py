import json
import os
from datetime import datetime, timezone

import boto3
from boto3.dynamodb.conditions import Key

dynamodb = boto3.resource("dynamodb")
table = dynamodb.Table(os.environ["TABLE_NAME"])
sns = boto3.client("sns")

TOPIC_ARN = os.environ["TOPIC_ARN"]

SEVERITY_ORDER = ["low", "medium", "high", "critical"]

CRITICAL_WORDS = ["outage", "down", "data loss", "breach", "unreachable", "corrupt"]
HIGH_WORDS = [
    "error rate", "5xx", "500 error", "http 500", "status 500", "internal server error",
    "timeout", "failed", "failure", "cpu 9", "memory 9", "disk full",
]
MEDIUM_WORDS = ["latency", "slow", "warning", "degraded", "retry"]

# (keywords, probable root cause, category of remediation steps)
ROOT_CAUSE_RULES = [
    (["timeout", "timed out", "unreachable"],
     "A downstream dependency is slow or unreachable.", "dependency"),
    (["5xx", "error rate", "failed", "500 error", "http 500", "status 500", "internal server error"],
     "The service is returning server errors, possibly after a recent change.", "errors"),
    (["cpu"],
     "CPU is saturated, possibly from heavy load or a runaway process.", "resource"),
    (["memory"],
     "Memory pressure, possibly a leak or an undersized instance.", "resource"),
    (["disk"],
     "Disk space is full or nearly full.", "resource"),
    (["latency", "slow", "degraded"],
     "Increased load or a slow dependency is causing latency.", "dependency"),
    (["outage", "down", "data loss", "corrupt", "breach"],
     "The service or its data store is unavailable or damaged.", "errors"),
]

STEPS_BY_CATEGORY = {
    "dependency": [
        "Check the health and latency of downstream services and databases.",
        "Verify network connectivity and security group or firewall rules.",
        "Consider a rollback if the problem started after a deployment.",
    ],
    "errors": [
        "Compare the error rate with the time of the last deployment.",
        "Check application logs for stack traces around the spike.",
        "Roll back the latest release if the errors began after it.",
    ],
    "resource": [
        "Check resource usage graphs for the affected host or service.",
        "Scale up or out, or free resources by stopping unneeded jobs.",
        "Look for leaks or runaway processes before restarting anything.",
    ],
}


def rule_based_severity(alert: dict, recurrence: int) -> str:
    """Simple, explainable scoring."""
    text = f"{alert.get('title', '')} {alert.get('description', '')}".lower()
    score = 0
    if any(w in text for w in CRITICAL_WORDS):
        score = 3
    elif any(w in text for w in HIGH_WORDS):
        score = 2
    elif any(w in text for w in MEDIUM_WORDS):
        score = 1

    hint = alert.get("severity_hint", "")
    if hint in SEVERITY_ORDER:
        score = max(score, SEVERITY_ORDER.index(hint))

    # Repeating problems get escalated one level
    if recurrence >= 3 and score < 3:
        score += 1
    return SEVERITY_ORDER[score]


def rule_based_analysis(alert: dict, history: list) -> dict:
    """No AI model: map keywords to a likely cause and standard remediation steps."""
    text = f"{alert.get('title', '')} {alert.get('description', '')}".lower()

    cause = "Cause not identified from the alert text. Review the raw alert and logs."
    category = "errors"
    for keywords, description, cat in ROOT_CAUSE_RULES:
        if any(k in text for k in keywords):
            cause = description
            category = cat
            break

    past = ""
    if history:
        past = f" This alert pattern has occurred {len(history)} time(s) before."

    return {
        "summary": (
            f"{alert.get('title', 'Alert')} on "
            f"{alert.get('service', 'unknown service')}.{past}"
        ),
        "probable_root_cause": cause,
        "remediation_steps": STEPS_BY_CATEGORY[category],
        "confidence": "low",
    }


def find_similar(fingerprint: str, limit: int = 5):
    resp = table.query(
        IndexName="fingerprint-index",
        KeyConditionExpression=Key("fingerprint").eq(fingerprint),
        ScanIndexForward=False,
        Limit=limit,
    )
    return resp.get("Items", [])


def process(alert: dict):
    history = find_similar(alert["fingerprint"])
    severity = rule_based_severity(alert, recurrence=len(history))
    analysis = rule_based_analysis(alert, history)

    steps = analysis["remediation_steps"]
    item = {
        **alert,
        "severity": severity,
        "status": "open",
        "summary": analysis["summary"],
        "probable_root_cause": analysis["probable_root_cause"],
        "remediation": "\n".join(f"{i + 1}. {s}" for i, s in enumerate(steps)),
        "confidence": analysis["confidence"],
        "recurrence_count": len(history),
        "analyzed_at": datetime.now(timezone.utc).isoformat(),
    }
    table.put_item(Item=item)

    if severity in ("high", "critical"):
        sns.publish(
            TopicArn=TOPIC_ARN,
            Subject=f"[{severity.upper()}] {alert['title']}"[:100],
            Message=(
                f"Severity: {severity.upper()}\n"
                f"Service: {alert.get('service')}\n"
                f"Seen before: {len(history)} time(s)\n\n"
                f"SUMMARY\n{item['summary']}\n\n"
                f"PROBABLE ROOT CAUSE\n{item['probable_root_cause']}\n\n"
                f"RECOMMENDED STEPS\n{item['remediation']}\n\n"
                f"Incident ID: {alert['incident_id']}"
            ),
        )


def handler(event, context):
    failures = []
    for record in event["Records"]:
        try:
            process(json.loads(record["body"]))
        except Exception as exc:
            print(f"Failed {record['messageId']}: {exc}")
            failures.append({"itemIdentifier": record["messageId"]})
    # Only failed messages are retried; successful ones are removed from the queue
    return {"batchItemFailures": failures}
