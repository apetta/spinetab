---
title: Polling
description: Share repeatable HTTP reads across tabs with one schedule per request.
---

Use polling for an HTTP endpoint that returns the current value. Tabs making the
same request share a read schedule. This example expects `/api/queue` to return
JSON such as `{ "open": 12 }`.

[Set up the plugin and client](/docs/getting-started/) first. The examples use
`spinetab.subscribe()`; call the returned handle's `unsubscribe()` when your view
is removed. [UI bindings](/docs/frameworks/) handle that cleanup for components.

```ts
import { polling } from "spinetab/polling";
import { spinetab } from "./live";

type Queue = { open: number };

const queue = polling<Queue>("/api/queue");

const subscription = spinetab.subscribe(queue, (value) =>
  console.log(value.open),
);
```

The worker runs one read schedule for every tab that polls the same request.
The plugin registers the adapter for you. Choosing polling declares that the
request may be re-issued on a schedule, whatever its method.

## Default behaviour

| Setting     | Default                                                     |
| ----------- | ----------------------------------------------------------- |
| Interval    | 5 s                                                         |
| Hidden tabs | Paused                                                      |
| Overlap     | Never; one read in flight                                   |
| On return   | One catch-up read                                           |
| Request     | `GET`, JSON response, 30 s timeout                          |
| Failures    | 408, 429, 5xx and network errors retried                    |
| Credentials | Cookies per fetch; provider headers only on your own origin |

Every result is a whole read, so continuity stays `continuous` across a pause. The
connection status reports `skippedIntervals` and `lastSuccessAt` instead.

## Configure polling

Poll this consumer at another rate with `pollEvery`, also from `spinetab/polling`:

```ts
import { pollEvery } from "spinetab/polling";

spinetab.subscribe(queue, show, pollEvery(30_000));
```

Keep polling while the tab is hidden:

```ts
spinetab.subscribe(queue, show, pollEvery(30_000, { whileHidden: true }));
```

Change the rate later, without resubscribing:

```ts
subscription.update({ intervalMs: 10_000 });
```

Send a method, body or headers; they are part of the request's identity:

```ts
const team = polling<Queue>("/api/team-queue", {
  method: "POST",
  body: { team: 7 },
});
```

Header names must be HTTP tokens, and header values characters up to U+00FF,
without NUL, CR or LF; anything else is refused when the feed is defined.

Handle errors and status next to the results:

```ts
spinetab.subscribe(queue, {
  next: show,
  error: (error) => warn(error.code),
  status: (status) => log(status.connection.state),
});
```

Send the credentials provider's headers to another origin, listed in
`credentialOrigins` in the plugin options or your worker file (see
[Credentials](/docs/concepts/credentials/)):

```ts
const remote = polling<Queue>("https://api.example.com/queue", {
  authHeaders: true,
});
```

## Options

| Option        | Default       | Meaning                                                                          |
| ------------- | ------------- | -------------------------------------------------------------------------------- |
| `method`      | `GET`         | `GET`, `POST`, `PUT`, `PATCH` or `DELETE`                                        |
| `headers`     | None          | Non-credential, response-affecting headers                                       |
| `body`        | None          | A string or JSON body                                                            |
| `credentials` | Fetch default | The fetch cookie mode                                                            |
| `authHeaders` | Auto          | Auto: provider headers on your own origin only. `true`: required. `false`: never |
| `decoder`     | `"json"`      | `"json"`, `"text"` or a decoder registered in the worker                         |
| `timeoutMs`   | 30 000        | Per-read timeout                                                                 |

Every option is part of the identity. Per-consumer options, passed with
`pollEvery(intervalMs, options)`, are not:

| Consumer option | Default  | Meaning                                                                    |
| --------------- | -------- | -------------------------------------------------------------------------- |
| `intervalMs`    | 5 000    | An integer from 1 000 ms to 24 hours                                       |
| `eligible`      | `true`   | An application gate on whether this consumer wants results                 |
| `whileHidden`   | `false`  | Keep polling while the page is hidden, subject to browser timer throttling |
| `onJoin`        | `"read"` | `"read"` requests one coalesced fresh read on join; `"await"` waits        |

## How the schedule works

- One fixed-delay schedule per identity, at the shortest interval among eligible
  consumers. Reads never overlap.
- Each result goes to every consumer that is eligible when the read completes.
  Results are not cached for later subscribers.
- A consumer is eligible while its page is visible, unless it sets `whileHidden`,
  and while its own `eligible` gate is open.
- With no eligible consumers the schedule pauses. The last consumer leaving aborts
  the read in flight.

## Failures

| Response                                    | Outcome                                                                                     |
| ------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 401                                         | `auth-blocked/credentials-rejected`, code `http:401`; the attached revision is never reused |
| 403                                         | `failed/permanent-error`, code `forbidden`; nothing is rejected                             |
| Redirect with provider headers              | Not followed: `failed/permanent-error`, code `redirect`                                     |
| 408, 429, 5xx, network                      | Retried with backoff; `Retry-After` is honoured                                             |
| 204                                         | No new result: stays `connected`, delivers nothing                                          |
| Empty 2xx body                              | JSON decoder: no new result. `text` and custom decoders receive the empty body              |
| Read timeout                                | Retried with backoff: `reconnecting/network`, code `timeout`                                |
| Provider fails after the read timeout fired | `auth-blocked` when the credential wait ends; no request                                    |
| Other non-success status                    | `failed/permanent-error`                                                                    |
| Body over `maxMessageBytes`                 | `gap/message-too-large` and `failed`, without a retry; never truncated                      |

## Custom decoders

A custom decoder receives the whole body, already size-checked, and returns a
cloneable value. Register it in a [custom worker](/docs/your-worker/):

```ts title="spinetab.worker.ts"
import { pollingAdapter } from "spinetab/polling/runtime";
import { defineWorker } from "spinetab/worker";

export default defineWorker(() => [
  pollingAdapter({
    decoders: { lines: (body) => new TextDecoder().decode(body).split("\n") },
  }),
]);
```

Select it with `polling(url, { decoder: "lines" })`. `polling({ url, ...options })`
is the same request as `polling(url, options)`.
