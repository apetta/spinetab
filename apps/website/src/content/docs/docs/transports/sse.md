---
title: Server-sent events
description: Share one server-sent event stream across tabs, JSON by default, with named events, event IDs and declared replay.
sidebar:
  label: SSE
---

Use SSE when your server sends a `text/event-stream` response. This example
expects each event's `data` to contain JSON such as `{ "n": 1 }`. Matching feeds
share the upstream stream.

[Set up the plugin and client](/docs/getting-started/) first. The examples use
`spinetab.subscribe()`; call the returned handle's `unsubscribe()` when your view
is removed. [UI bindings](/docs/frameworks/) handle that cleanup for components.

```ts
import { sse } from "spinetab/sse";
import { spinetab } from "./live";

type Tick = { n: number };

const ticks = sse<Tick>("/api/ticks");
const subscription = spinetab.subscribe(ticks, (tick) => console.log(tick.n));
```

Each event's data arrives as a parsed value. The plugin registers the adapter
for you.

## Default behaviour

| Setting     | Default                                                       |
| ----------- | ------------------------------------------------------------- |
| Payload     | Each event's data parsed as JSON                              |
| Event       | `message`                                                     |
| Mode        | `fetch`                                                       |
| Cursor      | Last received event ID sent on reconnect when available       |
| Replay      | None declared; a reconnect reports `unknown`                  |
| Restarts    | GET streams restart after a drop; POST streams end            |
| Retries     | Jittered backoff; the server's `retry:` sets its base         |
| Bad JSON    | A `decode-error` gap for that event                           |
| Credentials | Same-origin cookies; provider headers only on your own origin |

## Events, formats and replay

Select a named event; streams with different selections still share one
connection:

```ts
spinetab.subscribe(ticks.subscription<Tick>({ event: "tick" }), show);
```

Read the event ID and name from the metadata:

```ts
spinetab.subscribe(ticks, (tick, meta) => log(meta.eventId, meta.event, tick));
```

Receive the raw string instead of JSON:

```ts
spinetab.subscribe(sse("/api/log", { decoder: "text" }), (line) => log(line));
```

Handle errors and status next to the events:

```ts
spinetab.subscribe(ticks, {
  next: show,
  error: (error) => warn(error.code),
  status: (status) => log(status.connection.state),
});
```

Declare that the server replays from `Last-Event-ID`, so a reconnect reports
`resumed` instead of `unknown`:

```ts
const orders = sse<Order>("/api/orders", { replay: "last-event-id" });
```

Reload your data after a loss; the engine restarts delivery first and marks the
subscription reconciled when the reload resolves, so it must reject when it fails:

```ts
import { reconcileOnLoss } from "spinetab";

const stopRecovery = reconcileOnLoss(subscription, async ({ signal }) => {
  const snapshot = await fetchTicks({ signal });
  if (!signal.aborted) mergeTicks(snapshot);
});
```

The fetch and merge functions belong to your application. Use a server version
or watermark to merge the snapshot with live updates. Call `stopRecovery()`
alongside `subscription.unsubscribe()` on teardown; see
[recovery](/docs/concepts/continuity/).

Authenticate a GET stream with cookies through the browser's `EventSource`:

```ts
const feed = sse<Tick>("/api/ticks", {
  mode: "eventsource",
  withCredentials: true,
});
```

## Options

| Option            | Default         | Meaning                                                                                      |
| ----------------- | --------------- | -------------------------------------------------------------------------------------------- |
| `mode`            | `"fetch"`       | `fetch` or `eventsource`                                                                     |
| `decoder`         | `"json"`        | `"json"`, `"text"` or a decoder registered in the worker                                     |
| `withCredentials` | `false`         | EventSource only: send cookies cross-origin                                                  |
| `method`, `body`  | `GET`           | Fetch only: `GET` or `POST`                                                                  |
| `headers`         | None            | Fetch only: non-credential request headers                                                   |
| `credentials`     | `"same-origin"` | Fetch only: the fetch cookie mode                                                            |
| `authHeaders`     | Auto            | Fetch only. Auto: provider headers on your own origin only. `true`: required. `false`: never |
| `resume`          | `"header"`      | How a cursor is sent on a new request: `"header"`, `{ query }`, `{ url }` or `false`         |
| `replay`          | `"none"`        | `"last-event-id"` declares that the server replays from the cursor                           |
| `events`          | Any             | Allow-list of event types subscriptions may select                                           |
| `heartbeat`       | None            | A heartbeat event name and/or `expectInboundWithinMs`                                        |
| `resetEvent`      | None            | An event the server sends when it cannot replay from the cursor                              |
| `repeatable`      | GET: `true`     | Fetch only: whether the stream may restart. POST defaults to `false`                         |

