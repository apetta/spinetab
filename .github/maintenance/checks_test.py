import copy
import importlib.util
import os
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("checks", Path(__file__).with_name("checks.py"))
checks = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checks)


class ReviewCheckTests(unittest.TestCase):
    def setUp(self):
        environment = patch.dict(os.environ, {
            "GITHUB_REPOSITORY": "apetta/spinetab", "GITHUB_RUN_ID": "99",
            "PR_NUMBER": "12", "EXPECTED_HEAD": "a" * 40, "CHECK_ID": "7",
            "CHECK_TOKEN": "synthetic-check-token", "ANALYSIS_RESULT": "success",
            "REVIEW_RESULT": "success", "DECISION": "approve",
            "CLAUDE_CODE_OAUTH_TOKEN": "", "ANTHROPIC_API_KEY": "",
        })
        environment.start()
        self.addCleanup(environment.stop)
        self.check = {"id": 7, "app": {"id": checks.APP_ID}, "name": checks.NAME,
                      "head_sha": "a" * 40, "external_id": "99"}

    def test_progress_is_attached_to_the_exact_candidate_and_app(self):
        with patch.object(checks, "api", return_value=self.check) as api, patch.object(checks, "output") as output:
            checks.start()
        args, kwargs = api.call_args
        self.assertEqual(args[:2], ("/check-runs", "POST"))
        self.assertEqual(args[2]["head_sha"], "a" * 40)
        self.assertEqual(args[2]["status"], "in_progress")
        self.assertEqual(kwargs["token"], "synthetic-check-token")
        output.assert_called_once_with(check_id=7)

    def test_only_a_successfully_posted_approval_can_show_success(self):
        cases = [
            ({}, "success"),
            ({"DECISION": "request_changes"}, "failure"),
            ({"DECISION": "escalate"}, "action_required"),
            ({"REVIEW_RESULT": "failure"}, "failure"),
            ({"ANALYSIS_RESULT": "failure", "REVIEW_RESULT": "skipped"}, "failure"),
            ({"ANALYSIS_RESULT": "cancelled", "REVIEW_RESULT": "skipped"}, "cancelled"),
            ({"REVIEW_RESULT": "cancelled"}, "cancelled"),
        ]
        for environment, conclusion in cases:
            with self.subTest(environment=environment), patch.dict(os.environ, environment), \
                 patch.object(checks, "api", side_effect=[self.check, {}]) as api:
                checks.finish()
                args, kwargs = api.call_args
                self.assertEqual(args[:2], ("/check-runs/7", "PATCH"))
                self.assertEqual(args[2]["status"], "completed")
                self.assertEqual(args[2]["conclusion"], conclusion)
                self.assertEqual(kwargs["token"], "synthetic-check-token")

    def test_never_updates_another_app_commit_or_run(self):
        for change in ({"app": {"id": 1}}, {"head_sha": "b" * 40},
                       {"external_id": "100"}, {"name": "CodeQL"}):
            with self.subTest(change=change), patch.object(checks, "api",
                    return_value=dict(copy.deepcopy(self.check), **change)) as api:
                with self.assertRaisesRegex(ValueError, "Unrelated"):
                    checks.finish()
                self.assertEqual(api.call_count, 1)

    def test_missing_or_invalid_decision_cannot_show_an_approval(self):
        for decision in ("", "unrecognised"):
            with self.subTest(decision=decision), patch.dict(os.environ, {"DECISION": decision}), \
                 patch.object(checks, "api", return_value=self.check) as api:
                with self.assertRaisesRegex(ValueError, "Missing review decision"):
                    checks.finish()
                self.assertEqual(api.call_count, 1)

    def test_status_writes_cannot_run_with_model_credentials(self):
        for name in ("CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"):
            with self.subTest(name=name), patch.dict(os.environ, {name: "synthetic-token"}), \
                 patch.object(checks, "api") as api:
                with self.assertRaisesRegex(ValueError, "model credentials"):
                    checks.start()
                api.assert_not_called()


if __name__ == "__main__":
    unittest.main()
