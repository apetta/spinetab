"""Show independent-review progress without granting the model write access."""

import os
import re
import sys

from review import REVIEW_APP_ID, REVIEW_CHECK, api, output, require

APP_ID = REVIEW_APP_ID
NAME = REVIEW_CHECK


def context():
    require(not os.environ.get("CLAUDE_CODE_OAUTH_TOKEN") and not os.environ.get("ANTHROPIC_API_KEY"),
            "Status job must not hold model credentials")
    head = os.environ["EXPECTED_HEAD"]
    run = os.environ["GITHUB_RUN_ID"]
    number = os.environ["PR_NUMBER"]
    require(re.fullmatch(r"[0-9a-f]{40}", head), "Invalid review commit")
    require(re.fullmatch(r"[1-9][0-9]*", run) and re.fullmatch(r"[1-9][0-9]*", number), "Invalid review context")
    return head, run, number


def start():
    head, run, number = context()
    check = api("/check-runs", "POST", {
        "name": NAME, "head_sha": head, "status": "in_progress",
        "external_id": run,
        "details_url": f"https://github.com/apetta/spinetab/actions/runs/{run}",
        "output": {"title": "Independent review in progress",
                   "summary": f"Reviewing PR #{number} at `{head}`. Formal approval is posted separately."},
    }, token=os.environ["CHECK_TOKEN"])
    require(check["app"]["id"] == APP_ID and check["head_sha"] == head, "Unexpected review check")
    output(check_id=check["id"])


def finish():
    head, run, number = context()
    check_id = os.environ["CHECK_ID"]
    require(re.fullmatch(r"[1-9][0-9]*", check_id), "Invalid review check ID")
    token = os.environ["CHECK_TOKEN"]
    check = api(f"/check-runs/{check_id}", token=token)
    require(check["app"]["id"] == APP_ID and check["name"] == NAME
            and check["head_sha"] == head and check["external_id"] == run, "Unrelated review check")
    analysis, review = os.environ["ANALYSIS_RESULT"], os.environ["REVIEW_RESULT"]
    decision = os.environ.get("DECISION", "")
    if "cancelled" in (analysis, review):
        conclusion, title = "cancelled", "Review cancelled"
    elif analysis != "success" or review != "success":
        conclusion, title = "failure", "Review did not complete"
    elif decision == "approve":
        conclusion, title = "success", "Approved"
    elif decision == "request_changes":
        conclusion, title = "failure", "Changes requested"
    elif decision == "escalate":
        conclusion, title = "action_required", "Needs attention"
    else:
        raise ValueError("Missing review decision")
    api(f"/check-runs/{check_id}", "PATCH", {
        "status": "completed", "conclusion": conclusion,
        "output": {"title": title,
                   "summary": f"{title} for PR #{number} at `{head}`. See the workflow and formal PR review for details."},
    }, token=token)


if __name__ == "__main__":
    {"start": start, "finish": finish}[sys.argv[1]]()
