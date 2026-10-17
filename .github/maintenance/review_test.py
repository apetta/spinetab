import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("review", Path(__file__).with_name("review.py"))
review = importlib.util.module_from_spec(spec)
spec.loader.exec_module(review)


class GuardTests(unittest.TestCase):
    def setUp(self):
        environment = patch.dict(os.environ, {"GITHUB_EVENT_NAME": "workflow_run", "SUPERVISOR_COMMENT_ID": ""})
        environment.start()
        self.addCleanup(environment.stop)
        self.pr = {"number": 12, "state": "open", "draft": False, "changed_files": 1,
                   "user": {"login": "apetta"}, "labels": [{"name": "agent:ready"}],
                   "base": {"ref": "main", "repo": {"full_name": review.REPO}},
                   "head": {"ref": "claude/fix-recovery", "sha": "a" * 40,
                            "repo": {"full_name": review.REPO}}}
        self.files = [{"filename": "packages/spinetab/src/runtime.ts", "status": "modified"}]
        self.run = {"id": 42, "run_attempt": 1, "repository": {"full_name": review.REPO},
                    "path": review.CI_PATH, "event": "pull_request", "head_sha": "a" * 40,
                    "head_branch": self.pr["head"]["ref"], "status": "completed", "conclusion": "success"}
        self.approval = {"id": 9, "user": {"login": review.REVIEWER}, "state": "APPROVED",
                         "commit_id": "a" * 40, "body": review.MARKER + "\nHead: " + "a" * 40
                         + "\nBase: " + "b" * 40 + "\nCI: 42:1\nReview run: 99"}

    def check(self):
        review.eligible(self.pr, self.files)

    def test_agent_change_is_eligible(self):
        self.check()

    def test_dependabot_does_not_need_agent_label(self):
        self.pr["user"]["login"] = "dependabot[bot]"
        self.pr["labels"] = []
        self.pr["head"]["ref"] = "dependabot/npm_and_yarn/next-17"
        self.check()

    def release_candidate(self):
        self.pr["user"]["login"] = "spinetab-release[bot]"
        self.pr["head"]["ref"] = "release-please--branches--main--components--spinetab"
        self.pr["labels"] = [{"name": "release:ready"}]
        self.files = [{"filename": path, "status": "modified"} for path in sorted(review.RELEASE_FILES)]
        self.pr["changed_files"] = len(self.files)

    def test_release_bot_needs_explicit_configuration_and_readiness(self):
        self.release_candidate()
        with patch.dict(os.environ, {"RELEASE_BOT_LOGIN": "spinetab-release[bot]"}):
            self.check()
            self.pr["labels"] = []
            with self.assertRaisesRegex(ValueError, "supervisor"):
                self.check()
        with patch.dict(os.environ, {"RELEASE_BOT_LOGIN": ""}), self.assertRaisesRegex(ValueError, "Author"):
            self.check()

    def test_release_cannot_smuggle_source_or_policy_changes(self):
        self.release_candidate()
        with patch.dict(os.environ, {"RELEASE_BOT_LOGIN": "spinetab-release[bot]"}):
            for path in ("packages/spinetab/src/index.ts", ".github/workflows/ci.yml", "README.md"):
                self.files.append({"filename": path, "status": "modified"})
                self.pr["changed_files"] = len(self.files)
                with self.subTest(path=path), self.assertRaisesRegex(ValueError, "only version"):
                    self.check()
                self.files.pop()

    def test_release_manifest_must_be_version_only_and_consistent(self):
        files = [{"filename": "packages/spinetab/package.json", "status": "modified"}]
        before = {"name": "spinetab", "version": "0.1.0", "scripts": {"test": "vitest"}}
        after = dict(before, version="0.1.1")
        def contents(candidate):
            return [json.dumps(before), json.dumps(candidate), '{"packages/spinetab":"0.1.0"}',
                    '{"packages/spinetab":"0.1.1"}']
        with patch.object(review, "content", side_effect=contents(after)):
            review.manifest_policy(files, "base", "head", release=True)
        for change in [{"version": "0.0.9"}, {"version": "0.1.1-rc.1"}, {"dependencies": {"x": "1"}}]:
            with self.subTest(change=change), patch.object(review, "content", side_effect=contents(dict(after, **change))), \
                 self.assertRaises(ValueError):
                review.manifest_policy(files, "base", "head", release=True)
        values = contents(after)
        values[-1] = '{"packages/spinetab":"0.2.0"}'
        with patch.object(review, "content", side_effect=values), self.assertRaisesRegex(ValueError, "disagree"):
            review.manifest_policy(files, "base", "head", release=True)

    def test_release_approval_is_for_current_head_and_exact_version(self):
        approval = {"user": {"login": "apetta"}, "state": "APPROVED", "commit_id": self.pr["head"]["sha"],
                    "body": "<!-- spinetab-release-supervisor -->\nVersion: 0.1.1"}
        with patch.object(review, "pages", return_value=[approval]):
            review.release_approval(self.pr, "0.1.1")
            with self.assertRaisesRegex(ValueError, "another version"):
                review.release_approval(self.pr, "0.1.10")
        for change in [{"commit_id": "c" * 40}, {"state": "DISMISSED"}, {"state": "CHANGES_REQUESTED"}]:
            with self.subTest(change=change), patch.object(review, "pages", return_value=[dict(approval, **change)]), \
                 self.assertRaisesRegex(ValueError, "current-head"):
                review.release_approval(self.pr, "0.1.1")

    def test_fork_cannot_reach_subscription_review(self):
        self.pr["head"]["repo"]["full_name"] = "someone/spinetab"
        with self.assertRaisesRegex(ValueError, "Forks"):
            self.check()

    def test_untrusted_author_is_rejected(self):
        self.pr["user"]["login"] = "someone"
        with self.assertRaisesRegex(ValueError, "Author"):
            self.check()

    def test_owner_must_explicitly_mark_agent_work_ready(self):
        self.pr["labels"] = []
        with self.assertRaisesRegex(ValueError, "label"):
            self.check()

    def test_protected_files_including_renames_are_rejected(self):
        for path in [".github/workflows/ci.yml", ".claude/settings.json", "AGENTS.md", ".npmrc",
                     "packages/spinetab/AGENTS.md", "apps/website/.mcp.json",
                     "apps/website/.claude/settings.json", ".npm-extension.mjs", "apps/website/.env.local",
                     "turbo.json", ".pnpmfile.cjs", "pnpm-workspace.yaml", "packages/spinetab/vitest.config.ts",
                     "apps/website/playwright.config.ts", "packages/spinetab/playwright.consumers.config.ts"]:
            with self.subTest(path=path):
                self.files[0] = {"filename": "README.md", "previous_filename": path, "status": "renamed"}
                with self.assertRaises(ValueError):
                    self.check()

    def test_incomplete_file_listing_is_rejected(self):
        self.pr["changed_files"] = 2
        with self.assertRaisesRegex(ValueError, "Incomplete"):
            self.check()

    def test_changed_head_is_rejected_before_ci_or_merge(self):
        def fake(path, *args):
            if path == "/pulls/12":
                return self.pr
            if "/files" in path:
                return self.files
            if path == "/git/ref/heads/main":
                return {"object": {"sha": "b" * 40}}
            self.fail("Unexpected API operation: " + path)

        with patch.object(review, "api", side_effect=fake):
            with self.assertRaisesRegex(ValueError, "head changed"):
                review.current(12, "c" * 40)

    def test_changed_base_is_rejected(self):
        values = [self.pr, self.files, {"object": {"sha": "b" * 40}}]
        with patch.object(review, "api", side_effect=values):
            with self.assertRaisesRegex(ValueError, "Base changed"):
                review.current(12, "a" * 40, "c" * 40)

    def test_successful_ci_on_current_commit(self):
        with patch.object(review, "api", side_effect=[{"workflow_runs": [self.run]},
                         {"jobs": [{"name": review.CHECK, "conclusion": "success"},
                                   {"name": "Maintenance guards", "conclusion": "success"}]},
                         {"total_count": 0, "check_runs": []},
                         {"total_count": 0, "statuses": [], "state": "pending"}]):
            self.assertEqual(review.ci(self.pr)["id"], 42)

    def test_dependency_bump_preserves_package_policy(self):
        files = [{"filename": "package.json", "status": "modified"}]
        with patch.object(review, "content", side_effect=['{"scripts":{"test":"vitest"},"dependencies":{"x":"1"}}',
                                                        '{"scripts":{"test":"vitest"},"dependencies":{"x":"2"}}']):
            review.manifest_policy(files, "base", "head")

    def test_changed_test_script_is_rejected(self):
        files = [{"filename": "package.json", "status": "modified"}]
        with patch.object(review, "content", side_effect=['{"scripts":{"test":"vitest"}}', '{"scripts":{"test":"true"}}']):
            with self.assertRaisesRegex(ValueError, "Package scripts"):
                review.manifest_policy(files, "base", "head")

    def test_shared_typescript_change_requires_consumer_checks(self):
        files = [{"filename": "packages/typescript/base.json", "status": "modified"}]
        with patch.object(review, "api", side_effect=[{"workflow_runs": [self.run]},
                         {"jobs": [{"name": review.CHECK, "conclusion": "success"},
                                   {"name": "Maintenance guards", "conclusion": "success"}]}]):
            with self.assertRaisesRegex(ValueError, "Packed consumer"):
                review.ci(self.pr, files=files)

    def test_consumer_scope_includes_code_fixtures_and_toolchain(self):
        for path in ("packages/spinetab/src/core/client.ts", "packages/typescript/base.json",
                     "packages/spinetab/tests/fixtures/consumers/vanilla-polling/variants/plugin-absent/main.js.txt",
                     "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"):
            with self.subTest(path=path):
                self.assertTrue(review.consumer_checks_required([path]))
                self.assertTrue(review.consumer_checks_required(["packages/spinetab/README.md", path]))

    def test_documentation_changes_do_not_require_packed_consumers(self):
        files = [{"filename": path, "status": "modified"} for path in (
            "README.md", "packages/spinetab/README.md", "packages/spinetab/CHANGELOG.md",
            "packages/spinetab/src/core/README.md", "apps/website/src/content/docs/overview.mdx")]
        self.assertFalse(review.consumer_checks_required(item["filename"] for item in files))
        with patch.object(review, "api", side_effect=[{"workflow_runs": [self.run]},
                         {"jobs": [{"name": review.CHECK, "conclusion": "success"},
                                   {"name": "Maintenance guards", "conclusion": "success"}]},
                         {"total_count": 0, "check_runs": []},
                         {"total_count": 0, "statuses": []}]):
            self.assertEqual(review.ci(self.pr, files=files)["id"], 42)

    def test_renaming_source_to_readme_cannot_bypass_consumer_checks(self):
        files = [{"filename": "packages/spinetab/README.md",
                  "previous_filename": "packages/spinetab/src/core/client.ts", "status": "renamed"}]
        with patch.object(review, "api", side_effect=[{"workflow_runs": [self.run]},
                         {"jobs": [{"name": review.CHECK, "conclusion": "success"},
                                   {"name": "Maintenance guards", "conclusion": "success"}]}]):
            with self.assertRaisesRegex(ValueError, "Packed consumer"):
                review.ci(self.pr, files=files)

    def test_failed_check_named_review_is_not_exempt(self):
        with patch.object(review, "api", side_effect=[{"workflow_runs": [self.run]},
                         {"jobs": [{"name": review.CHECK, "conclusion": "success"},
                                   {"name": "Maintenance guards", "conclusion": "success"}]},
                         {"total_count": 1, "check_runs": [{"name": "review", "status": "completed", "conclusion": "failure"}]}]):
            with self.assertRaisesRegex(ValueError, "Another check"):
                review.ci(self.pr)

    def test_failed_legacy_status_blocks_merge(self):
        with patch.object(review, "api", side_effect=[{"workflow_runs": [self.run]},
                         {"jobs": [{"name": review.CHECK, "conclusion": "success"},
                                   {"name": "Maintenance guards", "conclusion": "success"}]},
                         {"total_count": 0, "check_runs": []},
                         {"total_count": 1, "statuses": [{"state": "failure"}], "state": "failure"}]):
            with self.assertRaisesRegex(ValueError, "Another status"):
                review.ci(self.pr)

    def test_incomplete_status_listing_blocks_merge(self):
        with patch.object(review, "api", side_effect=[{"workflow_runs": [self.run]},
                         {"jobs": [{"name": review.CHECK, "conclusion": "success"},
                                   {"name": "Maintenance guards", "conclusion": "success"}]},
                         {"total_count": 0, "check_runs": []},
                         {"total_count": 2, "statuses": [{"state": "success"}], "state": "success"}]):
            with self.assertRaisesRegex(ValueError, "Incomplete status"):
                review.ci(self.pr)

    def test_library_change_requires_packed_consumer_checks(self):
        with patch.object(review, "api", side_effect=[{"workflow_runs": [self.run]},
                         {"jobs": [{"name": review.CHECK, "conclusion": "success"},
                                   {"name": "Maintenance guards", "conclusion": "success"}]}]):
            with self.assertRaisesRegex(ValueError, "Packed consumer"):
                review.ci(self.pr, files=self.files)

    def test_new_failed_ci_invalidates_old_success(self):
        failed = dict(self.run, id=43, conclusion="failure")
        with patch.object(review, "api", return_value={"workflow_runs": [self.run, failed]}):
            with self.assertRaisesRegex(ValueError, "not successful"):
                review.ci(self.pr)

    def test_skipped_test_job_is_not_a_pass(self):
        with patch.object(review, "api", side_effect=[{"workflow_runs": [self.run]},
                         {"jobs": [{"name": review.CHECK, "conclusion": "skipped"}]}]):
            with self.assertRaisesRegex(ValueError, "did not pass"):
                review.ci(self.pr)

    def approve(self, reviews):
        with patch.dict(os.environ, {"GITHUB_RUN_ID": "99"}):
            return review.approved(self.pr, reviews, 9, "b" * 40, self.run)

    def test_current_independent_approval(self):
        self.assertEqual(self.approve([self.approval])["id"], 9)

    def test_changed_commit_invalidates_approval(self):
        self.approval["commit_id"] = "d" * 40
        with self.assertRaisesRegex(ValueError, "current head"):
            self.approve([self.approval])

    def test_self_approval_is_rejected(self):
        self.pr["user"]["login"] = review.REVIEWER
        with self.assertRaisesRegex(ValueError, "Self-approval"):
            self.approve([self.approval])

    def test_dismissed_or_superseded_approval_is_rejected(self):
        later = copy.deepcopy(self.approval)
        later.update(id=10, state="DISMISSED")
        with self.assertRaisesRegex(ValueError, "superseded"):
            self.approve([self.approval, later])

    def test_another_reviewer_can_block_merge(self):
        other = {"id": 10, "user": {"login": "maintainer"}, "state": "CHANGES_REQUESTED"}
        with self.assertRaisesRegex(ValueError, "Outstanding"):
            self.approve([self.approval, other])

    def test_approval_from_another_run_is_rejected(self):
        self.approval["body"] = self.approval["body"].replace("Review run: 99", "Review run: 98")
        with self.assertRaisesRegex(ValueError, "Unrelated"):
            self.approve([self.approval])

    def test_merge_is_atomic_and_dispatches_the_actual_merge_commit(self):
        merged_sha = "c" * 40
        def fake(path, method="GET", data=None):
            if method == "PUT":
                self.assertEqual(path, "/pulls/12/merge")
                self.assertEqual(data, {"sha": self.pr["head"]["sha"], "merge_method": "squash"})
                return {"merged": True, "sha": merged_sha}
            if method == "POST":
                self.assertEqual(path, "/actions/workflows/ci.yml/dispatches")
                self.assertEqual(data, {"ref": "main", "inputs": {"deploy": True, "expected_sha": merged_sha}})
                return None
            self.assertEqual(path, "/pulls/12")
            return {"merged": True, "merge_commit_sha": merged_sha}

        with patch.dict(os.environ, {"DECISION": "approve", "REVIEW_ID": "9", "GITHUB_RUN_ID": "99"}), \
             patch.object(review, "evidence", return_value=(self.pr, "b" * 40, self.run)), \
             patch.object(review, "pages", return_value=[self.approval]), \
             patch.object(review, "api", side_effect=fake) as request:
            review.merge()
            self.assertEqual(request.call_count, 3)

    def test_changed_head_before_merge_cannot_dispatch_downstream(self):
        with patch.dict(os.environ, {"DECISION": "approve"}), \
             patch.object(review, "evidence", side_effect=ValueError("PR head changed")), \
             patch.object(review, "api") as request:
            with self.assertRaisesRegex(ValueError, "head changed"):
                review.merge()
            request.assert_not_called()

    def test_release_merge_dispatches_publication_for_exact_merge_commit(self):
        self.release_candidate()
        merged_sha = "c" * 40
        def fake(path, method="GET", data=None):
            if method == "PUT":
                self.assertEqual(data["sha"], self.pr["head"]["sha"])
                return {"merged": True, "sha": merged_sha}
            if method == "POST":
                if path == "/actions/workflows/ci.yml/dispatches":
                    self.assertEqual(data["inputs"], {"deploy": True, "expected_sha": merged_sha})
                else:
                    self.assertEqual(path, "/actions/workflows/publish.yml/dispatches")
                    self.assertEqual(data, {"ref": "main", "inputs": {"expected_sha": merged_sha}})
                return None
            return {"merged": True, "merge_commit_sha": merged_sha}
        with patch.dict(os.environ, {"DECISION": "approve", "REVIEW_ID": "9", "GITHUB_RUN_ID": "99",
                                    "RELEASE_BOT_LOGIN": "spinetab-release[bot]"}), \
             patch.object(review, "evidence", return_value=(self.pr, "b" * 40, self.run)), \
             patch.object(review, "pages", return_value=[self.approval]), \
             patch.object(review, "api", side_effect=fake) as request:
            review.merge()
            self.assertEqual(request.call_count, 4)


