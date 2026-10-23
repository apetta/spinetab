import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
from review import TECHNICAL_SUPERVISOR_APP

spec = importlib.util.spec_from_file_location("handoff", Path(__file__).with_name("handoff.py"))
handoff = importlib.util.module_from_spec(spec)
spec.loader.exec_module(handoff)


class HandoffTests(unittest.TestCase):
    def setUp(self):
        environment = patch.dict(os.environ, {"GITHUB_REPOSITORY": handoff.REPO,
            "GITHUB_REF": "refs/heads/main", "GITHUB_EVENT_NAME": "issue_comment",
            "GITHUB_ACTOR": "apetta", "GITHUB_TRIGGERING_ACTOR": "apetta",
            "GITHUB_RUN_ATTEMPT": "1", "RUNNER_DEBUG": "0"})
        environment.start()
        self.addCleanup(environment.stop)
        self.event = {"action": "created", "sender": {"id": handoff.OWNER_ID},
                      "issue": {"number": 24}, "comment": {"id": 100}}
        self.comment = {"id": 100, "user": {"id": handoff.OWNER_ID, "login": "apetta", "type": "User"},
                        "performed_via_github_app": dict(handoff.SUPERVISOR_APP),
                        "issue_url": f"https://api.github.com/repos/{handoff.REPO}/issues/24",
                        "created_at": "2026-10-18T12:00:00Z", "updated_at": "2026-10-18T12:00:00Z",
                        "body": handoff.MARKER + "\nHead: " + "a" * 40 + "\nBase: " + "b" * 40 + "\n\nRefresh this PR."}
        self.pr = {"state": "open", "head": {"sha": "a" * 40, "repo": {"full_name": handoff.REPO}},
                   "base": {"ref": "main", "repo": {"full_name": handoff.REPO}}}
        self.run = {"id": 42, "path": ".github/workflows/ci.yml", "head_branch": "main",
                    "head_sha": "b" * 40, "event": "workflow_dispatch", "status": "completed", "conclusion": "failure",
                    "head_repository": {"full_name": handoff.REPO},
                    "actor": {"login": "apetta", "id": handoff.OWNER_ID},
                    "triggering_actor": {"login": "apetta", "id": handoff.OWNER_ID}}

    def api(self, path):
        return {"/issues/comments/100": self.comment, "/pulls/24": self.pr,
                "/git/ref/heads/main": {"object": {"sha": "b" * 40}}, "/actions/runs/42": self.run}[path]

    def prepare(self):
        with patch.object(handoff, "api", side_effect=self.api):
            return handoff.prepare(self.event)

    def test_connector_handoff_delivers_only_verified_identifiers(self):
        result = self.prepare()
        self.assertEqual(result["key"], "comment-100")
        self.assertEqual(result["work"]["comment_id"], 100)
        self.assertNotIn("Refresh", json.dumps(result))

    def test_technical_supervisor_uses_the_same_exact_head_handoff(self):
        self.comment["performed_via_github_app"] = dict(TECHNICAL_SUPERVISOR_APP)
        self.assertEqual(self.prepare()["work"]["comment_id"], 100)
        self.comment["body"] = self.comment["body"].replace("a" * 40, "c" * 40)
        with self.assertRaisesRegex(ValueError, "head or base changed"):
            self.prepare()

    def continuation(self):
        self.comment["performed_via_github_app"] = dict(TECHNICAL_SUPERVISOR_APP)
        self.comment["body"] = self.comment["body"].replace(handoff.MARKER, handoff.CONTINUATION_MARKER)
        return self.prepare()["work"]

    def test_continuation_binds_the_original_request_without_copying_its_task(self):
        work = self.continuation()
        self.assertEqual(work["kind"], "supervisor-continuation")
        self.assertEqual(work["pr"], 24)
        self.assertEqual(work["comment_id"], 100)
        self.assertNotIn("Refresh", json.dumps(work))
        for change in [{"performed_via_github_app": None},
                       {"updated_at": "2026-10-18T12:01:00Z"},
                       {"body": self.comment["body"].replace("a" * 40, "c" * 40)},
                       {"body": self.comment["body"].replace("b" * 40, "c" * 40)}]:
            original = copy.deepcopy(self.comment)
            self.comment.update(change)
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.prepare()
            self.comment = original

    def test_continuation_notifies_the_watcher_without_starting_a_worker_or_approving(self):
        work = self.continuation()
        writes = []
        def api(path, method="GET", data=None):
            if method == "GET":
                return self.api(path)
            writes.append((path, method, data))
            return {"id": 12, "state": "COMMENTED", "commit_id": work["head"]}
        with patch.object(handoff, "api", side_effect=api), \
             patch.object(handoff, "pages", return_value=[]), \
             patch.object(handoff.urllib.request, "urlopen") as fire, \
             patch.object(handoff, "Path") as path:
            handoff.dispatch(work, self.event)
        fire.assert_not_called()
        self.assertEqual(len(writes), 1)
        target, method, review = writes[0]
        self.assertEqual((target, method), ("/pulls/24/reviews", "POST"))
        self.assertEqual(review["event"], "COMMENT")
        self.assertEqual(review["commit_id"], "a" * 40)
        self.assertTrue(review["body"].startswith(handoff.DELIVERY_MARKER + "\nRequest: 100\n"))
        self.assertIn(f"https://github.com/{handoff.REPO}/pull/24#issuecomment-100", review["body"])
        self.assertNotIn("Refresh this PR", review["body"])
        path.return_value.write_text.assert_called_once_with("accepted\n")

    def test_continuation_receipt_prevents_a_repeat_after_uncertain_delivery(self):
        work = self.continuation()
        receipt = {"user": {"id": 41898282, "login": "github-actions[bot]", "type": "Bot"},
                   "state": "COMMENTED", "body": handoff.DELIVERY_MARKER + "\nRequest: 100\n"}
        with patch.object(handoff, "api", side_effect=self.api) as api, \
             patch.object(handoff, "pages", return_value=[receipt]), \
             patch.object(handoff.urllib.request, "urlopen") as fire, patch.object(handoff, "Path") as path:
            handoff.dispatch(work, self.event)
        self.assertTrue(all(len(call.args) == 1 for call in api.call_args_list))
        fire.assert_not_called()
        path.return_value.write_text.assert_called_once_with("accepted\n")

    def test_failed_continuation_has_no_receipt_or_automatic_retry(self):
        work = self.continuation()
        for result in [TimeoutError(), None, {}, {"id": 12, "state": "APPROVED", "commit_id": work["head"]},
                       {"id": 12, "state": "COMMENTED", "commit_id": "c" * 40}]:
            posts = []
            def api(target, method="GET", data=None):
                if method == "GET":
                    return self.api(target)
                posts.append(data)
                if isinstance(result, Exception):
                    raise result
                return result
            with self.subTest(result=result), patch.object(handoff, "api", side_effect=api), \
                 patch.object(handoff, "pages", return_value=[]), patch.object(handoff, "Path") as path, \
                 self.assertRaises((ValueError, TimeoutError)):
                handoff.dispatch(work, self.event)
            self.assertEqual(len(posts), 1)
            path.assert_not_called()

    def test_outside_plain_owner_and_forged_app_comments_fail_closed(self):
        for change in [{"user": {"id": 123, "login": "apetta", "type": "User"}},
                       {"performed_via_github_app": None},
                       {"performed_via_github_app": {"id": 1144995, "slug": "other"}},
                       {"performed_via_github_app": {"id": 1236702, "slug": "other"}},
                       {"updated_at": "2026-10-18T12:01:00Z"},
                       {"body": "@claude please refresh"},
                       {"issue_url": "https://api.github.com/repos/outside/repo/issues/24"}]:
            original = copy.deepcopy(self.comment)
            self.comment.update(change)
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.prepare()
            self.comment = original

    def test_stale_head_base_closed_and_fork_targets_rejected(self):
        self.pr["state"] = "closed"
        with self.assertRaises(ValueError):
            self.prepare()
        self.pr["state"] = "open"
        for side, key, value in [("head", "sha", "c" * 40), ("base", "ref", "other"),
                                 ("head", "repo", {"full_name": "outside/repo"}), ("head", "repo", None)]:
            original = copy.deepcopy(self.pr)
            self.pr[side][key] = value
            with self.subTest(side=side, key=key), self.assertRaises(ValueError):
                self.prepare()
            self.pr = original
        self.comment["body"] = self.comment["body"].replace("b" * 40, "c" * 40)
        with self.assertRaises(ValueError):
            self.prepare()

    def test_delivery_context_and_reruns_cannot_impersonate_owner(self):
        for change in [{"GITHUB_REPOSITORY": "outside/repo"}, {"GITHUB_REF": "refs/heads/claude/pr"},
                       {"GITHUB_ACTOR": "someone"}, {"GITHUB_TRIGGERING_ACTOR": "someone"},
                       {"RUNNER_DEBUG": "1"},
                       {"GITHUB_RUN_ATTEMPT": "2", "GITHUB_TRIGGERING_ACTOR": "someone"}]:
            with self.subTest(change=change), patch.dict(os.environ, change), self.assertRaises(ValueError):
                self.prepare()

    def test_owner_can_redeliver_only_an_existing_verified_comment(self):
        self.event = {"inputs": {"comment_id": "100"}}
        with patch.dict(os.environ, {"GITHUB_EVENT_NAME": "workflow_dispatch"}):
            self.assertEqual(self.prepare()["key"], "comment-100")
            self.comment["performed_via_github_app"] = None
            with self.assertRaises(ValueError):
                self.prepare()

    def test_main_failure_rechecked_and_deduplicated_by_commit(self):
        self.event = {"workflow_run": {"id": 42}}
        with patch.dict(os.environ, {"GITHUB_EVENT_NAME": "workflow_run"}):
            self.assertEqual(self.prepare()["key"], "main-" + "b" * 40)
            for change in [{"conclusion": "success"}, {"status": "in_progress"}, {"head_sha": "c" * 40}]:
                original = dict(self.run)
                self.run.update(change)
                self.assertIsNone(self.prepare())
                self.run = original
            for change in [{"path": "other.yml"}, {"head_branch": "claude/pr"}, {"event": "pull_request"},
                           {"actor": {"login": "apetta", "id": 123}},
                           {"triggering_actor": {"login": "someone", "id": 123}}]:
                original = dict(self.run)
                self.run.update(change)
                with self.subTest(change=change), self.assertRaises(ValueError):
                    self.prepare()
                self.run = original

    def test_fire_receipt_does_not_disclose_private_session_or_retry(self):
        work = {"repository": handoff.REPO, "pr": 24}
        with patch.object(handoff, "prepare", return_value={"work": work}), \
             patch.dict(os.environ, {"ROUTINE_ID": "trig_test", "ROUTINE_TOKEN": "synthetic"}), \
             patch.object(handoff.urllib.request, "urlopen", return_value=io.BytesIO(json.dumps({
                 "claude_code_session_url": "https://claude.ai/code/session_test"}).encode())) as send, \
             patch.object(handoff, "Path") as path, patch("sys.stdout", new_callable=io.StringIO) as log:
            handoff.dispatch(work, self.event)
            send.assert_called_once()
            request = send.call_args.args[0]
            self.assertEqual(request.get_header("Anthropic-beta"), "experimental-cc-routine-2026-04-01")
            self.assertEqual(request.get_header("Anthropic-version"), "2023-06-01")
            path.assert_called_once_with("maintenance-handoff-ack")
            self.assertNotIn("session_test", log.getvalue())
            self.assertNotIn("synthetic", log.getvalue())
            path.return_value.write_text.assert_called_once_with("accepted\n")
        with patch.object(handoff, "prepare", return_value={"work": {}}), \
             patch.dict(os.environ, {"ROUTINE_ID": "trig_test", "ROUTINE_TOKEN": "synthetic"}), \
             patch.object(handoff.urllib.request, "urlopen", side_effect=TimeoutError) as send, \
             self.assertRaises(TimeoutError):
            handoff.dispatch({}, self.event)
        send.assert_called_once()

    def test_changed_target_before_delivery_never_calls_claude(self):
        work = self.prepare()["work"]
        self.pr["head"]["sha"] = "c" * 40
        with patch.object(handoff, "api", side_effect=self.api), \
             patch.object(handoff.urllib.request, "urlopen") as send, self.assertRaises(ValueError):
            handoff.dispatch(work, self.event)
        send.assert_not_called()

    def test_unrecognised_receipt_never_records_delivery(self):
        for response in [{}, {"claude_code_session_url": None},
                         {"claude_code_session_url": "https://outside.example/session_test"}]:
            with self.subTest(response=response), patch.object(handoff, "prepare", return_value={"work": {}}), \
                 patch.dict(os.environ, {"ROUTINE_ID": "trig_test", "ROUTINE_TOKEN": "synthetic"}), \
                 patch.object(handoff.urllib.request, "urlopen", return_value=io.BytesIO(json.dumps(response).encode())), \
                 patch.object(handoff, "Path") as path, self.assertRaises(ValueError):
                handoff.dispatch({}, self.event)
            path.assert_not_called()
