# Core

[README.md](README.md) describes the architecture and ownership boundaries.

- Sharing identity includes adapter, scope, credential mode and canonical spec.
  Keep anonymous/provider-backed work distinct and non-shareable work unique.
- Preserve origin-bound credential grants, rejected-revision fencing and cleanup
  of retired scopes; late credential replies must not revive them.
- Connection status and continuity are separate. Loss stays visible until actual
  reconciliation, including both interruption and reconnect-outcome notifications.
- `reconcileOnLoss` runs while connected, coalesces work and aborts stale refreshes.
  Failed or oversized results must not silently count as reconciled.
- Snapshot queued payloads at enqueue. Keep queued and posted delivery debt
  distinct: unsubscribe/reconciliation cannot free capacity for messages still
  awaiting acknowledgement. Retire that debt on ACK or attachment retirement.
- A same-turn subscription burst can outrun ACKs without being a stalled consumer.
  Preserve bounded queuing and control/data ordering rather than raising limits.
- A size estimate does not prove cloneability. Uncloneable error details still
  need a bounded terminal error in the same sequence position, not silent removal.
- Construct diagnostic events only for opted-in receivers; retain history only
  with a runtime sink. Safety counters and error signalling remain active.
- If an acknowledged command result cannot reach the page, preserve the `unknown`
  outcome. SSR status snapshots must stay stable.

Use `tests/unit/core/` for deterministic lifecycle/credential regressions and
`tests/integration/core/` plus browser `core-*.spec.ts` for real sharing/recovery
(package-relative paths). Fake environments cannot prove worker lifecycle behaviour.
