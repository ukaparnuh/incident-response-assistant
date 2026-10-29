import os
import sys

os.environ.update({
    "TABLE_NAME": "t",
    "TOPIC_ARN": "arn",
    "AWS_DEFAULT_REGION": "ap-south-1",
})
sys.path.insert(0, "src/analyze")
from app import rule_based_severity, rule_based_analysis  # noqa: E402


def alert(title, desc="", hint=""):
    return {"title": title, "description": desc, "severity_hint": hint, "service": "svc"}


def test_outage_is_critical():
    assert rule_based_severity(alert("Service outage"), 0) == "critical"


def test_latency_is_medium():
    assert rule_based_severity(alert("High latency"), 0) == "medium"


def test_recurrence_escalates():
    assert rule_based_severity(alert("High latency"), 3) == "high"


def test_hint_respected():
    assert rule_based_severity(alert("Minor thing", hint="high"), 0) == "high"


def test_analysis_picks_dependency_cause():
    result = rule_based_analysis(alert("Request timeout to database"), [])
    assert "dependency" in result["probable_root_cause"].lower()
    assert len(result["remediation_steps"]) == 3


def test_checkout_500_is_high_without_hint():
    assert rule_based_severity(alert("Checkout API 500 error in demo store"), 0) == "high"


def test_checkout_500_gets_server_error_cause():
    result = rule_based_analysis(alert("Checkout API 500 error in demo store"), [])
    assert "server errors" in result["probable_root_cause"].lower()


def test_analysis_mentions_history():
    result = rule_based_analysis(alert("High CPU"), [{"x": 1}, {"x": 2}])
    assert "2 time(s)" in result["summary"]
