"""Review public PR data without executing candidate code or exposing write tokens."""

import base64
import difflib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import urllib.error
import urllib.request

REPO = "apetta/spinetab"
CI_PATH = ".github/workflows/ci.yml"
CHECK = "Lint, Typecheck, Test, E2E"
REVIEWER = "github-actions[bot]"
MARKER = "<!-- spinetab-maintenance-review -->"
PROTECTED = (".github/", ".claude/", ".agents/", ".codex/", ".husky/")
PROTECTED_FILES = {"AGENTS.md", "CLAUDE.md", ".npmrc", ".gitmodules", ".mcp.json", ".npm-extension.mjs", ".npm-extension.cjs", "turbo.json", "turbo.jsonc", "biome.json", "biome.jsonc", ".prettierignore"}
HARNESS_CONFIG = re.compile(r"^(?:vitest(?:\.[\w-]+)*\.(?:config|workspace)|playwright(?:\.[\w-]+)*\.config|lint-staged\.config)\.[cm]?[jt]s$|^\.prettierrc(?:\..+)?$")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def api(path, method="GET", data=None):
    require(os.environ["GITHUB_REPOSITORY"] == REPO, "Unexpected repository")
    require(path.startswith("/") and not path.startswith("//"), "Invalid API path")
    request = urllib.request.Request(
        "https://api.github.com/repos/" + REPO + path,
        method=method,
        data=json.dumps(data).encode() if data is not None else None,
        headers={
            "Authorization": "Bearer " + os.environ["GH_TOKEN"],
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        content = response.read()
        return json.loads(content) if content else None


def pages(path):
    result = []
    for page in range(1, 6):
        separator = "&" if "?" in path else "?"
        items = api(f"{path}{separator}per_page=100&page={page}")
        require(isinstance(items, list), "Expected a list")
        result.extend(items)
        if len(items) < 100:
            return result
    raise ValueError("Too much evidence for an unattended review")


def output(**values):
    with open(os.environ["GITHUB_OUTPUT"], "a") as stream:
        for key, value in values.items():
            text = str(value)
            require("\n" not in text, "Invalid output")
            stream.write(f"{key}={text}\n")


def eligible(pr, files):
    require(pr["state"] == "open" and not pr["draft"], "PR is not ready")
    require(pr["base"]["ref"] == "main", "Unexpected base branch")
    for side in ("base", "head"):
        require(pr[side]["repo"] and pr[side]["repo"]["full_name"] == REPO, "Forks require human review")
    author = pr["user"]["login"]
    require(author in {"apetta", "dependabot[bot]"}, "Author is outside the automation scope")
    if author == "apetta":
        require(pr["head"]["ref"].startswith(("claude/", "codex/")), "Unexpected agent branch")
        require("agent:ready" in {label["name"] for label in pr["labels"]}, "Missing agent:ready label")
    require(0 < len(files) == pr["changed_files"] <= 40, "Incomplete or oversized change")
    for item in files:
        for path in (item["filename"], item.get("previous_filename", item["filename"])):
            parts = path.split("/")
            require(not any(part + "/" in PROTECTED for part in parts[:-1]) and parts[-1] not in PROTECTED_FILES, "Automation policy or credentials configuration needs human review")
            require(not HARNESS_CONFIG.fullmatch(parts[-1]), "Test or lint configuration needs human review")
            require(not any(part.startswith(".env") for part in path.split("/")), "Environment files need human review")
        require(item["status"] in {"added", "modified", "removed", "renamed"}, "Unsupported file change")


def current(number, expected_head=None, expected_base=None):
    require(re.fullmatch(r"[1-9][0-9]*", str(number)), "Invalid PR number")
    pr = api(f"/pulls/{number}")
    files = pages(f"/pulls/{number}/files")
    eligible(pr, files)
    main = api("/git/ref/heads/main")["object"]["sha"]
    head = pr["head"]["sha"]
    require(expected_head is None or head == expected_head, "PR head changed")
    require(expected_base is None or main == expected_base, "Base changed; fresh CI and review required")
    comparison = api(f"/compare/{main}...{head}")
    require(comparison["merge_base_commit"]["sha"] == main, "Branch must include the current main commit")
    require(comparison["status"] == "ahead", "No current change to merge")
    manifest_policy(files, main, head)
    return pr, files, main


def manifest_policy(files, base, head):
    for item in files:
        if Path(item["filename"]).name != "package.json":
            continue
        before = json.loads(content(item.get("previous_filename", item["filename"]), base)) if item["status"] != "added" else {}
        after = json.loads(content(item["filename"], head)) if item["status"] != "removed" else {}
        for key in ("scripts", "packageManager", "pnpm", "workspaces"):
            require(before.get(key) == after.get(key), "Package scripts or toolchain policy needs human review")


def ci(pr, run_id=None, files=()):
    runs = api(f"/actions/workflows/ci.yml/runs?head_sha={pr['head']['sha']}&event=pull_request&per_page=100")["workflow_runs"]
    require(bool(runs), "No CI for the candidate commit")
    run = max(runs, key=lambda item: item["id"])
    require(run_id is None or str(run["id"]) == str(run_id), "CI evidence was superseded")
    require(run["repository"]["full_name"] == REPO and run["path"] == CI_PATH, "Unexpected CI workflow")
    require(run["event"] == "pull_request" and run["head_sha"] == pr["head"]["sha"], "CI covers another commit")
    require(run["head_branch"] == pr["head"]["ref"], "CI covers another branch")
    require(run["status"] == "completed" and run["conclusion"] == "success", "Latest CI is not successful")
    jobs = api(f"/actions/runs/{run['id']}/jobs?per_page=100")["jobs"]
    require(any(job["name"] == CHECK and job["conclusion"] == "success" for job in jobs), "Required test job did not pass")
    require(any(job["name"] == "Maintenance guards" and job["conclusion"] == "success" for job in jobs), "Maintenance guard tests did not pass")
    if any(item["filename"].startswith("packages/") or item["filename"] in {"package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"} for item in files):
        require(any(job["name"] == "Packed consumer release verification" and job["conclusion"] == "success" for job in jobs), "Packed consumer verification did not pass")
    checks = api(f"/commits/{pr['head']['sha']}/check-runs?per_page=100")
    require(checks["total_count"] == len(checks["check_runs"]), "Incomplete check evidence")
    for check in checks["check_runs"]:
        require(check["status"] == "completed" and check["conclusion"] in {"success", "neutral", "skipped"}, "Another check is pending or failed")
    statuses = api(f"/commits/{pr['head']['sha']}/status?per_page=100")
    require(statuses["total_count"] == len(statuses["statuses"]), "Incomplete status evidence")
    require(not statuses["statuses"] or statuses["state"] == "success", "Another status is pending or failed")
    return run


def content(path, ref, limit=250_000):
    from urllib.parse import quote

    value = api(f"/contents/{quote(path, safe='/')}?ref={ref}")
    require(value["type"] == "file" and value["size"] <= limit, "Large or non-text file needs human review")
    require(value.get("encoding") == "base64", "Source content is unavailable")
    return base64.b64decode(value["content"]).decode("utf-8")


def prepare():
    output(ready="false")
    require(not os.environ.get("ANTHROPIC_API_KEY"), "API billing is disabled")
    require(os.environ.get("RUNNER_DEBUG") != "1", "Disable debug logging before subscription review")
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    run_event = event.get("workflow_run")
    if run_event:
        require(run_event["name"] in {"CI", "CodeQL"} and run_event["conclusion"] == "success", "Not successful candidate CI")
        if run_event["name"] == "CI":
            require(run_event["path"] == CI_PATH, "Unexpected CI workflow")
        require(run_event["event"] == "pull_request", "Not a PR CI event")
    number = event.get("inputs", {}).get("pr_number")
    if event.get("pull_request"):
        require(event.get("action") == "labeled" and event.get("label", {}).get("name") == "agent:ready" and event["sender"]["login"] == "apetta", "Unexpected readiness event")
        number = event["pull_request"]["number"]
    require(not number or re.fullmatch(r"[1-9][0-9]*", str(number)), "Invalid PR number")
    candidates = [api(f"/pulls/{number}")] if number else pages("/pulls?state=open&sort=created&direction=asc")
    for candidate in candidates:
        try:
            if run_event and candidate["head"]["sha"] != run_event["head_sha"]:
                continue
            pr, files, main = current(candidate["number"])
            run = ci(pr, run_event["id"] if run_event and run_event["name"] == "CI" else None, files)
            previous = pages(f"/pulls/{pr['number']}/reviews")
            signature = f"Head: {pr['head']['sha']}\nBase: {main}\nCI: {run['id']}:{run['run_attempt']}"
            if any(review["user"]["login"] == REVIEWER and MARKER in review["body"] and signature in review["body"] for review in previous):
                continue
            evidence = {"repository": REPO, "pr": pr["number"], "head": pr["head"]["sha"], "base": main,
                        "title": pr["title"], "description": (pr["body"] or "")[:12000].splitlines(keepends=True),
                        "ci": {"id": run["id"], "attempt": run["run_attempt"], "url": run["html_url"], "conclusion": "success"}, "files": []}
            for item in files:
                path = item["filename"]
                record = {"path": path, "status": item["status"]}
                if path == "pnpm-lock.yaml":
                    before = content(path, main, 1_000_000) if item["status"] != "added" else ""
                    after = content(path, pr["head"]["sha"], 1_000_000) if item["status"] != "removed" else ""
                    patch = "".join(difflib.unified_diff(before.splitlines(True), after.splitlines(True), fromfile="before/pnpm-lock.yaml", tofile="after/pnpm-lock.yaml"))
                    require(len(patch) < 100000, "Lockfile diff needs a smaller review")
                    record["patch"] = patch.splitlines(keepends=True)
                else:
                    record["before"] = content(item.get("previous_filename", path), main).splitlines(keepends=True) if item["status"] != "added" else None
                    record["after"] = content(path, pr["head"]["sha"]).splitlines(keepends=True) if item["status"] != "removed" else None
                evidence["files"].append(record)
            encoded = json.dumps(evidence, indent=2)
            require(len(encoded) <= 600000, "Review is too large; split the change")
            require(all(len(line) <= 8000 for line in encoded.splitlines()), "Long evidence lines need human review")
            current(pr["number"], pr["head"]["sha"], main)
            Path("review-input.json").write_text(encoded)
            output(ready="true", pr=pr["number"], head=pr["head"]["sha"], base=main,
                   ci_run=run["id"], ci_attempt=run["run_attempt"])
            print(f"Prepared public, inert evidence for PR #{pr['number']} at {pr['head']['sha']}")
            return
        except (ValueError, UnicodeDecodeError) as error:
            print(f"PR #{candidate['number']}: {error}")
    print("No eligible unreviewed candidate; nothing to change")


def complete_reads(trace, path):
    path = Path(path).resolve()
    total = len(path.read_text().splitlines())
    covered = set()
    for message in trace:
        result = message.get("tool_use_result")
        file = result.get("file") if isinstance(result, dict) else None
        if not isinstance(file, dict):
            continue
        require(Path(file["filePath"]).resolve() == path, "Unexpected read result")
        start, count = file["startLine"], file["numLines"]
        require(file["totalLines"] == total and isinstance(start, int) and isinstance(count, int), "Read metadata mismatch")
        require(1 <= start <= total + 1 and 0 <= count <= total - start + 1, "Invalid read range")
        # A token cap can cut the last line. The next read must include it again.
        end = start + count - int(bool(file.get("truncatedByTokenCap")))
        covered.update(range(start, max(start, end)))
    require(len(covered) == total and total > 0, "Reviewer did not read all evidence")


def verify():
    decision = json.loads(os.environ["VERDICT"])
    require(set(decision) == {"decision", "reason"}, "Invalid review response")
    require(decision["decision"] in {"approve", "request_changes", "escalate"}, "Invalid decision")
    require(isinstance(decision["reason"], str) and 0 < len(decision["reason"]) <= 3000, "Invalid review explanation")
    trace = json.loads(Path(os.environ["EXECUTION_FILE"]).read_text())
    initial = next(message for message in trace if message.get("type") == "system" and message.get("subtype") == "init")
    require(initial["model"].startswith("claude-opus-5-5"), "Unexpected model")
    reads = 0
    for message in trace:
        blocks = message.get("message", {}).get("content", [])
        for block in blocks if isinstance(blocks, list) else []:
            if isinstance(block, dict) and block.get("type") == "tool_use":
                require(block["name"] in {"Read", "StructuredOutput"}, "Unexpected reviewer tool")
                if block["name"] == "Read":
                    require(Path(block["input"]["file_path"]).resolve() == Path("review-input.json").resolve(), "Unexpected reviewer file")
                    reads += 1
    require(reads > 0, "Reviewer did not read its evidence")
    if decision["decision"] == "approve":
        complete_reads(trace, "review-input.json")
    auth = json.loads(subprocess.check_output(["claude", "auth", "status"], text=True))
    require(auth["authMethod"] == "oauth_token", "Subscription authentication required")
    output(decision=decision["decision"], reason=json.dumps(decision["reason"]))
    print("Verified Opus 5.5, subscription authentication and an evidence-only tool trace")


def latest_reviews(reviews):
    latest = {}
    for review in sorted(reviews, key=lambda value: value["id"]):
        if review["state"] in {"APPROVED", "CHANGES_REQUESTED", "DISMISSED"}:
            latest[review["user"]["login"]] = review
    return latest


def evidence():
    require(not os.environ.get("CLAUDE_CODE_OAUTH_TOKEN") and not os.environ.get("ANTHROPIC_API_KEY"), "Write job must not hold model credentials")
    pr, files, main = current(os.environ["PR_NUMBER"], os.environ["EXPECTED_HEAD"], os.environ["EXPECTED_BASE"])
    run = ci(pr, os.environ["CI_RUN"], files)
    require(str(run["run_attempt"]) == os.environ["CI_ATTEMPT"], "CI was rerun after analysis")
    return pr, main, run


def review():
    pr, main, run = evidence()
    decision = os.environ["DECISION"]
    require(decision in {"approve", "request_changes", "escalate"}, "Invalid decision")
    reason = json.loads(os.environ["REASON"])
    require(isinstance(reason, str) and 0 < len(reason) <= 3000, "Invalid reason")
    require(pr["user"]["login"] != REVIEWER, "Reviewer cannot approve its own PR")
    body = f"{MARKER}\nClaude Opus 5.5 High: {decision}\n\n{reason}\n\nHead: {pr['head']['sha']}\nBase: {main}\nCI: {run['id']}:{run['run_attempt']}\nReview run: {os.environ['GITHUB_RUN_ID']}"
    result = api(f"/pulls/{pr['number']}/reviews", "POST", {"commit_id": pr["head"]["sha"], "body": body,
                 "event": {"approve": "APPROVE", "request_changes": "REQUEST_CHANGES", "escalate": "COMMENT"}[decision]})
    require(result["user"]["login"] == REVIEWER and result["commit_id"] == pr["head"]["sha"], "Unexpected review identity or head")
    output(review_id=result["id"])


def approved(pr, reviews, review_id, base, run):
    latest = latest_reviews(reviews)
    require(not any(item["state"] == "CHANGES_REQUESTED" for item in latest.values()), "Outstanding change request")
    approval = latest.get(REVIEWER)
    require(approval is not None and str(approval["id"]) == str(review_id), "Approval was superseded")
    require(approval["user"]["login"] != pr["user"]["login"], "Self-approval rejected")
    require(approval["state"] == "APPROVED" and approval["commit_id"] == pr["head"]["sha"], "Approval does not cover the current head")
    signature = f"Head: {pr['head']['sha']}\nBase: {base}\nCI: {run['id']}:{run['run_attempt']}\nReview run: {os.environ['GITHUB_RUN_ID']}"
    require(MARKER in approval["body"] and signature in approval["body"], "Unrelated approval")
    return approval


def merge():
    require(os.environ["DECISION"] == "approve", "Not approved")
    for _ in range(2):
        pr, main, run = evidence()
        approved(pr, pages(f"/pulls/{pr['number']}/reviews"), os.environ["REVIEW_ID"], main, run)
    result = api(f"/pulls/{pr['number']}/merge", "PUT", {"sha": pr["head"]["sha"], "merge_method": "squash"})
    require(result["merged"] is True, "Merge refused")
    merged = api(f"/pulls/{pr['number']}")
    require(merged["merged"] and merged["merge_commit_sha"] == result["sha"], "Merge result mismatch")
    # GITHUB_TOKEN merges do not fire push workflows; dispatch the existing CI explicitly.
    api("/actions/workflows/ci.yml/dispatches", "POST", {
        "ref": "main", "inputs": {"deploy": True, "expected_sha": result["sha"]}})
    print(f"Merged PR #{pr['number']} as {result['sha']}; explicitly dispatched downstream CI")


if __name__ == "__main__":
    {"prepare": prepare, "verify": verify, "review": review, "merge": merge}[sys.argv[1]]()