class ManualReviewTests(unittest.TestCase):
    def setUp(self):
        GuardTests.setUp(self)
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "event.json"
        self.inputs = {"pr_number": "12", "expected_head": "a" * 40, "authorise_policy": "true"}
        self.event()
        environment = patch.dict(os.environ, {
            "GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_EVENT_PATH": str(self.path),
            "GITHUB_REPOSITORY": review.REPO, "GITHUB_REF": "refs/heads/main",
            "GITHUB_ACTOR": "apetta", "GITHUB_TRIGGERING_ACTOR": "apetta", "GITHUB_SHA": "b" * 40,
        })
        environment.start()
        self.addCleanup(environment.stop)
        self.pr["labels"] = []
        self.files = [{"filename": ".github/workflows/ci.yml", "status": "modified"}]

    def event(self):
        self.path.write_text(json.dumps({"inputs": self.inputs}))

    def test_owner_can_request_protected_review_for_exact_head(self):
        review.eligible(self.pr, self.files)

    def test_manual_review_still_needs_explicit_policy_authorisation(self):
        self.inputs["authorise_policy"] = "false"
        self.event()
        with self.assertRaisesRegex(ValueError, "policy"):
            review.eligible(self.pr, self.files)
        self.files[0] = {"filename": "README.md", "status": "modified"}
        review.eligible(self.pr, self.files)

    def test_only_owner_can_dispatch_and_rerun(self):
        for key in ("GITHUB_ACTOR", "GITHUB_TRIGGERING_ACTOR"):
            with self.subTest(key=key), patch.dict(os.environ, {key: "someone"}), \
                 self.assertRaisesRegex(ValueError, "Only the owner"):
                review.manual_request()

    def test_candidate_branch_cannot_supply_the_reviewer(self):
        with patch.dict(os.environ, {"GITHUB_REF": "refs/heads/codex/candidate"}), \
             self.assertRaisesRegex(ValueError, "trusted main"):
            review.manual_request()

    def test_manual_review_requires_both_pr_and_full_sha(self):
        for key, value in (("expected_head", "abc123"), ("expected_head", ""), ("pr_number", "")):
            with self.subTest(key=key, value=value):
                original = self.inputs[key]
                self.inputs[key] = value
                self.event()
                with self.assertRaises(ValueError):
                    review.manual_request()
                self.inputs[key] = original

    def test_policy_checkbox_alone_cannot_start_a_sweep(self):
        self.inputs = {"authorise_policy": "true"}
        self.event()
        with self.assertRaisesRegex(ValueError, "needs a PR and commit"):
            review.manual_request()

    def test_automatic_event_cannot_inherit_policy_permission(self):
        self.pr["labels"] = [{"name": "agent:ready"}]
        with patch.dict(os.environ, {"GITHUB_EVENT_NAME": "workflow_run"}), \
             self.assertRaisesRegex(ValueError, "policy"):
            review.eligible(self.pr, self.files)

    def test_authorisation_covers_only_one_pr_and_head(self):
        for change in ({"number": 13}, {"head": dict(self.pr["head"], sha="c" * 40)}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                review.eligible(dict(self.pr, **change), self.files)

    def test_manual_review_cannot_read_environment_files_or_forks(self):
        self.files[0] = {"filename": ".env.production", "status": "modified"}
        with self.assertRaisesRegex(ValueError, "Environment files"):
            review.eligible(self.pr, self.files)
        self.pr["head"]["repo"] = {"full_name": "someone/spinetab"}
        with self.assertRaisesRegex(ValueError, "Forks"):
            review.eligible(self.pr, self.files)

    def test_authorised_toolchain_change_preserves_release_version_checks(self):
        files = [{"filename": "package.json", "status": "modified"}]
        with patch.object(review, "content", side_effect=['{"packageManager":"pnpm@10"}', '{"packageManager":"pnpm@12"}']):
            review.manifest_policy(files, "base", "head", authorise_policy=True)
        files[0]["filename"] = "packages/spinetab/package.json"
        with patch.object(review, "content", side_effect=['{"version":"0.1.0"}', '{"version":"0.0.9"}']), \
             self.assertRaisesRegex(ValueError, "advance only"):
            review.manifest_policy(files, "base", "head", release=True, authorise_policy=True)

    def test_reviewer_must_still_be_current_main(self):
        values = [self.pr, self.files, {"object": {"sha": "c" * 40}}]
        with patch.object(review, "api", side_effect=values), \
             self.assertRaisesRegex(ValueError, "Reviewer main changed"):
            review.current(12, "a" * 40)

    def test_manual_failure_is_visible_instead_of_successful_empty_sweep(self):
        with patch.object(review, "output"), patch.object(review, "api", return_value=self.pr), \
             patch.object(review, "current", side_effect=ValueError("PR head changed")), \
             self.assertRaisesRegex(ValueError, "head changed"):
            review.prepare()

    def test_manual_lane_cannot_auto_merge_or_dispatch_ci(self):
        with patch.object(review, "api") as request, self.assertRaisesRegex(ValueError, "do not auto-merge"):
            review.merge()
        request.assert_not_called()

    def test_manual_approval_is_a_formal_review_on_the_requested_commit(self):
        def submit(path, method="GET", data=None):
            self.assertEqual((path, method), ("/pulls/12/reviews", "POST"))
            self.assertEqual(data["event"], "APPROVE")
            self.assertEqual(data["commit_id"], self.inputs["expected_head"])
            self.assertIn("Owner-requested review", data["body"])
            return {"id": 9, "user": {"login": review.REVIEWER}, "commit_id": data["commit_id"]}
        with patch.dict(os.environ, {"DECISION": "approve", "REASON": '"No concrete defects found"', "GITHUB_RUN_ID": "99"}), \
             patch.object(review, "evidence", return_value=(self.pr, "b" * 40, self.run)), \
             patch.object(review, "api", side_effect=submit), patch.object(review, "output") as output:
            review.review()
            output.assert_called_once_with(review_id=9)

    def test_changed_head_prevents_manual_approval_write(self):
        with patch.object(review, "evidence", side_effect=ValueError("PR head changed")), \
             patch.object(review, "api") as request, self.assertRaisesRegex(ValueError, "head changed"):
            review.review()
        request.assert_not_called()


class SupervisorReviewTests(unittest.TestCase):
    def setUp(self):
        GuardTests.setUp(self)
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "event.json"
        self.event = {"action": "created", "issue": {"number": 12, "pull_request": {}}, "comment": {"id": 100}}
        self.event["issue"]["pull_request"] = {"url": f"https://api.github.com/repos/{review.REPO}/pulls/12"}
        self.path.write_text(json.dumps(self.event))
        self.pr.update(title="test: migrate the test runner", body="")
        self.files = [{"filename": "packages/spinetab/vitest.config.ts", "status": "modified"}]
        self.comment = {"id": 100, "user": {"login": "apetta", "type": "User"},
                        "performed_via_github_app": dict(review.SUPERVISOR_APP),
                        "issue_url": f"https://api.github.com/repos/{review.REPO}/issues/12",
                        "created_at": "2026-10-17T12:00:00Z", "updated_at": "2026-10-17T12:00:00Z",
                        "body": review.AUTHORISATION + "\nHead: " + "a" * 40 + "\nBase: " + "b" * 40
                        + "\n\nKeep the existing assertions while migrating the test runner."}
        self.reviews = []
        self.writes = []
        self.merged = False
        environment = patch.dict(os.environ, {
            "GITHUB_REPOSITORY": review.REPO, "GITHUB_REF": "refs/heads/main", "GITHUB_SHA": "b" * 40,
            "GITHUB_ACTOR": "apetta", "GITHUB_TRIGGERING_ACTOR": "apetta", "GITHUB_RUN_ID": "99",
            "GITHUB_EVENT_PATH": str(self.path), "ANTHROPIC_API_KEY": "", "RUNNER_DEBUG": "0",
            "PR_NUMBER": "12", "EXPECTED_HEAD": "a" * 40, "EXPECTED_BASE": "b" * 40,
            "CI_RUN": "42", "CI_ATTEMPT": "1", "REVIEW_ID": "9", "DECISION": "approve",
            "REASON": '"No concrete defect found"', "SUPERVISOR_COMMENT_ID": "100",
        })
        environment.start()
        self.addCleanup(environment.stop)

    def api(self, path, method="GET", data=None):
        if method != "GET":
            self.writes.append((path, method, data))
            if path == "/pulls/12/reviews":
                approval = dict(self.approval, body=data["body"], commit_id=data["commit_id"])
                self.reviews.append(approval)
                return approval
            if path == "/pulls/12/merge":
                self.merged = True
                return {"merged": True, "sha": "c" * 40}
            if path == "/actions/workflows/ci.yml/dispatches":
                return None
        if path == "/pulls/12":
            return dict(self.pr, merged=True, merge_commit_sha="c" * 40) if self.merged else self.pr
        if path == "/git/ref/heads/main":
            return {"object": {"sha": "b" * 40}}
        if path == "/issues/comments/100":
            return self.comment
        if path == "/compare/" + "b" * 40 + "..." + "a" * 40:
            return {"merge_base_commit": {"sha": "b" * 40}, "status": "ahead"}
        self.fail("Unexpected API operation: " + path)

    def pages(self, path):
        if path == "/pulls/12/files":
            return self.files
        if path == "/pulls/12/reviews":
            return self.reviews
        if path == "/issues/12/comments":
            return [self.comment]
        if path.startswith("/pulls?state=open"):
            return [self.pr]
        self.fail("Unexpected paginated API operation: " + path)

    def current(self):
        with patch.object(review, "api", side_effect=self.api), patch.object(review, "pages", side_effect=self.pages):
            return review.current(12, "a" * 40, "b" * 40)

    def test_supervisor_can_authorise_protected_configuration(self):
        self.current()
        self.assertFalse(self.writes)

    def test_owner_name_alone_is_not_supervisor_authorisation(self):
        for user, app in [({"login": "someone", "type": "User"}, review.SUPERVISOR_APP),
                          ({"login": "apetta", "type": "Bot"}, review.SUPERVISOR_APP),
                          (self.comment["user"], None),
                          (self.comment["user"], {"id": 123, "slug": "claude"}),
                          (self.comment["user"], {"id": 123, "slug": "chatgpt-codex-connector"}),
                          (self.comment["user"], {"id": 1144995, "slug": "another-app"})]:
            original = copy.deepcopy(self.comment)
            with self.subTest(user=user, app=app):
                self.comment.update(user=user, performed_via_github_app=app)
                with self.assertRaisesRegex(ValueError, "supervisor's GitHub connection"):
                    self.current()
                self.assertFalse(self.writes)
            self.comment = original

    def test_copied_untrusted_comment_does_not_authorise_a_sweep(self):
        self.comment["performed_via_github_app"] = {"id": 123, "slug": "claude"}
        with patch.object(review, "pages", side_effect=self.pages):
            self.assertIsNone(review.supervisor_request(self.pr))

    def test_authorisation_is_bound_to_both_commits_and_pr(self):
        for key, value, error in [
            ("issue_url", f"https://api.github.com/repos/{review.REPO}/issues/13", "another PR"),
            ("body", self.comment["body"].replace("Head: " + "a" * 40, "Head: " + "d" * 40), "head changed"),
            ("body", self.comment["body"].replace("Base: " + "b" * 40, "Base: " + "d" * 40), "base changed"),
            ("updated_at", "2026-10-17T12:01:00Z", "Edited authorisation"),
        ]:
            original = self.comment[key]
            with self.subTest(key=key, value=value), self.assertRaisesRegex(ValueError, error):
                self.comment[key] = value
                self.current()
            self.comment[key] = original
        self.assertFalse(self.writes)

    def test_malformed_authorisation_is_rejected(self):
        original = self.comment["body"]
        for body in [original.replace("a" * 40, "aaaaaaa"), original.replace("b" * 40, "main"),
                     original.split("\n\n")[0] + "\n\n", "Quoted: " + original]:
            with self.subTest(body=body), self.assertRaisesRegex(ValueError, "full head and base"):
                self.comment["body"] = body
                self.current()
        self.assertFalse(self.writes)

    def test_supervisor_still_needs_ready_label_and_trusted_main(self):
        self.pr["labels"] = []
        with self.assertRaisesRegex(ValueError, "agent:ready"):
            self.current()
        self.pr["labels"] = [{"name": "agent:ready"}]
        with patch.dict(os.environ, {"GITHUB_SHA": "d" * 40}), self.assertRaisesRegex(ValueError, "Reviewer main changed"):
            self.current()

    def test_supervisor_cannot_authorise_forks_or_environment_files(self):
        self.files[0]["filename"] = ".env.production"
        with self.assertRaisesRegex(ValueError, "Environment files"):
            self.current()
        self.files[0]["filename"] = "packages/spinetab/vitest.config.ts"
        self.pr["head"]["repo"]["full_name"] = "someone/spinetab"
        with self.assertRaisesRegex(ValueError, "Forks"):
            self.current()

    def prepare(self, event_name):
        original = Path.cwd()
        os.chdir(self.directory.name)
        try:
            with patch.dict(os.environ, {"GITHUB_EVENT_NAME": event_name, "SUPERVISOR_COMMENT_ID": ""}), \
                 patch.object(review, "api", side_effect=self.api), patch.object(review, "pages", side_effect=self.pages), \
                 patch.object(review, "ci", return_value=dict(self.run, html_url="https://github.com/apetta/spinetab/actions/runs/42")), \
                 patch.object(review, "content", return_value="existing assertions retained\n"), \
                 patch.object(review, "output") as output:
                review.prepare()
                return json.loads(Path("review-input.json").read_text()), output.call_args_list
        finally:
            os.chdir(original)

    def test_comment_prepares_exact_candidate_and_records_permission_not_approval(self):
        evidence, outputs = self.prepare("issue_comment")
        self.assertEqual(evidence["supervisor_request"]["id"], 100)
        self.assertEqual(evidence["supervisor_request"]["head"], "a" * 40)
        self.assertNotIn("owner_request", evidence)
        self.assertTrue(any(call.kwargs.get("supervisor_comment_id") == "100" for call in outputs))
        self.assertFalse(self.writes)

    def test_daily_sweep_recovers_existing_authorisation(self):
        self.path.write_text("{}")
        evidence, _ = self.prepare("schedule")
        self.assertEqual(evidence["supervisor_request"]["id"], 100)

    def test_stale_authorisation_is_not_reused_on_new_head(self):
        self.pr["head"]["sha"] = "d" * 40
        with patch.object(review, "pages", side_effect=self.pages):
            self.assertIsNone(review.supervisor_request(self.pr))

    def test_comment_event_requires_owner_new_pr_comment_and_main(self):
        for key, value in [("GITHUB_ACTOR", "someone"), ("GITHUB_TRIGGERING_ACTOR", "someone"),
                           ("GITHUB_REF", "refs/heads/claude/candidate")]:
            with self.subTest(key=key), patch.dict(os.environ, {key: value}), self.assertRaises(ValueError):
                self.prepare("issue_comment")
        for change in [{"action": "edited"}, {"issue": {"number": 12}}, {"comment": {"id": None}}]:
            self.path.write_text(json.dumps(dict(self.event, **change)))
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.prepare("issue_comment")

    def test_verified_review_then_guarded_merge_dispatches_downstream_ci(self):
        with patch.object(review, "api", side_effect=self.api), patch.object(review, "pages", side_effect=self.pages), \
             patch.object(review, "ci", return_value=self.run), patch.object(review, "output"):
            review.review()
            self.assertIn("Supervisor authorisation:", self.reviews[0]["body"])
            self.assertEqual(self.reviews[0]["user"]["login"], review.REVIEWER)
            review.merge()
        self.assertEqual([item[:2] for item in self.writes], [
            ("/pulls/12/reviews", "POST"), ("/pulls/12/merge", "PUT"),
            ("/actions/workflows/ci.yml/dispatches", "POST")])
        self.assertEqual(self.writes[1][2]["sha"], "a" * 40)
        self.assertEqual(self.writes[2][2], {"ref": "main", "inputs": {"deploy": True, "expected_sha": "c" * 40}})

    def test_changed_head_after_review_blocks_merge(self):
        with patch.object(review, "api", side_effect=self.api), patch.object(review, "pages", side_effect=self.pages), \
             patch.object(review, "ci", return_value=self.run), patch.object(review, "output"):
            review.review()
            self.pr["head"]["sha"] = "d" * 40
            with self.assertRaisesRegex(ValueError, "head changed"):
                review.merge()
        self.assertEqual(len(self.writes), 1)

    def test_failed_ci_cannot_post_supervisor_approval(self):
        with patch.object(review, "api", side_effect=self.api), patch.object(review, "pages", side_effect=self.pages), \
             patch.object(review, "ci", side_effect=ValueError("Latest CI is not successful")), \
             self.assertRaisesRegex(ValueError, "CI is not successful"):
            review.review()
        self.assertFalse(self.writes)

    def test_supervisor_permission_alone_cannot_merge(self):
        with patch.object(review, "api", side_effect=self.api), patch.object(review, "pages", side_effect=self.pages), \
             patch.object(review, "ci", return_value=self.run), self.assertRaisesRegex(ValueError, "superseded"):
            review.merge()
        self.assertFalse(self.writes)

    def test_new_permission_does_not_reuse_an_old_manual_review(self):
        self.reviews = [self.approval]
        evidence, _ = self.prepare("issue_comment")
        self.assertEqual(evidence["supervisor_request"]["id"], 100)

    def test_same_permission_and_evidence_are_not_reviewed_twice(self):
        self.reviews = [dict(self.approval, body=self.approval["body"] +
                             f"\nSupervisor authorisation: https://github.com/{review.REPO}/pull/12#issuecomment-100")]
        self.path.write_text("{}")
        with patch.dict(os.environ, {"GITHUB_EVENT_NAME": "schedule", "SUPERVISOR_COMMENT_ID": ""}), \
             patch.object(review, "api", side_effect=self.api), patch.object(review, "pages", side_effect=self.pages), \
             patch.object(review, "ci", return_value=self.run), patch.object(review, "output") as output:
            review.prepare()
        self.assertFalse(any(call.kwargs.get("ready") == "true" for call in output.call_args_list))

    def test_authorisation_is_rechecked_before_writing(self):
        self.comment["performed_via_github_app"] = None
        with patch.object(review, "api", side_effect=self.api), patch.object(review, "pages", side_effect=self.pages), \
             self.assertRaisesRegex(ValueError, "supervisor's GitHub connection"):
            review.review()
        self.assertFalse(self.writes)


class PrepareTriggerTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "event.json"
        self.event = {"workflow_run": {"name": "Maintenance readiness", "conclusion": "success",
                                      "path": ".github/workflows/maintenance-ready.yml",
                                      "event": "pull_request_target", "actor": {"login": "apetta"}}}

    def prepare(self):
        self.path.write_text(json.dumps(self.event))
        with patch.dict(os.environ, {"GITHUB_EVENT_NAME": "workflow_run", "GITHUB_EVENT_PATH": str(self.path), "ANTHROPIC_API_KEY": "", "RUNNER_DEBUG": "0"}), \
             patch.object(review, "output"), patch.object(review, "api", return_value=[]) as request:
            review.prepare()
            return request

    def test_completed_trusted_readiness_can_start_review(self):
        request = self.prepare()
        request.assert_called_once_with("/pulls?state=open&sort=created&direction=asc&per_page=100&page=1")

    def test_untrusted_readiness_origin_is_rejected(self):
        for key, value in [("path", ".github/workflows/other.yml"), ("event", "pull_request"),
                           ("actor", {"login": "someone"})]:
            with self.subTest(key=key):
                original = self.event["workflow_run"][key]
                self.event["workflow_run"][key] = value
                with self.assertRaisesRegex(ValueError, "Unexpected readiness"):
                    self.prepare()
                self.event["workflow_run"][key] = original

    def test_ci_cannot_impersonate_readiness(self):
        self.event["workflow_run"].update(name="CI", path=review.CI_PATH)
        with self.assertRaisesRegex(ValueError, "Not a PR CI event"):
            self.prepare()

    def test_github_security_check_can_start_review(self):
        self.event = {"check_run": {"name": "CodeQL", "app": {"id": 57789},
                                    "conclusion": "success", "head_sha": "a" * 40}}
        self.prepare().assert_called_once()

    def test_another_app_cannot_impersonate_codeql(self):
        self.event = {"check_run": {"name": "CodeQL", "app": {"id": 15368},
                                    "conclusion": "success", "head_sha": "a" * 40}}
        with self.assertRaisesRegex(ValueError, "Unexpected security check"):
            self.prepare()


class PrepareEvidenceTests(unittest.TestCase):
    def prepare(self, paths, before, after):
        pr = {"number": 11, "head": {"sha": "a" * 40}, "title": "fix(deps): patch Solid", "body": ""}
        files = [path if isinstance(path, dict) else {"filename": path, "status": "modified"} for path in paths]
        run = {"id": 42, "run_attempt": 1, "html_url": "https://github.com/apetta/spinetab/actions/runs/42"}
        with tempfile.TemporaryDirectory() as directory:
            original = Path.cwd()
            os.chdir(directory)
            try:
                event = Path("event.json").resolve()
                event.write_text('{"inputs":{"pr_number":"11"}}')
                def contents(path, ref, limit=250_000):
                    expected = [item.get("previous_filename", item["filename"]) if ref == "b" * 40
                                else item["filename"] for item in files]
                    self.assertIn(path, expected)
                    value = before if ref == "b" * 40 else after
                    self.assertLessEqual(len(value), limit)
                    return value
                with patch.dict(os.environ, {"GITHUB_EVENT_NAME": "workflow_run", "GITHUB_EVENT_PATH": str(event), "ANTHROPIC_API_KEY": "", "RUNNER_DEBUG": "0"}), \
                     patch.object(review, "api", return_value=pr), patch.object(review, "pages", return_value=[]), \
                     patch.object(review, "current", return_value=(pr, files, "b" * 40)), \
                     patch.object(review, "ci", return_value=run), patch.object(review, "content", side_effect=contents), \
                     patch.object(review, "output") as output:
                    review.prepare()
                    evidence = Path("review-input.json")
                    return json.loads(evidence.read_text()) if evidence.exists() else None, output.call_args_list
            finally:
                os.chdir(original)

    def test_root_and_fixture_locks_include_every_change_without_unchanged_bodies(self):
        paths = ["pnpm-lock.yaml", "packages/spinetab/tests/fixtures/consumers/alpha/pnpm-lock.yaml",
                 "packages/spinetab/tests/fixtures/consumers/beta/pnpm-lock.yaml"]
        unchanged = "packages:\n" + "".join(f"  unchanged-package-{i}: {{}}\n" for i in range(7000))
        before = unchanged + "  solid-js:\n    version: 1.9.15\n"
        after = unchanged + "  solid-js:\n    version: 1.9.17\n    peerDependencies:\n      seroval: ^1.6.8\n"
        evidence, outputs = self.prepare(paths, before, after)
        self.assertIsNotNone(evidence)
        self.assertTrue(any(call.kwargs.get("ready") == "true" for call in outputs))
        for record in evidence["files"]:
            with self.subTest(path=record["path"]):
                self.assertEqual(set(record), {"path", "status", "patch"})
                patch_text = "".join(record["patch"])
                self.assertIn(f"--- before/{record['path']}\n", patch_text)
                self.assertIn(f"+++ after/{record['path']}\n", patch_text)
                self.assertIn("-    version: 1.9.15\n", patch_text)
                self.assertIn("+    version: 1.9.17\n", patch_text)
                self.assertIn("+    peerDependencies:\n+      seroval: ^1.6.8\n", patch_text)
                self.assertNotIn("unchanged-package-0:", patch_text)

    def test_renamed_fixture_lock_reads_and_identifies_its_original_path(self):
        previous = "packages/spinetab/tests/fixtures/consumers/old/pnpm-lock.yaml"
        path = "packages/spinetab/tests/fixtures/consumers/new/pnpm-lock.yaml"
        evidence, outputs = self.prepare([{"filename": path, "previous_filename": previous, "status": "renamed"}],
                                         "version: 1.9.15\n", "version: 1.9.17\n")
        self.assertTrue(any(call.kwargs.get("ready") == "true" for call in outputs))
        self.assertEqual(evidence["files"][0]["previous_path"], previous)
        patch_text = "".join(evidence["files"][0]["patch"])
        self.assertIn(f"--- before/{previous}\n", patch_text)
        self.assertIn(f"+++ after/{path}\n", patch_text)
        self.assertIn("-version: 1.9.15\n+version: 1.9.17\n", patch_text)

    def test_rename_only_keeps_original_lockfile_identity(self):
        previous = "packages/spinetab/tests/fixtures/consumers/old/pnpm-lock.yaml"
        path = "packages/spinetab/tests/fixtures/consumers/new/pnpm-lock.yaml"
        evidence, outputs = self.prepare([{"filename": path, "previous_filename": previous, "status": "renamed"}],
                                         "version: 1.9.17\n", "version: 1.9.17\n")
        self.assertTrue(any(call.kwargs.get("ready") == "true" for call in outputs))
        self.assertEqual(evidence["files"][0], {"path": path, "status": "renamed", "previous_path": previous, "patch": []})

    def test_large_fixture_lock_diff_still_fails_closed(self):
        evidence, outputs = self.prepare(["packages/spinetab/tests/fixtures/consumers/alpha/pnpm-lock.yaml"],
                                         "old-line\n" * 12000, "new-line\n" * 12000)
        self.assertIsNone(evidence)
        self.assertFalse(any(call.kwargs.get("ready") == "true" for call in outputs))

    def test_small_source_keeps_full_before_and_after(self):
        evidence, _ = self.prepare(["packages/spinetab/src/example.ts"], "old();\n", "new();\n")
        self.assertEqual(evidence["files"][0], {
            "path": "packages/spinetab/src/example.ts", "status": "modified",
            "before": ["old();\n"], "after": ["new();\n"],
        })

    def test_large_source_keeps_complete_base_and_every_change_within_packet_cap(self):
        before = "".join(f"\t\t\t\t\t\tunchanged_line_{i:04d}(value);\n" for i in range(6200)) + "old_tail()"
        after = before.replace("unchanged_line_2000(value);", "changed_line_2000(value);")
        after = after.replace("unchanged_line_6000(value);", "changed_line_6000(value);")
        after = after.replace("old_tail()", "new_tail()")
        full_pair = {"before": before.splitlines(True), "after": after.splitlines(True)}
        self.assertGreater(len(json.dumps(full_pair, indent=2)), 600000)
        evidence, outputs = self.prepare(["packages/spinetab/src/example.ts"], before, after)
        self.assertIsNotNone(evidence)
        self.assertTrue(any(call.kwargs.get("ready") == "true" for call in outputs))
        record = evidence["files"][0]
        self.assertEqual(set(record), {"path", "status", "before", "patch"})
        self.assertEqual("".join(record["before"]), before)
        patch_text = "".join(record["patch"])
        for line in ("2000", "6000"):
            self.assertIn(f"-\t\t\t\t\t\tunchanged_line_{line}(value);\n", patch_text)
            self.assertIn(f"+\t\t\t\t\t\tchanged_line_{line}(value);\n", patch_text)
        self.assertEqual(record["patch"][-2:], ["-old_tail()", "+new_tail()"])
        self.assertLessEqual(len(json.dumps(evidence, indent=2)), 600000)

    def test_large_source_diff_still_fails_closed(self):
        before = "".join(f"\t\t\t\t\t\told_line_{i:04d}(value);\n" for i in range(7000))
        after = before.replace("old_line_", "new_line_")
        evidence, outputs = self.prepare(["packages/spinetab/src/example.ts"], before, after)
        self.assertIsNone(evidence)
        self.assertFalse(any(call.kwargs.get("ready") == "true" for call in outputs))

    def test_large_complete_bases_still_exceed_packet_cap(self):
        before = "".join(f"\t\t\t\t\t\tunchanged_line_{i:04d}(value);\n" for i in range(6200))
        after = before.replace("unchanged_line_2000(value);", "changed_line_2000(value);")
        evidence, outputs = self.prepare(["packages/spinetab/src/one.ts", "packages/spinetab/src/two.ts"], before, after)
        self.assertIsNone(evidence)
        self.assertFalse(any(call.kwargs.get("ready") == "true" for call in outputs))


class ReadCoverageTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "review-input.json"
        self.path.write_text("one\ntwo\nthree\nfour")

    def result(self, start, count, capped=False):
        return {"tool_use_result": {"type": "text", "file": {
            "filePath": str(self.path), "startLine": start, "numLines": count,
            "totalLines": 4, "truncatedByTokenCap": capped}}}

    def test_every_line_was_received(self):
        review.complete_reads([self.result(1, 2), self.result(3, 2)], self.path)

    def test_reading_only_the_start_and_end_is_not_enough(self):
        with self.assertRaisesRegex(ValueError, "all evidence"):
            review.complete_reads([self.result(1, 1), self.result(4, 1)], self.path)

    def test_token_capped_last_line_must_be_read_again(self):
        with self.assertRaisesRegex(ValueError, "all evidence"):
            review.complete_reads([self.result(1, 2, capped=True), self.result(3, 2)], self.path)

    def test_overlap_completes_a_token_capped_read(self):
        review.complete_reads([self.result(1, 2, capped=True), self.result(2, 3)], self.path)

    def test_missing_sdk_read_metadata_fails_closed(self):
        with self.assertRaisesRegex(ValueError, "all evidence"):
            review.complete_reads([{"type": "user", "message": {"content": "Read succeeded"}}], self.path)

    def test_reading_another_file_is_rejected(self):
        result = self.result(1, 4)
        result["tool_use_result"]["file"]["filePath"] = str(self.path.with_name("other.json"))
        with self.assertRaisesRegex(ValueError, "Unexpected read result"):
            review.complete_reads([result], self.path)

    def test_wrong_total_line_count_is_rejected(self):
        result = self.result(1, 4)
        result["tool_use_result"]["file"]["totalLines"] = 5
        with self.assertRaisesRegex(ValueError, "mismatch"):
            review.complete_reads([result], self.path)


if __name__ == "__main__":
    unittest.main()
