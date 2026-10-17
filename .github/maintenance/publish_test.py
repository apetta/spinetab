import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("publish", Path(__file__).with_name("publish.py"))
publish = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publish)


class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.sha = "a" * 40
        self.bot = "spinetab-release[bot]"
        self.env = patch.dict(os.environ, {"GITHUB_REPOSITORY": publish.REPO,
            "GITHUB_REF": "refs/heads/main", "GITHUB_EVENT_NAME": "push",
            "GITHUB_SHA": self.sha, "GITHUB_RUN_ID": "42", "RELEASE_BOT_LOGIN": self.bot})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.pr = {"number": 12, "merged_at": "2026-10-17T00:00:00Z", "merge_commit_sha": self.sha,
            "user": {"login": self.bot}, "labels": [{"name": "release:ready"}],
            "base": {"ref": "main", "repo": {"full_name": publish.REPO}},
            "head": {"ref": "release-please--branches--main--components--spinetab", "sha": "b" * 40,
                "repo": {"full_name": publish.REPO}}}
        self.review = {"user": {"login": "apetta"}, "state": "APPROVED",
            "commit_id": "b" * 40, "body": "<!-- spinetab-release-supervisor -->\nVersion: 0.1.1"}
        self.independent = {"user": {"login": "github-actions[bot]"}, "state": "APPROVED",
            "commit_id": "b" * 40, "body": "<!-- spinetab-maintenance-review -->\nHead: " + "b" * 40}
        self.files = [{"filename": name, "status": "modified"} for name in (
            publish.MANIFEST, "packages/spinetab/CHANGELOG.md", ".release-please-manifest.json")]
        self.event = {"ref": "refs/heads/main", "after": self.sha,
            "repository": {"full_name": publish.REPO}}

    def decision(self, reviews=None):
        with patch.object(publish, "api", side_effect=[[self.pr],
                [self.review, self.independent] if reviews is None else reviews, self.files]):
            return publish.release_decision(self.sha, "0.1.1")

    def test_current_supervisor_approval(self):
        self.assertEqual(self.decision(), 12)

    def test_stale_or_revoked_approval_cannot_publish(self):
        for change in [{"commit_id": "c" * 40}, {"state": "DISMISSED"},
                       {"state": "CHANGES_REQUESTED"}, {"body": "Version: 0.1.1"},
                       {"body": "<!-- spinetab-release-supervisor -->\nVersion: 0.1.10"}]:
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, "supervisor"):
                self.decision([dict(self.review, **change)])

    def test_later_request_changes_revokes_approval(self):
        with self.assertRaisesRegex(ValueError, "supervisor"):
            self.decision([self.review, dict(self.review, state="CHANGES_REQUESTED")])

    def test_another_reviewer_cannot_make_release_decision(self):
        self.review["user"]["login"] = "github-actions[bot]"
        with self.assertRaisesRegex(ValueError, "supervisor"):
            self.decision()

    def test_untrusted_or_unmerged_release_is_rejected(self):
        original = copy.deepcopy(self.pr)
        for field, value in [("merged_at", None), ("merge_commit_sha", "c" * 40),
                             ("user", {"login": "someone"}),
                             ("head", dict(self.pr["head"], repo={"full_name": "someone/spinetab"})),
                             ("head", dict(self.pr["head"], ref="codex/release"))]:
            self.pr = dict(original, **{field: value})
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "merged Release Please"):
                self.decision()

    def test_independent_review_must_approve_current_head(self):
        for change in [{"commit_id": "c" * 40}, {"state": "DISMISSED"},
                       {"state": "COMMENTED"}, {"body": "Approved"}]:
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, "independent"):
                self.decision([self.review, dict(self.independent, **change)])
        with self.assertRaisesRegex(ValueError, "independent"):
            self.decision([self.review])

    def test_later_change_request_blocks_publication(self):
        with self.assertRaisesRegex(ValueError, "change request"):
            self.decision([self.review, self.independent, dict(self.independent, state="CHANGES_REQUESTED")])

    def test_release_file_scope_is_rechecked_at_publication(self):
        self.files.append({"filename": "packages/spinetab/src/index.ts", "status": "modified"})
        with self.assertRaisesRegex(ValueError, "file scope"):
            self.decision()

    def test_unready_release_is_rejected(self):
        self.pr["labels"] = []
        with self.assertRaisesRegex(ValueError, "marked ready"):
            self.decision()

    def test_unconfigured_bot_fails_closed(self):
        with patch.dict(os.environ, {"RELEASE_BOT_LOGIN": ""}), self.assertRaisesRegex(ValueError, "configured"):
            self.decision()

    def test_only_the_main_push_commit_can_trigger_publication(self):
        self.assertEqual(publish.trigger(self.event), self.sha)
        for field, value in [("ref", "refs/heads/codex/test"), ("after", "c" * 40),
                             ("repository", {"full_name": "someone/spinetab"})]:
            event = copy.deepcopy(self.event)
            event[field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                publish.trigger(event)

    def test_dispatch_rejects_a_changed_main_commit(self):
        with patch.dict(os.environ, {"GITHUB_EVENT_NAME": "workflow_dispatch"}):
            self.assertEqual(publish.trigger({"inputs": {"expected_sha": self.sha}}), self.sha)
            with self.assertRaisesRegex(ValueError, "advanced"):
                publish.trigger({"inputs": {"expected_sha": "c" * 40}})
        with patch.dict(os.environ, {"GITHUB_EVENT_NAME": "workflow_run"}), self.assertRaisesRegex(ValueError, "trigger"):
            publish.trigger({})

    def test_published_version_exits_before_release_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            event, output, manifest = [Path(directory) / name for name in ("event.json", "out", "package.json")]
            event.write_text(json.dumps(self.event))
            manifest.write_text(json.dumps({"name": "spinetab", "version": "0.1.0",
                "repository": {"url": "git+https://github.com/apetta/spinetab.git"}}))
            with patch.dict(os.environ, {"GITHUB_EVENT_PATH": str(event), "GITHUB_OUTPUT": str(output)}), \
                 patch.object(publish, "MANIFEST", str(manifest)), patch.object(publish, "current"), \
                 patch.object(publish.subprocess, "check_output", return_value=self.sha + "\n"), \
                 patch.object(publish, "registry", return_value={"name": "spinetab", "version": "0.1.0"}), \
                 patch.object(publish, "release_decision") as decision:
                publish.plan()
                decision.assert_not_called()
                self.assertEqual(output.read_text(), "publish=false\n")

    def test_wrong_checkout_fails_before_release_planning(self):
        with tempfile.TemporaryDirectory() as directory:
            event, output = [Path(directory) / name for name in ("event.json", "out")]
            event.write_text(json.dumps(self.event))
            with patch.dict(os.environ, {"GITHUB_EVENT_PATH": str(event), "GITHUB_OUTPUT": str(output)}), \
                 patch.object(publish.subprocess, "check_output", return_value="c" * 40), \
                 patch.object(publish, "registry") as registry, patch.object(publish, "api") as api:
                with self.assertRaisesRegex(ValueError, "Checkout"):
                    publish.plan()
                registry.assert_not_called()
                api.assert_not_called()
                self.assertEqual(output.read_text(), "publish=false\n")

    def test_another_version_commit_cannot_be_published_under_this_runs_provenance(self):
        with tempfile.TemporaryDirectory() as directory:
            event, output, manifest = [Path(directory) / name for name in ("event.json", "out", "package.json")]
            event.write_text(json.dumps(self.event))
            manifest.write_text(json.dumps({"name": "spinetab", "version": "0.1.1",
                "repository": {"url": "git+https://github.com/apetta/spinetab.git"}}))
            with patch.dict(os.environ, {"GITHUB_EVENT_PATH": str(event), "GITHUB_OUTPUT": str(output)}), \
                 patch.object(publish, "MANIFEST", str(manifest)), patch.object(publish, "current"), \
                 patch.object(publish, "unpublished", return_value=True), \
                 patch.object(publish.subprocess, "check_output", return_value="c" * 40), \
                 patch.object(publish, "release_decision") as decision:
                with self.assertRaisesRegex(ValueError, "version commit"):
                    publish.plan()
                decision.assert_not_called()
                self.assertEqual(output.read_text(), "publish=false\n")

    def test_registry_failure_is_not_treated_as_missing_version(self):
        with patch.object(publish, "registry", side_effect=OSError("unavailable")), self.assertRaises(OSError):
            publish.unpublished("0.1.1")

    def test_release_must_advance_latest(self):
        for version in ("0.1.0", "0.0.9"):
            with patch.object(publish, "registry", side_effect=[None, {"name": "spinetab", "version": "0.1.0"}]), \
                 self.subTest(version=version), self.assertRaisesRegex(ValueError, "advance"):
                publish.unpublished(version)

    def test_nonstable_and_leading_zero_versions_are_rejected(self):
        for version in ("0.1.1-rc.1", "01.2.3", "1.2", None):
            with self.subTest(version=version), self.assertRaises(ValueError):
                publish.stable(version)

    def test_source_must_be_on_main_and_match_checkout(self):
        with patch.object(publish, "api", side_effect=[{"object": {"sha": "c" * 40}},
                 {"merge_base_commit": {"sha": self.sha}}]), \
             patch.object(publish.subprocess, "check_output", return_value=self.sha + "\n"):
            publish.current(self.sha)
        with patch.dict(os.environ, {"GITHUB_REF": "refs/heads/test"}), self.assertRaisesRegex(ValueError, "main-only"):
            publish.current(self.sha)
        with patch.object(publish, "api", side_effect=[{"object": {"sha": "c" * 40}},
                 {"merge_base_commit": {"sha": "d" * 40}}]), \
             patch.object(publish.subprocess, "check_output", return_value=self.sha), \
             self.assertRaisesRegex(ValueError, "not on main"):
            publish.current(self.sha)
        with patch.object(publish, "api", side_effect=[{"object": {"sha": self.sha}},
                 {"merge_base_commit": {"sha": self.sha}}]), \
             patch.object(publish.subprocess, "check_output", return_value="c" * 40), \
             self.assertRaisesRegex(ValueError, "Checkout"):
            publish.current(self.sha)

    def test_provenance_must_name_the_actual_publication_commit(self):
        with patch.dict(os.environ, {"GITHUB_SHA": "c" * 40}), \
             patch.object(publish, "api") as api, self.assertRaisesRegex(ValueError, "provenance"):
            publish.current(self.sha)
        api.assert_not_called()

    def test_archive_identity_and_hash_are_checked_without_execution(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "spinetab-0.1.1.tgz"
            data = json.dumps({"name": "spinetab", "version": "0.1.1",
                "repository": {"url": "git+https://github.com/apetta/spinetab.git"}}).encode()
            with tarfile.open(path, "w:gz") as tar:
                member = tarfile.TarInfo("package/package.json")
                member.size = len(data)
                tar.addfile(member, io.BytesIO(data))
            receipt = {"sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
            publish.archive(path, receipt, "0.1.1")
            with self.assertRaisesRegex(ValueError, "changed"):
                publish.archive(path, {"sha256": "0" * 64}, "0.1.1")
            with self.assertRaisesRegex(ValueError, "filename"):
                publish.archive(path, receipt, "0.1.2")

    def test_publication_requires_this_runs_successful_verification_jobs(self):
        receipt = {"repository": publish.REPO, "sha": self.sha, "version": "0.1.1",
                   "run_id": "42", "run_attempt": "1", "sha256": "d" * 64}
        run = {"repository": {"full_name": publish.REPO}, "head_branch": "main",
               "path": ".github/workflows/publish.yml", "event": "push", "head_sha": self.sha}
        names = ["verify / Lint, Typecheck, Test, E2E", "verify / Maintenance guards",
                 "verify / Packed consumer release verification"]
        jobs = {"total_count": 3, "jobs": [{"name": name, "conclusion": "success"} for name in names]}
        with patch.dict(os.environ, {"RELEASE_SHA": self.sha, "RELEASE_VERSION": "0.1.1"}), \
             patch.object(publish, "current"), patch.object(publish, "release_decision"), \
             patch.object(publish, "unpublished", return_value=True), \
             patch.object(publish, "archive") as archive, \
             patch.object(publish.Path, "glob", return_value=[Path("release/spinetab-0.1.1.tgz")]):
            for failure in (None, "other-run", "wrong-source", "wrong-workflow", "wrong-run-commit", "failed-job", "missing-job"):
                candidate, candidate_run, candidate_jobs = copy.deepcopy((receipt, run, jobs))
                if failure == "other-run":
                    candidate["run_id"] = "43"
                elif failure == "wrong-source":
                    candidate["sha"] = "c" * 40
                elif failure == "wrong-workflow":
                    candidate_run["path"] = ".github/workflows/ci.yml"
                elif failure == "wrong-run-commit":
                    candidate_run["head_sha"] = "c" * 40
                elif failure == "failed-job":
                    candidate_jobs["jobs"][-1]["conclusion"] = "failure"
                elif failure == "missing-job":
                    candidate_jobs["jobs"].pop()
                with self.subTest(failure=failure), \
                     patch.object(publish.Path, "read_text", side_effect=[json.dumps({"version": "0.1.1"}), json.dumps(candidate)]), \
                     patch.object(publish, "api", side_effect=[candidate_run, candidate_jobs]):
                    if failure is None:
                        publish.verify()
                        archive.assert_called_once()
                    else:
                        with self.assertRaises(ValueError):
                            publish.verify()


if __name__ == "__main__":
    unittest.main()
