# Application integrations

- A fulfilled cache promise need not mean fresh data. Preserve the success checks
  for TanStack cancellation/invalidation, SWR mutation and Apollo refetch before
  clearing continuity loss. Fence stale completions by identity and disposal.
- With reconciliation configured, recoverable Apollo/tRPC gaps must keep the
  operation usable and deliver newer events after refresh, without a component
  restart effect. Invalid payloads and terminal operation errors remain terminal.
- Application callbacks may reconcile, dispose or throw synchronously. Complete
  internal notification/cleanup despite re-entry; deferred callbacks must recheck
  the current scope and operation before acting.
- AI start/stop are commands, not deduplicated subscriptions. An observer leaving
  does not stop generation. Fan out chunks without retaining history for late joins.
- AI sharing requires backend generation-ID evidence. Resumption replays an
  existing generation with an initial `start` chunk; never start a replacement
  generation to simulate replay. After a recoverable gap, observation must still
  discover later generations even though the interrupted stream stays interrupted.
- tRPC page/runtime transformer settings must agree; transformer functions stay
  in the runtime rather than crossing the structured-clone bridge.

Cache behaviour is covered in `tests/dom/`; AI regressions in
`tests/unit/integrations/`, with real-protocol/browser suites alongside them
(package-relative paths).
