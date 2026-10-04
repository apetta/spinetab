---
title: Execution modes
description: Shared and local execution, the sharing policy and the reasons Spinetab reports for fallback.
---

Spinetab runs subscriptions in a SharedWorker when possible. If a worker cannot
start, the default `sharing: "prefer"` policy runs the adapters locally in each
tab. The subscription API is the same; cross-tab sharing is unavailable.

```ts
spinetab.status.subscribe(({ mode, reason }) => {
  console.log(mode, reason);
});
```

The plugin provides both runtimes. For manual wiring, provide a `local` factory
to enable fallback.

## Default behaviour

- **Startup fallback.** Under the default policy, a worker that
  cannot start sends the page to local mode once, with the reason in
  `spinetab.status`.
- **Stable local mode.** `local` never becomes `shared` automatically.
- **Connection failures.** Authentication, protocol, upstream, overflow
  and serialisation failures never change the mode.

## Choose a sharing policy

Fail instead of running a connection per tab:

```ts
import { createSpinetab } from "spinetab";

const strict = createSpinetab({ sharing: "require" });
```

| Policy             | Behaviour                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------- |
| `prefer` (default) | Try shared mode. On a startup failure, fall back to local once; without `local`, fail.      |
| `require`          | Shared mode, or `failed` with a `sharing-unavailable` error. Never loads the local runtime. |
| `off`              | Local mode, without calling the worker factory.                                             |

In `failed` mode every active subscription ends with the mode's error. Call
`spinetab.retry()` for one new attach attempt, then subscribe again.

## Modes

| Mode       | Meaning                                                   |
| ---------- | --------------------------------------------------------- |
| `inactive` | Not started, or running on the server.                    |
| `starting` | Attaching to the worker or loading the local runtime.     |
| `shared`   | Attached to the SharedWorker after a versioned handshake. |
| `local`    | Running the adapters in this tab.                         |
| `failed`   | Nothing runs. `reason` and `error` say why.               |
| `disposed` | `dispose()` was called. Terminal.                         |

On the server, `createSpinetab` is inert and the status is the constant
`{ mode: "inactive", reason: "server", health: "unknown", generation: 0 }`,
exported as `SERVER_STATUS`.

## Reasons

`reason` explains `inactive`, `local` and `failed`:

| Reason                      | When                                                                      |
| --------------------------- | ------------------------------------------------------------------------- |
| `server`                    | Created during server-side rendering; the client stays inert.             |
| `not-configured`            | No bundler plugin, and no `worker` or `local`. See below.                 |
| `sharing-off`               | `sharing: "off"`.                                                         |
| `unsupported`               | The browser has no SharedWorker, or no worker factory was given.          |
| `worker-construct-failed`   | The worker factory threw.                                                 |
| `worker-error`              | The worker fired an error or closed its port before the handshake.        |
| `worker-startup-error`      | Worker setup failed, took over 10 s, or the worker served Spinetab twice. |
| `startup-timeout`           | No handshake reply within 5 s.                                            |
| `incompatible-version`      | The worker speaks a different bridge version.                             |
| `handshake-invalid`         | The worker's handshake reply was malformed.                               |
| `local-runtime-unavailable` | Local mode was needed but no `local` factory was configured.              |
| `local-runtime-load-failed` | The local runtime module failed to load. It is not retried in a loop.     |
| `runtime-unstable`          | The worker was lost too often; see [Reattachment](#reattachment).         |

The seven startup reasons from `unsupported` to `handshake-invalid` trigger the
fallback under `prefer`. Under `require`, the same reason is reported with a
`sharing-unavailable` error.

## Not configured

A browser client with no plugin wiring, and neither `worker` nor `local`, fails on
its first start with reason and error code `not-configured`, under every sharing
policy. It is reported once per client, even when you watch status:

```text
not-configured: add the spinetab plugin to your bundler config, or pass worker and local to createSpinetab.
```

Add the plugin line from [Bundler configuration](/docs/bundlers/), or
[wire it by hand](/docs/bundlers/#wire-it-by-hand). `retry()` cannot fix it.
A client with `local` but no `worker` is different: under the default policy it
runs in local mode with reason `unsupported`.

## Reattachment

If a shared attachment is lost, for example because the worker crashed or the
browser replaced it, the page reattaches through the same worker factory and
re-registers its subscriptions once. Retries use jittered backoff from 500 ms,
doubling to 10 s, with a budget of 5 attempts per 5 minutes of executable time.
When the budget runs out, `prefer` moves to local mode once, and `require` ends in
`failed` with reason `runtime-unstable`.

Before a replacement attachment becomes active, the old one is retired: its
unposted commands settle `not-sent`, posted commands settle `unknown`, and stale
messages from it are dropped.
