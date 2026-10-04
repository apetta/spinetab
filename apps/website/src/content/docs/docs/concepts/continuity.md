---
title: Continuity and recovery
description: Recover missed events with server replay or an application refresh, and understand continuity states.
---

Reconnecting restores the connection. Recovering missed data needs either server
replay or an application refresh. Choose a policy based on what each event contains:

| Feed                                            | Recovery policy                                                            |
| ----------------------------------------------- | -------------------------------------------------------------------------- |
| Every event contains the complete current value | `reconcile: "latest"`: the next event replaces stale state                 |
| Events contain changes to existing state        | A `reconcile` function that reloads a snapshot and merges any newer events |
| The server can replay missed events             | Declare replay in the adapter; also choose a policy for consumer overflow  |

For example, with [React bindings](/docs/frameworks/#react):

```tsx
// Each queue event is a complete snapshot.
const { data, needsReconcile } = useLive(queue, { reconcile: "latest" });

// A change feed needs an application refresh.
useSubscription(changes, applyChange, {
  reconcile: async ({ signal }) => {
    const snapshot = await fetchSnapshot({ signal });
    if (!signal.aborted) mergeSnapshot(snapshot);
  },
});
```

`fetchSnapshot` and `mergeSnapshot` are application functions. The fetch must
reject on failure. Use a server version or watermark to merge the snapshot with
live changes that arrive while it loads.

TanStack Query, SWR, Apollo and tRPC also accept `reconcile` in their
[integration options](/docs/getting-started/#connect-your-existing-api).

Without a framework, attach the policy to a subscription. Call `stop()` when
your view is removed:

```ts
import { reconcileOnLoss } from "spinetab";

const subscription = spinetab.subscribe(changes, applyChange);
const stopRecovery = reconcileOnLoss(subscription, async ({ signal }) => {
  const snapshot = await fetchSnapshot({ signal });
  if (!signal.aborted) mergeSnapshot(snapshot);
});

function stop() {
  stopRecovery();
  subscription.unsubscribe();
}
```

## Default behaviour

Without a policy, `gap` or `unknown` continuity remains visible until your code
marks the data reconciled. Value bindings expose `continuity-lost` through
`error`. Apollo and tRPC end an operation on a known gap without a policy; see
their guides for details.

After overflow, delivery stops for the affected consumer. If no policy or status
handler handles it, Spinetab reports the stopped delivery through `reportError`.
Spinetab does not keep an application cache or choose a refresh endpoint for you.

## How the engine works

`reconcileOnLoss(subscription, refresh, options?)` returns `stop()`. On each loss
notice it:

1. restarts stopped delivery first, with `markReconciled({ pending: true })`, so
   live events can arrive while your refresh runs;
2. runs `refresh({ continuity, status, signal })` only while the connection is
   `connected`; a notice that arrives while disconnected waits for `connected`;
3. marks the subscription reconciled only if no newer notice arrived meanwhile;
   otherwise it runs the refresh once more;
4. on a failed refresh, leaves continuity lost, reports the error through
   `options.onError` (else the client's `onCallbackError`, else `reportError`),
   and tries again on the next notice or the next `connected`, never on a timer.

The signal is aborted if a newer loss supersedes the run, the connection drops,
or the subscription/engine is disposed. Check `signal.aborted` before writing
application state, and pass it to your fetch when supported. Application writes
remain your responsibility. Live events may arrive during the refresh: merge
them against the snapshot using a version or watermark supplied by your server.

An oversized or unserialisable event cannot be repaired by restarting delivery.
The automatic policies leave that failure visible until the payload is corrected.

Your refresh must resolve only after fresh data has been applied, and reject on
failure. Cache invalidation alone may resolve without fetching anything or may
hide a fetch error. The integration guides show how to confirm a refresh for
each library. An asynchronous refresh returns `Promise<void>`; use a block body
and await the work rather than returning fetched data.

It keeps no cross-tab state: each tab on a shared connection refreshes its own
data. `"latest"` uses `reconcileLatest` instead: on a loss it restarts delivery,
and the next delivered event marks the subscription reconciled. Never use it on a
feed of changes; it would present dropped changes as complete.

`needsReconcile` from `summariseStatus` stays `true` until the engine declares the
subscription reconciled.

## Two notices per interruption

Continuity changes when an interruption is detected, not when the connection
returns. A detected interruption produces two notices per subscription:

1. **When the loss is detected**, before the `reconnecting` status: `unknown`
   (`reconnected`), or `gap` where the adapter knows events were lost.
2. **When delivery is restored**, just before `connected`: the outcome. Without
   replay it is `unknown` again, with a new `since`; with replay it is `resumed`.

A reload made during the outage cannot contain events sent before the
subscription was restored, so the second notice asks for another reconcile. The
engine handles both. A worker replacement works the same way with
`runtime-replaced`. A deliberate restart, such as
`spinetab.setCredentialRevision(revision, { restart: true })`, reports its outcome
once.

## States

| State        | Meaning                                                                                                   |
| ------------ | --------------------------------------------------------------------------------------------------------- |
| `continuous` | No known loss since the subscription started or was last reconciled.                                      |
| `gap`        | Events were missed. `missed` counts the events dropped for this consumer.                                 |
| `unknown`    | Events may have been missed, for example after a reconnect without replay.                                |
| `resumed`    | The adapter reported recovery or resumed under your declared replay contract. Duplicates may be possible. |

A `gap` is sticky: later reconnects do not clear it. Only `markReconciled()`, by
you or by the engine, returns continuity to `continuous`.

| Reason                   | State        | When                                                                                       |
| ------------------------ | ------------ | ------------------------------------------------------------------------------------------ |
| `runtime-replaced`       | `unknown`    | The worker crashed, closed the port, stopped answering or was replaced.                    |
| `lease-expired`          | `unknown`    | The page was detached, or its attachment lease expired.                                    |
| `reconnected`            | `unknown`    | The upstream reconnected and the subscription restarted without replay.                    |
| `reopened`               | `unknown`    | A repeatable subscription was reopened when the page returned.                             |
| `scope-changed`          | `unknown`    | The client changed auth scope and re-registered the subscription.                          |
| `resumed-with-cursor`    | `resumed`    | An SSE stream with declared replay, or a declared tRPC procedure, resumed from its cursor. |
| `recovered`              | `resumed`    | Socket.IO recovered the connection state.                                                  |
| `reconciled`             | `continuous` | `markReconciled()` was called.                                                             |
| `overflow`               | `gap`        | The consumer fell behind its bounded delivery window.                                      |
| `message-too-large`      | `gap`        | One event exceeded `maxMessageBytes`. Events are never truncated.                          |
| `event-not-serialisable` | `gap`        | An event could not be structured-cloned to the page.                                       |
| `decode-error`           | `gap`        | A frame or event failed to decode in the worker.                                           |
| `replay-reset`           | `gap`        | An SSE stream's declared `resetEvent` arrived: the server could not replay.                |

`resumed` means the protocol reported recovery, or a cursor was sent under your
declared SSE or tRPC replay contract. Spinetab trusts that declaration; it cannot
verify that your server actually replays every missed event. Without recovery or
a declared replay contract, reconnection is `unknown`.

## Reconcile manually

Call `markReconciled` yourself when your recovery does not fit a refresh
function. Restart delivery before you reload, or events sent during the reload
are lost:

```ts
subscription.markReconciled({ pending: true }); // Restart delivery; still lost.
await reloadSnapshot();
subscription.markReconciled(); // Now continuous.
```

Events that arrive while the snapshot loads may already be in it. Order them
against the snapshot, for example with a version number the server puts in both.
If a newer notice arrives during the reload, reload again.

For a full-state feed without a framework, report each event to
`reconcileLatest`:

```ts
import { reconcileLatest } from "spinetab";

const subscription = spinetab.subscribe(queue, (value) => {
  render(value);
  latest.onEvent();
});
const latest = reconcileLatest(subscription);

function stop() {
  latest.stop();
  subscription.unsubscribe();
}
```

## Slow consumers

Delivery to each tab is bounded by message count and estimated bytes. When a
consumer falls behind, Spinetab stops delivering to that consumer only and reports
`gap/overflow` with its missed count. Other consumers, including other
subscriptions in the same tab, continue. Delivery restarts from the next event
after `markReconciled()`, with or without `pending`.
[Defaults and diagnostics](/docs/concepts/defaults/) lists the bounds.

## What recovery restarts

- **Repeatable subscriptions** are restarted after a reconnect and re-registered
  once after a worker replacement. Reads, GraphQL subscriptions and SSE GET streams
  are repeatable by default.
- **Non-repeatable requests**, such as a fetch stream not declared `repeatable` or
  an AI generation, are never restarted, because that could repeat a side effect.
  An interruption ends them with an `interrupted` error.
- **Commands are never replayed.** A command that never reached the wire settles
  `not-sent` and is safe to retry. One that may have reached the server settles
  `unknown`; do not retry it blindly.
- **Late subscribers** receive future events only. There is no last-value cache.

Spinetab cannot run while the operating system suspends the browser. Recovery
starts once execution resumes: the page heartbeat notices the scheduling gap and
triggers one coalesced health check.
