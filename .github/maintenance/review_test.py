import copy
import importlib.util
import os
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("review", Path(__file__).with_name("review.py"))
review = importlib.util.module_from_spec(spec)
spec.loader.exec_module(review)


class GuardTests(unittest.TestCase):
    def setUp(self):
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
        for path in [".github/workflows/ci.yml", ".claude/settings.json", "AGENTS.md", ".npmrc", "apps/website/.env.local"]:
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
                         {"total_count": 0, "check_runs": []}]):
            self.assertEqual(review.ci(self.pr)["id"], 42)

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


if __name__ == "__main__":
    unittest.main()
