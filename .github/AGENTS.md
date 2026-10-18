# CI and releases

Paths below are relative to `.github/`. Current policy lives in
`maintenance/review.py` and `workflows/maintenance-review.yml`.

## Review routing

- Ordinary owner-authored agent PRs need `agent:ready`; Dependabot PRs do not.
- Protected changes (including instructions, tooling and workflows) use the
  supervisor-authorised route: a verified connector comment names the full
  head/base commits and reason, then independent review and guarded merge run.
- Manual review dispatches `maintenance-review.yml` from trusted `main` with
  `pr_number`, full `expected_head` and, where authorised, `authorise_policy`.
  This lane reviews only; it never auto-merges.
- Changed head/base commits or CI attempts invalidate review evidence. Resolve
  the guard's actual rejection rather than fabricating markers or bypassing it.
- Release PRs contain metadata only and need supervisor approval of the proposed
  version/head plus `release:ready`. Put implementation/docs fixes in separate PRs.

## Workflow pitfalls

- Privileged jobs inspect candidate code without executing it. Keep model,
  review, status and merge credentials in separate jobs; narrow App tokens to
  each job's permissions. GitHub posting identity comes from the token.
- `Spinetab Agent / Review` reports progress and the result for the reviewed
  commit. Exclude this App's informational check from CI prerequisites so it
  cannot block its own review. Formal approval and the merge guard remain
  authoritative; every other CI and security check must still pass.
- Required check names are contracts with branch protection and the guards.
  Keep `consumer_checks_required()` aligned between CI and review, including renames.
- Trusted PR CI shares the agent cache; untrusted PRs have no cache credentials.
  Publication verification runs without local or remote task-result caches.
- A dependency on an optional skipped PR job can suppress main deployment.
  Preserve the explicit downstream dispatches after token-based merges.
- `actions/verify-consumers/action.yml` produces the verified archive/receipt;
  `maintenance/publish.py` publishes that archive without rebuilding it or running
  package scripts with publishing credentials. Retain npm OIDC authentication.

For changes here, run `python3 -m unittest discover -s .github/maintenance -p '*_test.py'`
from the repo root. Mock network calls and set event context explicitly so tests
do not inherit the invoking workflow. For hosted-flow validation, observe the
actual trigger and downstream results; saved settings alone are not proof.
`maintenance/cloud-setup.sh` targets hosted Linux, not macOS.
