# Live demonstrations

- Connection savings must reflect observed upstream work and worker identity,
  not matching UI values. Keep group, tab, runtime and epoch identities distinct.
- Mode changes retire old work; stale messages must not affect the next run.
  Preserve partial Transit batches, timestamp ordering and BFCache recovery.
- A retiring network observer may need to remain alive until in-flight work is
  recorded; avoid losing measurements during cleanup.
- Endpoint overrides require both page and endpoint to be loopback. Deterministic
  fixtures live in `apps/website/e2e/helpers/example-server.ts` (repo root).

For behaviour changes, exercise multiple tabs, local fallback, mode switches and
provider failure/recovery in `e2e/examples.spec.ts`.
