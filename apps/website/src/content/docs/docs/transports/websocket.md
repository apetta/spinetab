---
title: WebSocket
description: Share native WebSocket connections across tabs, raw or with topic routing and commands defined by a worker-side protocol.
---

Use this adapter for a native WebSocket endpoint. It shares the socket and
delivers incoming frames to subscribers. Topic subscriptions need your own
[protocol handler](#custom-websocket-protocols); for GraphQL or Socket.IO, use
[GraphQL](/docs/protocols/graphql/) or [Socket.IO](/docs/protocols/socket-io/) instead.

[Set up the plugin and client](/docs/getting-started/) first. The examples use
`spinetab.subscribe()`; call the returned handle's `unsubscribe()` when your view
is removed. [UI bindings](/docs/frameworks/) handle that cleanup for components.

```ts
import { websocket } from "spinetab/websocket";
import { spinetab } from "./live";

type Price = { symbol: string; price: number };

const prices = websocket<Price>("/prices", { decoder: "json" });
const subscription = spinetab.subscribe(prices, (price) =>
  console.log(price.price),
);
```

Tabs with matching connection settings share a socket. `decoder: "json"` parses each frame and
lets you name its shape; without it, frames arrive unchanged as
`string | ArrayBuffer`. The plugin registers the adapter for you.

## Default behaviour

| Setting          | Default                                                   |
| ---------------- | --------------------------------------------------------- |
| Payload          | Frames unchanged, typed `string \| ArrayBuffer`           |
| Sharing          | One socket per URL and options                            |
| Reconnect        | Jittered backoff, owned by Spinetab                       |
| After reconnect  | Continuity `unknown/reconnected`                          |
| Liveness         | None declared; repeatable feeds reopen when a tab returns |
| Bad JSON         | A `decode-error` gap; the socket stays open               |
| Oversized frames | Dropped with a gap                                        |
| Commands         | Sent at most once, never replayed                         |

## Send messages and handle events

Send a frame. Without a protocol, a string goes out as given and anything else as
JSON text, and the outcome is `sent`:

```ts
const outcome = await spinetab.command(prices.command({ action: "refresh" }));
```

Handle errors and status next to the frames:

```ts
spinetab.subscribe(prices, { next: show, error: (error) => warn(error.code) });
```

Offer subprotocols in the handshake:

```ts
const feed = websocket("/live", { subprotocols: ["prices.v2"] });
```

Reload your data after a reconnect. The reload must reject when it fails:

```ts
import { reconcileOnLoss } from "spinetab";

const stopRecovery = reconcileOnLoss(subscription, async ({ signal }) => {
  const snapshot = await fetchPrices({ signal });
  if (!signal.aborted) mergePrices(snapshot);
});
```

The fetch and merge functions belong to your application. Merge using a server
version so a snapshot cannot overwrite newer live events. Call `stopRecovery()`
alongside `subscription.unsubscribe()` on teardown; see
[recovery](/docs/concepts/continuity/).

## Commands

| Outcome                    | Meaning                                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `acknowledged`, `rejected` | The protocol correlated a reply                                                                                                            |
| `sent`                     | Written with no acknowledgement expected                                                                                                   |
| `not-sent`                 | Never written: the socket was not open, its buffer exceeded 1 MiB, the protocol could not encode it, or a frame exceeded `maxMessageBytes` |
| `unknown`                  | Written, but the socket closed or 10 s passed without a reply                                                                              |

## Options

| Option         | Meaning                                                           |
| -------------- | ----------------------------------------------------------------- |
| `protocol`     | Name of a protocol registered in the worker                       |
| `decoder`      | `"json"`: parse each frame. Raw connections only, not with `blob` |
| `subprotocols` | WebSocket subprotocols offered in the handshake                   |
| `binaryType`   | `arraybuffer` (default), or `blob` only without a protocol        |

The URL may be `ws:`, `wss:`, `http:`, `https:` or relative.
`websocket({ url, ...options })` is the same connection as `websocket(url, options)`.

## Recovery and restrictions

- Declare a `heartbeat` in your protocol to detect a stalled socket: a missed
  reply closes it with code 4000 and reconnects. Without one, when the page
  returns Spinetab reopens a socket whose subscriptions are all repeatable,
  reporting `unknown/reopened`.
- Oversized inbound frames are dropped with a gap; with `onOversize: "close"` the
  socket also closes with code 4001.
- Tokens never go in the URL or subprotocols: token-like query names and
  subprotocols longer than 64 characters or containing `bearer` are refused. Use
  cookies or the protocol's `authenticate` hook.

Switching back to a tab triggers this health check. Without a declared heartbeat,
the conservative reopen also applies to a socket that was receiving data.
An application ping/pong protocol or a declared inbound interval lets Spinetab
check the existing connection instead.

## Custom WebSocket protocols

Raw WebSocket has no standard topic protocol, so you describe yours in the worker.
Every hook runs there; pages refer to the protocol by name. Register it in a [custom worker](/docs/your-worker/), alongside the other adapters
your app uses:

```ts title="spinetab.worker.ts"
import {
  type WebSocketProtocol,
  websocketAdapter,
} from "spinetab/websocket/runtime";
import { defineWorker } from "spinetab/worker";

type Message = { type: string; id?: string; topic?: string; data?: unknown };

const topics: WebSocketProtocol<string> = {
  decode(raw) {
    if (typeof raw !== "string") return { kind: "ignore" };
    const message = JSON.parse(raw) as Message;
    if (message.type === "event") {
      return {
        kind: "event",
        topics: [message.topic ?? ""],
        event: message.data,
      };
    }
    if (message.type === "ack") return { kind: "ack", id: message.id ?? "" };
    if (message.type === "pong") return { kind: "heartbeat" };
    return { kind: "ignore" };
  },
  topicKey: (topic) => topic,
  subscribe: (topic) => [JSON.stringify({ type: "subscribe", topic })],
  unsubscribe: (topic) => [JSON.stringify({ type: "unsubscribe", topic })],
  command: (payload, id) => ({
    frames: [JSON.stringify({ type: "command", id, payload })],
    expectsAck: true,
  }),
  heartbeat: {
    intervalMs: 15_000,
    timeoutMs: 5_000,
    frame: () => JSON.stringify({ type: "ping" }),
  },
  classifyClose: (code) => (code === 4401 ? "auth" : "transient"),
};

export default defineWorker(() => [
  websocketAdapter({ protocols: { topics } }),
]);
```

Subscribe to a topic from the page:

```ts
const live = websocket("/live", { protocol: "topics" });

spinetab.subscribe(live.subscription<{ price: number }>("prices"), (event) =>
  render(event.price),
);
```

| Hook                       | Purpose                                                                      |
| -------------------------- | ---------------------------------------------------------------------------- |
| `decode`                   | Turn a frame into an event for topic keys, an ack, a heartbeat or nothing    |
| `subscribe`, `unsubscribe` | Frames sent when a topic gains its first or loses its last subscriber        |
| `command`                  | Encode an outbound command with a correlation id                             |
| `authenticate`             | First-message authentication with the provider's `connectionParams`          |
| `heartbeat`                | An application ping, or an expectation of inbound traffic                    |
| `classifyClose`            | Map a close code to `transient` (default), `auth` or `permanent`             |
| `topicKey`                 | The routing key for a topic; default the canonical JSON of the topic         |
| `onOversize`               | Drop oversized inbound frames with a gap (default), or also close the socket |

Subscribe and unsubscribe frames are sent once per socket per topic, not once per
tab, and re-sent once after a reconnect. With an `authenticate` hook, the socket
needs `credentials` or `anonymous: true` on the client. Map an auth failure close,
such as 4401, to `auth`, and a forbidden close, such as 4403, to `permanent`: `auth`
rejects the revision that authenticated the socket, and `permanent` rejects
nothing.

A throwing `subscribe` hook ends that topic with `subscribe-rejected`; other
topics continue. Exceptions in `unsubscribe` or `classifyClose` are reported as
`protocol-hook-error` diagnostics. A throwing heartbeat frame counts as a missed
heartbeat and triggers reconnection.

Choose one heartbeat shape: `{ intervalMs, timeoutMs, frame() }` for a probe, or
`{ expectInboundWithinMs }` when the server guarantees regular traffic. Timings
must be positive integers no greater than 2 147 483 647 ms.
