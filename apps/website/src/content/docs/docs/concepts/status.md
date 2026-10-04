---
title: Status and health
description: Show connection state and incomplete data separately, and decide when to retry.
---

Use `summariseStatus` to show whether a subscription is connected and whether its
data needs recovery. These are separate questions: a live connection can still
have missed events.

```ts
import { summariseStatus } from "spinetab";

subscription.status.subscribe((status) => {
  const { phase, needsReconcile } = summariseStatus(status);
  banner.textContent = needsReconcile
    ? `${phase}, events may be missing`
    : phase;
});
```

`phase` describes the connection. `needsReconcile` stays true until a known or
possible delivery gap has been reconciled.

| `phase`        | Meaning                                                           |
| -------------- | ----------------------------------------------------------------- |
| `idle`         | Not started, or on the server                                     |
| `connecting`   | Opening the upstream connection                                   |
| `live`         | Connected upstream                                                |
| `reconnecting` | The upstream dropped; retrying                                    |
| `reattaching`  | The page lost its worker and is reattaching; not a server failure |
| `blocked`      | Stopped on credentials or exhausted retries; needs action         |
| `ended`        | Failed, disposed or unsubscribed                                  |

`needsReconcile` is `true` while continuity is `gap` or `unknown`, including while
a reconcile is running. The value hooks return it directly; see
[Using subscriptions](/docs/frameworks/).

## Default behaviour

Status is per subscription: a failed endpoint does not make unrelated feeds look
offline. Handle terminal errors with the observer's `error` callback, and inspect
`status` for blocked credentials, exhausted retries and continuity loss.

Unhandled terminal errors and stopped delivery are reported through the client's
`onCallbackError`, or the browser's `reportError`. Missing plugin configuration is
always reported once per client. Spinetab's own reports use fixed messages and
codes, without upstream response text or credentials.

## The three raw signals

| Signal                  | Where                 | Answers                                            |
| ----------------------- | --------------------- | -------------------------------------------------- |
| Mode and runtime health | `spinetab.status`     | Can this page reach its worker or local runtime?   |
| Connection              | `subscription.status` | Is this subscription's upstream connection usable? |
| Continuity              | `subscription.status` | Has this consumer received everything it needed?   |

Both `status` properties are stores with `get()` and `subscribe(listener)`. Their
snapshots are referentially stable, so they work with `useSyncExternalStore` and
other change detection. Pass a `status` callback in an observer object to receive
the same values.

### Client status

```ts
const { mode, reason, health, runtimeId, generation, error } =
  spinetab.status.get();
```

`mode` and `reason` are described in [Execution modes](/docs/concepts/modes/).
`generation` counts attachments. `runtimeId` changes when a worker is replaced.

| Health        | Meaning                                                                        |
| ------------- | ------------------------------------------------------------------------------ |
| `unknown`     | Not attached yet, on the server, disposed, or detached on `pagehide`/`freeze`. |
| `checking`    | A health check has taken longer than one task.                                 |
| `healthy`     | The runtime answered the handshake or the latest check.                        |
| `reattaching` | The attachment was lost or the page is returning; the client is reattaching.   |
| `unreachable` | The client is in `failed` mode.                                                |

Spinetab checks health when a page returns from the back/forward cache, becomes
visible, goes `online` or `resume`s, and when its heartbeat notices a long
scheduling gap. `spinetab.checkHealth()` runs one coalesced check on demand. It
resolves with the status as `spinetab.status` reads once the check settles. After
`pagehide` or `freeze` it does not reattach the page: until the page is shown again
it resolves with the current status (health `unknown` once detached; `reattaching`
if the runtime was already lost), and the return reattaches a detached page.

### Connection states

| State             | Meaning                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------ |
| `inactive`        | Not started, or on the server.                                                             |
| `connecting`      | The first connection attempt is in progress.                                               |
| `connected`       | Usable under the adapter's liveness rules.                                                 |
| `reconnecting`    | Retrying after a transient failure. `attempt` and `retryAt` describe the next try.         |
| `auth-blocked`    | No usable credentials, so nothing is sent. See [Credentials](/docs/concepts/credentials/). |
| `retry-exhausted` | The retry budget ran out. Intent is kept; `subscription.retry()` starts a fresh series.    |
| `failed`          | A permanent failure, such as a fatal protocol close or an oversized frame.                 |
| `disposed`        | The subscription or client was disposed.                                                   |

### Connection reasons

| Reason                              | Meaning                                                                              |
| ----------------------------------- | ------------------------------------------------------------------------------------ |
| `network`, `server-closed`          | The connection dropped or the server closed it.                                      |
| `heartbeat-timeout`                 | A declared heartbeat or pong did not arrive in time.                                 |
| `suspension-gap`                    | Execution paused for longer than the scheduling-gap threshold.                       |
| `credentials-missing`               | No tab supplied credentials in time, or its `credentials` callback failed.           |
| `credentials-rejected`              | The server rejected this credential revision.                                        |
| `no-credential-source`              | The client declared neither `credentials` nor `anonymous`.                           |
| `credentials-audience`              | The URL is outside the worker's credential audience, or not `https:`. Permanent.     |
| `attempts-exhausted`, `time-limit`  | The retry budget ran out by attempts or by executable time.                          |
| `permanent-error`, `protocol-error` | A failure retrying cannot fix. `code` says which, such as `forbidden` or `redirect`. |
| `runtime-replaced`                  | The worker serving the connection was replaced.                                      |
| `idle`                              | The connection closed because no subscription used it.                               |

`code` carries a fixed code where there is one, such as `http:401`, `close:4401`
or `forbidden`; never upstream text. `lastSuccessAt` records the last successful
connect or read while the connection is stale. Polling adds `skippedIntervals`.

Continuity has its own page: [Continuity and recovery](/docs/concepts/continuity/).

## Retrying

- `subscription.retry()` asks for a fresh attempt on that subscription's
  connection when it is `retry-exhausted`, `failed` or `auth-blocked`. The binding
  and integration `retry` controls call it.
- `spinetab.retry()` does the same for every connection of this page. In `failed`
  mode it makes one new attach attempt instead.

Spinetab never spins on rejected credentials: a rejected revision is never reused,
so after `credentials-rejected` supply a newer one with
`spinetab.setCredentialRevision()`. A `credentials-audience` block needs the
origin in `credentialOrigins`, in the plugin options or your worker file.
