---
title: Defaults and diagnostics
description: Default settings, runtime limits, retry timings and optional diagnostics.
---

Defaults work without configuration. Use the source guides for transport options;
this page collects client settings, queue limits and diagnostics.

| Setting                   | Default                                    | Option                                 |
| ------------------------- | ------------------------------------------ | -------------------------------------- |
| Sharing                   | `prefer`                                   | `sharing: "require"` or `"off"`        |
| Polling interval          | 5 000 ms                                   | `pollEvery(ms)`                        |
| Polling in hidden tabs    | Hidden consumers are ineligible by default | `pollEvery(ms, { whileHidden: true })` |
| SSE mode                  | `fetch`                                    | `mode: "eventsource"`                  |
| SSE payload               | JSON, delivered as the value               | `decoder: "text"`                      |
| SSE replay                | None                                       | `replay: "last-event-id"`              |
| Stream parser             | NDJSON                                     | `parser: "lines"` or a custom name     |
| Stream restarts           | Not repeatable                             | `repeatable: true`                     |
| Raw WebSocket payload     | `string \| ArrayBuffer`                    | `decoder: "json"` or a protocol        |
| graphql-sse mode          | `distinct`                                 | `mode: "single"`                       |
| graphql-ws keep-alive     | 15 000 ms                                  | `keepAliveMs`                          |
| Socket.IO sharing         | None; required                             | `sharing: "shared"` or `"per-tab"`     |
| Protocol credentials      | Must be declared                           | `credentials` or `anonymous: true`     |
| Credential audience       | The worker's own origin                    | `credentialOrigins` (plugin or worker) |
| HTTP provider headers     | Own origin only, when a callback exists    | `authHeaders: true` or `false`         |
| Reconciliation            | None; loss is reported through continuity  | `reconcile`                            |
| Unhandled terminal errors | Reported once                              | An `error` callback, `onCallbackError` |

`pollEvery` is exported from `spinetab/polling`, beside `polling`.

## Bundler plugin

With no options, the plugin applies these:

| Setting                 | Default                                                          | Option                                       |
| ----------------------- | ---------------------------------------------------------------- | -------------------------------------------- |
| Worker                  | Generated from your `spinetab/<source>` imports                  | `spinetab.worker.ts`, or the `worker` option |
| Adapters                | Inferred from imports in application and linked workspace source | `adapters`, for an exact set                 |
| Builds                  | Client builds only                                               | None                                         |
| Development worker name | `spinetab-<hash>`                                                | None                                         |
| No source imports found | A warning in development; `no-adapters` fails a production build | `adapters: []`                               |

`adapters` replaces inference rather than adding to it:

```ts title="vite.config.ts"
import { spinetab } from "spinetab/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [spinetab({ adapters: ["polling", "sse"] })],
});
```

The other bundlers take the same options; see
[Bundler configuration](/docs/bundlers/) and [Custom worker](/docs/your-worker/).

## Runtime limits

Set limits in your own worker file, `spinetab.worker.ts`; the plugin finds it and
stops generating one. `DEFAULT_LIMITS` is exported from `spinetab/runtime`.

```ts title="spinetab.worker.ts"
import { pollingAdapter } from "spinetab/polling/runtime";
import { defineWorker } from "spinetab/worker";

export default defineWorker(() => [pollingAdapter()], {
  limits: { maxConnections: 16 },
});
```

These defaults bound queues, connections and idle time. Override only the limits
your application needs to change.

