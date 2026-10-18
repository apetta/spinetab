import re
import unittest
from pathlib import Path


class WorkflowTests(unittest.TestCase):
    def test_review_model_never_receives_app_writing_credentials(self):
        source = (Path(__file__).resolve().parents[1] / "workflows/maintenance-review.yml").read_text()
        sections = re.split(r"^  ([\w-]+):\n", source.split("\njobs:\n", 1)[1], flags=re.M)
        jobs = dict(zip(sections[1::2], sections[2::2]))
        for name, body in jobs.items():
            if "CLAUDE_CODE_OAUTH_TOKEN" in body:
                with self.subTest(job=name):
                    for credential in ("REVIEW_APP_PRIVATE_KEY", "REVIEW_TOKEN", "CHECK_TOKEN"):
                        self.assertNotIn(credential, body)
        self.assertIn("artifact-ids: ${{ needs.prepare.outputs.artifact_id }}", jobs["analyse"])
        self.assertIn("if: always() && needs.prepare.outputs.check_id != ''", jobs["status"])
        for name in ("prepare", "status"):
            self.assertIn("permission-checks: write", jobs[name])
            self.assertNotIn("permission-contents: write", jobs[name])
            self.assertNotIn("permission-pull-requests: write", jobs[name])

    def test_deployment_does_not_inherit_the_optional_pr_lane(self):
        source = (Path(__file__).resolve().parents[1] / "workflows/ci.yml").read_text()
        jobs = source.split("\njobs:\n", 1)[1]
        sections = re.split(r"^  ([\w-]+):\n", jobs, flags=re.M)
        dependencies = {}
        for name, body in zip(sections[1::2], sections[2::2]):
            needs = re.search(r"^    needs: (.+)$", body, flags=re.M)
            dependencies[name] = re.findall(r"[\w-]+", needs[1]) if needs else []

        def ancestors(job):
            return {
                parent
                for direct in dependencies[job]
                for parent in ({direct} | ancestors(direct))
            }

        # A skipped optional lane suppresses downstream jobs, even through a
        # successful aggregate status. Production follows the actual main job.
        for job in ("deploy", "verify-deployment", "release"):
            with self.subTest(job=job):
                parents = ancestors(job)
                self.assertIn("check", parents)
                self.assertIn("scope", parents)
                self.assertNotIn("check-pr", parents)


if __name__ == "__main__":
    unittest.main()