## Modes

| Mode              | Use it for                                                                                            |
| ----------------- | ----------------------------------------------------------------------------------------------------- |
| `fetch` (default) | Headers, header credentials or POST. Spinetab parses the stream and owns the retry loop.              |
| `eventsource`     | GET streams authenticated by cookies. The browser's `EventSource` reconnects; Spinetab supervises it. |

Fetch mode tells a 204, an auth failure and a wrong content type apart.
`EventSource` hides why a stream closed. It reconnects within a bounded number of
attempts, then reports `retry-exhausted`; if the browser closes the stream,
Spinetab recreates it a bounded number of times. A recreated `EventSource` carries
the cursor only through `resume: { query }` or `resume: { url }`.

## Recovery

- Continuity is `resumed` (`resumed-with-cursor`, duplicates possible) only when
  you declare `replay: "last-event-id"` and a non-empty cursor was sent.
  Otherwise a reconnect is `unknown/reconnected`.
- The cursor is sent as its UTF-8 bytes, as `EventSource` does. A cursor that
  starts or ends with a space or tab cannot travel in a header, so that reconnect
  is `unknown/reconnected`.
- In fetch mode a `retry:` value, clamped to 250 ms–60 s, becomes the backoff base
  for that stream: each delay is drawn at random between 0 and a bound that starts
  at the base and doubles per attempt, up to the cap, so the value is not a minimum
  wait. In `EventSource` mode the browser applies `retry:` itself.
- After a worker replacement, the first re-registered cursor reopens the stream.
  Consumers that had a different cursor get `unknown`.
- A declared `heartbeat` detects a stalled stream. `EventSource` does not expose
  SSE comments, so use a named heartbeat event in that mode.
  `expectInboundWithinMs` also bounds pending EventSource connection attempts,
  including reconnects that never open. Without that expectation, Spinetab does
  not impose an establishment timeout.
- In fetch mode, a 401 is `auth-blocked`, code `http:401`. A 403 is `failed`,
  code `forbidden`. A redirect on a request that carries provider headers is not
  followed. Native EventSource does not expose HTTP status codes.

## Restrictions

- EventSource mode cannot send headers or POST, and rejects `repeatable: false`
  and the event names `open` and `error`.
- `resetEvent` must be a non-empty name. It cannot appear in `events`, equal
  `heartbeat.event` or be selected by a subscription. In EventSource mode it also
  cannot be `message`, `open` or `error`.
- Static headers such as `Authorization`, `Cookie` and `Last-Event-ID` are
  refused. Tokens come from the client's `credentials` callback. Header values
  must be characters up to U+00FF, without NUL, CR or LF; anything else is refused
  when the feed is defined.

## Custom decoders and resume URLs

Register decoders and resume URL builders in the worker, and select them by name
with `decoder` or `resume: { url }`. This decoder reads unquoted pipe-separated
fields. Register both functions in a [custom worker](/docs/your-worker/):

```ts title="spinetab.worker.ts"
import { sseAdapter } from "spinetab/sse/runtime";
import { defineWorker } from "spinetab/worker";

export default defineWorker(() => [
  sseAdapter({
    decoders: { fields: (data) => data.split("|") },
    resumeUrls: {
      after: (url, cursor) => {
        url.searchParams.set("after", cursor);
        return url;
      },
    },
  }),
]);
```

A resume URL must keep the connection's origin and carry no credentials;
otherwise the connection fails with `unsupported-option`.

Declare a `resetEvent` when your server can tell that it cannot replay from the
cursor it received. Its arrival reports `gap/replay-reset` to every subscription
on the stream, replaces an earlier `resumed`, and is never delivered:

```ts
const orders = sse<Order>("/api/orders", {
  replay: "last-event-id",
  resetEvent: "replay-reset",
});
```

A POST stream restarts only when you declare it `repeatable: true`.
`sse({ url, ...options })` is the same stream as `sse(url, options)`.