| Limit                           | Default          | When exceeded                                                          |
| ------------------------------- | ---------------- | ---------------------------------------------------------------------- |
| `maxPendingMessages`            | 256 per tab      | Consumers whose next event no longer fits get `gap/overflow`           |
| `maxPendingBytes`               | 1 MiB per tab    | As above                                                               |
| `maxPendingMessagesPerConsumer` | 64               | That consumer gets `gap/overflow`; others continue                     |
| `maxPendingBytesPerConsumer`    | 256 KiB          | As above                                                               |
| `maxMessageBytes`               | 256 KiB          | Consumers of that event get `gap/message-too-large`; never truncated   |
| `maxControlMessages`            | 64 per tab       | Later status messages wait in a bounded queue                          |
| `maxFrameBytes`                 | 256 KiB          | `frame-too-large`; the response is aborted and the connection `failed` |
| `maxPendingCommands`            | 64               | The new command settles `not-sent` with `limit-exceeded`               |
| `commandTimeoutMs`              | 30 000 ms        | The command settles `unknown`                                          |
| `credentialTimeoutMs`           | 5 000 ms per tab | `auth-blocked/credentials-missing` after at most three tabs            |
| `maxConsumersPerAttachment`     | 1 000            | `limit-exceeded` on the new subscription                               |
| `maxSubscriptions`              | 1 000            | As above                                                               |
| `maxConnections`                | 32               | As above                                                               |
| `leaseMs`                       | 180 000 ms       | The silent tab is released; it reattaches with continuity `unknown`    |
| `idleCloseMs`                   | 5 000 ms         | An unused connection closes (maximum 60 000 ms)                        |
| `lingerMs`                      | 0 ms             | The upstream subscription stops one macrotask after its last consumer  |

Limits must be positive integers, except `lingerMs`, which also accepts zero.
Per-consumer limits cannot exceed the per-tab
totals, and `maxMessageBytes` cannot exceed `maxPendingBytesPerConsumer`;
otherwise the runtime throws `unsupported-option`. A page's `limits` option can
only tighten the runtime's delivery limits. Every timeout here and under Timings is
capped at 2 147 483 647 ms (about 24.8 days), the longest delay a browser timer
honours; a larger value fails with `unsupported-option`.

Bytes are estimated structured-clone sizes, not heap measurements. Strings count
their UTF-8 length, and a typed-array view counts its whole backing buffer, because
structured cloning copies it.

## Timings

| Timing                                   | Default                                                               |
| ---------------------------------------- | --------------------------------------------------------------------- |
| Handshake timeout (`handshakeTimeoutMs`) | 5 000 ms, then `startup-timeout`                                      |
| Health probe timeout (`probeTimeoutMs`)  | 5 000 ms, then health `reattaching`                                   |
| Page heartbeat (`heartbeatMs`)           | 20 000 ms                                                             |
| Worker setup (`setupTimeoutMs`)          | 10 s, with up to 64 early tabs buffered (`maxEarlyPorts`)             |
| Native transport retries                 | From 1 s, doubling to 30 s with full jitter; 10 attempts or 5 minutes |
| WebSocket acknowledgement                | 10 000 ms, then `unknown`                                             |
| Polling                                  | Interval 5 000 ms, minimum 1 000 ms; read timeout 30 000 ms           |

The handshake, probe and heartbeat timings are client options. `setupTimeoutMs`
and `maxEarlyPorts` are `defineWorker` options, set in your worker file. Native
retry budgets reset after 10 s of healthy connection.

## Diagnostics

Diagnostics are off by default. Pass a sink to opt in:

```ts
import { createSpinetab } from "spinetab";

export const spinetab = createSpinetab({
  diagnostics: (event) => console.debug(event.realm, event.type, event.detail),
});
```

Each event has a `type`, a timestamp `at`, a `realm` (`page` or `runtime`) and an
optional `detail`. Events never contain payloads, credentials or upstream text. An
adapter's diagnostics reach only tabs in its connection's scope. A runtime created
with its own `diagnostics` sink also keeps its last 100 events, which
`runtime.stats()` returns with counters and peak queue sizes. When neither the runtime nor any attached page enables diagnostics, the runtime
builds no diagnostic events.

Exceptions thrown by your callbacks, and the reports described in
[Status and health](/docs/concepts/status/#default-behaviour), go to
`onCallbackError`, which defaults to `reportError`.
