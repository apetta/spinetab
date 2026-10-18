"""Deliver verified supervisor requests and current-main CI failures to Claude."""

import json
import os
from pathlib import Path
import re
import sys
import urllib.request

from review import OWNER_ID, REPO, SUPERVISOR_APP, api, output, require, trusted_run_actor

MARKER = "<!-- spinetab-maintenance-handoff -->"


def prepare(event):
    require(os.environ.get("GITHUB_REPOSITORY") == REPO and
            os.environ.get("GITHUB_REF") == "refs/heads/main", "Handoff must run from trusted main")
    require(os.environ.get("RUNNER_DEBUG") != "1", "Disable debug logging for routine delivery")
    require(int(os.environ.get("GITHUB_RUN_ATTEMPT", "1")) == 1 or
            os.environ.get("GITHUB_TRIGGERING_ACTOR") == "apetta", "Only the owner can retry delivery")
    kind = os.environ["GITHUB_EVENT_NAME"]
    if kind == "workflow_run":
        run = api(f"/actions/runs/{event['workflow_run']['id']}")
        require(run["path"] == ".github/workflows/ci.yml" and run["head_branch"] == "main" and
                run["event"] in {"push", "workflow_dispatch"} and
                run["head_repository"]["full_name"] == REPO and
                trusted_run_actor(run.get("actor")) and trusted_run_actor(run.get("triggering_actor")),
                "Unexpected main CI origin")
        main = api("/git/ref/heads/main")["object"]["sha"]
        if run["head_sha"] != main or run["status"] != "completed" or run["conclusion"] != "failure":
            return None
        # One delivery per failing commit; a rerun alone must not create another worker.
        return {"key": "main-" + main, "work": {"repository": REPO, "kind": "main-ci-failure",
                "head": main, "run_id": run["id"]}}
    require(kind in {"issue_comment", "workflow_dispatch"}, "Unexpected handoff event")
    require(os.environ.get("GITHUB_ACTOR") == "apetta" and
            os.environ.get("GITHUB_TRIGGERING_ACTOR") == "apetta", "Only the owner can request delivery")
    if kind == "issue_comment":
        require(event.get("action") == "created" and event.get("sender", {}).get("id") == OWNER_ID,
                "Handoff must be a new owner comment")
    comment_id = event.get("inputs", {}).get("comment_id") if kind == "workflow_dispatch" else event["comment"]["id"]
    require(re.fullmatch(r"[1-9][0-9]*", str(comment_id)), "Invalid comment ID")
    comment = api(f"/issues/comments/{comment_id}")
    user, app = comment.get("user", {}), comment.get("performed_via_github_app") or {}
    require(user.get("id") == OWNER_ID and user.get("login") == "apetta" and user.get("type") == "User" and
            all(app.get(key) == value for key, value in SUPERVISOR_APP.items()),
            "Handoff must come from the supervisor's GitHub connection")
    require(comment.get("created_at") and comment["created_at"] == comment.get("updated_at"),
            "Edited handoff needs a fresh comment")
    target = re.fullmatch(r"https://api\.github\.com/repos/" + re.escape(REPO) + r"/issues/([1-9][0-9]*)",
                          comment["issue_url"])
    require(target is not None, "Handoff covers another repository")
    number = int(target[1])
    if kind == "issue_comment":
        require(number == event["issue"]["number"], "Handoff covers another issue")
    match = re.fullmatch(re.escape(MARKER) + r"\nHead: ([0-9a-f]{40})\nBase: ([0-9a-f]{40})\n\n([\s\S]{1,3000})",
                         comment.get("body") or "")
    require(match is not None and match[3].strip(), "Handoff needs full head/base commits and a task")
    pr = api(f"/pulls/{number}")
    require(pr["state"] == "open" and pr["base"]["ref"] == "main", "Handoff needs an open PR to main")
    require(pr["head"]["repo"] and pr["head"]["repo"]["full_name"] == REPO and
            pr["base"]["repo"]["full_name"] == REPO, "Fork work needs a separate isolated intake")
    require(pr["head"]["sha"] == match[1] and
            api("/git/ref/heads/main")["object"]["sha"] == match[2], "Handoff head or base changed")
    # The task stays in the verified comment. Do not copy arbitrary discussion into the API request.
    return {"key": "comment-" + str(comment_id), "work": {"repository": REPO, "kind": "supervisor-handoff",
            "pr": number, "head": match[1], "base": match[2], "comment_id": int(comment_id)}}


def dispatch(work, event):
    current = prepare(event)
    require(current and current["work"] == work, "Handoff changed before delivery")
    routine, token = os.environ["ROUTINE_ID"], os.environ["ROUTINE_TOKEN"]
    require(re.fullmatch(r"trig_[A-Za-z0-9]+", routine) and token, "Routine trigger is not configured")
    request = urllib.request.Request("https://api.anthropic.com/v1/claude_code/routines/" + routine + "/fire",
        method="POST", data=json.dumps({"text": json.dumps(work)}).encode(),
        headers={"Authorization": "Bearer " + token, "anthropic-version": "2023-06-01",
                 "Content-Type": "application/json"})
    # The endpoint is not idempotent: do not retry an uncertain response automatically.
    with urllib.request.urlopen(request, timeout=30) as response:
        result = json.load(response)
    require(result.get("type") == "routine_fire" and
            re.fullmatch(r"session_[A-Za-z0-9]+", result.get("claude_code_session_id", "")),
            "No session receipt; inspect routine history before retrying")
    Path("maintenance-handoff-ack").write_text("accepted\n")
    print("Claude accepted the maintenance handoff")


if __name__ == "__main__":
    if sys.argv[1] == "prepare":
        delivery = prepare(json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text()))
        if delivery:
            Path("maintenance-work.json").write_text(json.dumps(delivery["work"]))
            output(key="maintenance-handoff-v1-" + delivery["key"])
    elif sys.argv[1] == "dispatch":
        dispatch(json.loads(Path("maintenance-work.json").read_text()),
                 json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text()))
    else:
        raise ValueError("Unknown handoff command")
