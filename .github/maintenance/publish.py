"""Gate publication of the exact archive that passed release verification."""

import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import urllib.error
import urllib.request

REPO = "apetta/spinetab"
PACKAGE = "spinetab"
MANIFEST = "packages/spinetab/package.json"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def api(path):
    require(os.environ["GITHUB_REPOSITORY"] == REPO, "Unexpected repository")
    request = urllib.request.Request(
        f"https://api.github.com/repos/{REPO}/{path}",
        headers={"Authorization": "Bearer " + os.environ["GH_TOKEN"],
                 "Accept": "application/vnd.github+json"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def registry(version):
    require(version == "latest" or re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version), "Invalid registry version")
    try:
        with urllib.request.urlopen(f"https://registry.npmjs.org/{PACKAGE}/{version}", timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        if error.code == 404 and version != "latest":
            return None
        raise


def stable(version):
    require(isinstance(version, str) and re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", version), "Release requires a stable semantic version")
    return tuple(int(part) for part in version.split("."))


def current(sha):
    require(re.fullmatch(r"[0-9a-f]{40}", sha or ""), "Invalid release commit")
    require(os.environ["GITHUB_REF"] == "refs/heads/main", "Publication is main-only")
    require(os.environ["GITHUB_SHA"] == sha, "Publication commit differs from provenance")
    require(subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip() == sha, "Checkout does not match the release commit")
    main = api("git/ref/heads/main")["object"]["sha"]
    require(api(f"compare/{sha}...{main}")["merge_base_commit"]["sha"] == sha, "Release commit is not on main")


def trigger(event):
    sha = os.environ["GITHUB_SHA"]
    if os.environ["GITHUB_EVENT_NAME"] == "push":
        require(event["ref"] == "refs/heads/main" and event["repository"]["full_name"] == REPO
                and event["after"] == sha, "Unexpected publication repository, branch or commit")
    else:
        require(os.environ["GITHUB_EVENT_NAME"] == "workflow_dispatch", "Unexpected publication trigger")
        requested = event.get("inputs", {}).get("expected_sha", "")
        require(not requested or requested == sha, "Main advanced before publication dispatch")
    return sha


def output(**values):
    with open(os.environ["GITHUB_OUTPUT"], "a") as stream:
        for key, value in values.items():
            require("\n" not in str(value), "Invalid output")
            stream.write(f"{key}={value}\n")


def unpublished(version):
    stable(version)
    if registry(version) is not None:
        return False
    latest = registry("latest")
    require(latest["name"] == PACKAGE and stable(version) > stable(latest["version"]), "Release must advance the published version")
    return True


def release_decision(sha, version):
    bot = os.environ.get("RELEASE_BOT_LOGIN", "")
    require(re.fullmatch(r"[a-z0-9-]+\[bot\]", bot), "Release bot is not configured")
    candidates = api(f"commits/{sha}/pulls?per_page=100")
    require(len(candidates) < 100, "Release evidence needs pagination")
    candidates = [pr for pr in candidates if pr.get("merged_at") and pr["merge_commit_sha"] == sha
                  and pr["user"]["login"] == bot and pr["base"]["ref"] == "main"
                  and pr["base"]["repo"]["full_name"] == REPO and pr["head"]["repo"]
                  and pr["head"]["repo"]["full_name"] == REPO
                  and pr["head"]["ref"] == "release-please--branches--main--components--spinetab"]
    require(len(candidates) == 1, "Release needs a merged Release Please PR")
    pr = candidates[0]
    require("release:ready" in {label["name"] for label in pr["labels"]}, "Release was not marked ready by the supervisor")
    reviews = api(f"pulls/{pr['number']}/reviews?per_page=100")
    require(len(reviews) < 100, "Release reviews need pagination")
    supervisor = [review for review in reviews if review["user"]["login"] == "apetta"
                  and review["state"] in {"APPROVED", "CHANGES_REQUESTED", "DISMISSED"}]
    require(supervisor and supervisor[-1]["state"] == "APPROVED"
            and supervisor[-1]["commit_id"] == pr["head"]["sha"]
            and "<!-- spinetab-release-supervisor -->" in (supervisor[-1]["body"] or "")
            and f"Version: {version}" in supervisor[-1]["body"].splitlines(), "Missing current-head supervisor release approval")
    latest = {}
    for review in reviews:
        if review["state"] in {"APPROVED", "CHANGES_REQUESTED", "DISMISSED"}:
            latest[review["user"]["login"]] = review
    require(not any(review["state"] == "CHANGES_REQUESTED" for review in latest.values()), "Outstanding release change request")
    independent = latest.get("github-actions[bot]")
    require(independent and independent["state"] == "APPROVED"
            and independent["commit_id"] == pr["head"]["sha"]
            and "<!-- spinetab-maintenance-review -->" in (independent["body"] or "")
            and f"Head: {pr['head']['sha']}" in independent["body"].splitlines(), "Missing current-head independent release approval")
    files = api(f"pulls/{pr['number']}/files?per_page=100")
    require(len(files) == 3 and {item["filename"] for item in files}
            == {MANIFEST, "packages/spinetab/CHANGELOG.md", ".release-please-manifest.json"}
            and all(item["status"] == "modified" for item in files), "Release file scope changed")
    return pr["number"]


def plan():
    output(publish="false")
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    sha = trigger(event)
    current(sha)
    package = json.loads(Path(MANIFEST).read_text())
    require(package["name"] == PACKAGE and not package.get("private"), "Unexpected package")
    require(package["repository"]["url"] == f"git+https://github.com/{REPO}.git", "Package provenance repository differs")
    version = package["version"]
    if not unpublished(version):
        print("The current version is already published; no release work")
        return
    release_sha = subprocess.check_output(
        ["git", "log", "-1", "--format=%H", "-G", r'^[[:space:]]*"version"[[:space:]]*:', "--", MANIFEST], text=True,
    ).strip()
    require(re.fullmatch(r"[0-9a-f]{40}", release_sha or ""), "Version commit is unavailable")
    require(release_sha == sha, "Publication must run on the reviewed version commit")
    released_manifest = json.loads(subprocess.check_output(["git", "show", f"{release_sha}:{MANIFEST}"], text=True))
    require(released_manifest["version"] == version, "Version commit differs from the manifest")
    pr = release_decision(release_sha, version)
    output(publish="true", version=version, sha=release_sha, pr=pr)
    print(f"Release candidate: {PACKAGE}@{version} at {release_sha}, PR #{pr}")


def archive(path, receipt, version):
    require(path.name == f"{PACKAGE}-{version}.tgz", "Unexpected archive filename")
    require(hashlib.sha256(path.read_bytes()).hexdigest() == receipt["sha256"], "Verified archive changed")
    with tarfile.open(path, "r:gz") as tar:
        member = tar.getmember("package/package.json")
        require(member.isfile() and member.size < 250_000, "Invalid packed manifest")
        package = json.load(tar.extractfile(member))
    require(package["name"] == PACKAGE and package["version"] == version and not package.get("private"), "Archive package or version differs")
    require(package["repository"]["url"] == f"git+https://github.com/{REPO}.git", "Archive provenance repository differs")


def verify():
    sha, version = os.environ["RELEASE_SHA"], os.environ["RELEASE_VERSION"]
    current(sha)
    stable(version)
    release_decision(sha, version)
    require(json.loads(Path(MANIFEST).read_text())["version"] == version, "Source version differs")
    run_id = os.environ["GITHUB_RUN_ID"]
    require(re.fullmatch(r"[1-9][0-9]*", run_id), "Invalid verification run")
    receipt = json.loads(Path("release/verification.json").read_text())
    require(receipt["repository"] == REPO and receipt["sha"] == sha and receipt["version"] == version, "Archive receipt covers another candidate")
    require(str(receipt["run_id"]) == run_id and re.fullmatch(r"[1-9][0-9]*", str(receipt["run_attempt"])), "Archive receipt covers another run")
    run = api(f"actions/runs/{run_id}/attempts/{receipt['run_attempt']}")
    require(run["repository"]["full_name"] == REPO and run["head_branch"] == "main", "Verification ran outside main")
    require(run["path"] == ".github/workflows/publish.yml" and run["event"] in {"push", "workflow_dispatch"}
            and run["head_sha"] == sha, "Unexpected verification workflow or commit")
    jobs = api(f"actions/runs/{run_id}/attempts/{receipt['run_attempt']}/jobs?per_page=100")
    require(jobs["total_count"] == len(jobs["jobs"]), "Incomplete verification evidence")
    for name in ("verify / Lint, Typecheck, Test, E2E", "verify / Maintenance guards", "verify / Packed consumer release verification"):
        require(any(job["name"] == name and job["conclusion"] == "success" for job in jobs["jobs"]), f"Missing successful {name}")
    packed = next(job for job in jobs["jobs"] if job["name"] == "verify / Packed consumer release verification")
    require(any(step["name"] == "Verify packed development and production apps" and step["conclusion"] == "success"
                for step in packed.get("steps", [])), "Packed browser verification did not pass")
    paths = list(Path("release").glob("*.tgz"))
    require(len(paths) == 1, "Expected one verified archive")
    archive(paths[0], receipt, version)
    require(unpublished(version), "Version was already published; nothing to overwrite")
    current(sha)
    print(f"Verified exact archive for {PACKAGE}@{version} at {sha}")


if __name__ == "__main__":
    try:
        {"plan": plan, "verify": verify}[sys.argv[1]]()
    except (ValueError, KeyError, OSError, tarfile.TarError) as error:
        raise SystemExit(str(error)) from None
