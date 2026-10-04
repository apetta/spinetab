---
title: Socket.IO
description: Run socket.io-client in the worker, with declared sharing, room membership and acknowledged emits.
---

For a complete component, provider and framework setup, [choose your recipe](/docs/recipes/).
This page covers the protocol API and its options.

Share Socket.IO events with explicit control over whether tabs share a socket.
This connects to a Socket.IO server, not a raw WebSocket endpoint. Your client
must declare `credentials` or `anonymous: true`; see
[authentication](/docs/concepts/credentials/).

[Set up the plugin and client](/docs/getting-started/) first. The examples use
`spinetab.subscribe()`; call the returned handle's `unsubscribe()` when your view
is removed. [UI bindings](/docs/frameworks/) handle that cleanup for components.

```sh
pnpm add spinetab socket.io-client
```

```ts
import { socketIo } from "spinetab/socket-io";
import { spinetab } from "./live";

type Message = { room: string; text: string };

const chat = socketIo("/chat", { sharing: "shared" });

const subscription = spinetab.subscribe(
  chat.subscription<[Message]>({ event: "message" }),
  ([message]) => console.log(message.text),
);
```

As with `io()`, the URL path is the namespace: `/chat` on the page's origin. Events
arrive as the argument array the server emitted. The plugin registers the adapter
for you; the build reports `missing-peer` if `socket.io-client` is not installed.

**Choose how tabs share.** A Socket.IO socket often carries server state, such as
presence or room membership, which a shared socket would merge across tabs. Only
you know whether that is safe:

- `shared`: compatible tabs share a socket for the same namespace and settings.
- `per-tab`: each tab gets its own socket, still hosted by the worker.

## Default behaviour

| Setting         | Default                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------- |
| Namespace       | The URL path; `/` for a bare origin                                                         |
| Credentials     | Neither declared: `auth-blocked`, reported once                                             |
| Reconnection    | Socket.IO's Manager, 10 attempts                                                            |
| After reconnect | `resumed/recovered` if the server recovered state, else `unknown`; at most once per session |
| Commands        | Emitted at most once, with an acknowledgement                                               |
| Timeouts        | 10 s for acknowledgements, 20 s to connect                                                  |

## Rooms, commands and credentials

Join a room while anyone listens. Spinetab sends the join once per membership key
and session, and the leave after the last listener goes:

```ts
spinetab.subscribe(
  chat.subscription<[Message]>({
    event: "message",
    membership: "general",
    join: { event: "join", args: ["general"] },
    leave: { event: "leave", args: ["general"] },
  }),
  ([message]) => render(message.text),
);
```

If the last listener leaves before a join is acknowledged, Spinetab sends the
leave once the join completes. It also cleans up memberships left during a
disconnect when the server recovers that session.

Emit a command and read the acknowledgement:

```ts
const outcome = await spinetab.command(
  chat.command({ event: "send", args: ["Hi"] }),
);
```

Give each tab its own socket:

```ts
const presence = socketIo("/presence", { sharing: "per-tab" });
```

Handle errors and status next to the events:

```ts
spinetab.subscribe(messages, {
  next: show,
  error: (error) => warn(error.code),
});
```

Send a token in the handshake: return `auth` from the client's `credentials`
callback, for example `{ auth: { token } }`. It is merged over any static `auth`.

## Options

| Option                                          | Default      | Meaning                                                      |
| ----------------------------------------------- | ------------ | ------------------------------------------------------------ |
| `sharing`                                       | Required     | `shared` or `per-tab`                                        |
| `namespace`                                     | The URL path | Namespace; must match a non-root URL path                    |
| `path`                                          | `/socket.io` | Engine.IO path; a proxy prefix goes here                     |
| `transports`, `upgrade`                         | Upstream     | Socket.IO transport selection                                |
| `withCredentials`                               | Upstream     | Send cookies cross-origin                                    |
| `auth`                                          | None         | Non-secret static auth; `credentials.auth` is merged over it |
| `query`                                         | None         | Non-secret query parameters                                  |
| `ackTimeoutMs`                                  | 10 000       | Acknowledgement timeout for commands and joins               |
| `reconnectionAttempts`                          | 10           | Reconnection budget                                          |
| `reconnectionDelayMs`, `reconnectionDelayMaxMs` | Upstream     | Reconnection delays                                          |
| `timeoutMs`                                     | 20 000       | Connection timeout                                           |
| `anonymous`                                     | `false`      | This namespace needs no credentials                          |

The URL path is read after URL parsing: escapes are decoded and dot segments
resolved. A namespace with a literal percent escape goes in `namespace`, with a
root URL. Behind a proxy prefix, set `path`, for example `/api/socket.io`; a
prefix in the URL path would select a namespace instead.

## Commands

Commands are emitted only while the socket is connected and are never re-sent
after a disconnect. On a new connection, a command waits for the first connect
within the acknowledgement timeout; otherwise it settles `not-sent`.

| `ack`            | Outcome                                                  |
| ---------------- | -------------------------------------------------------- |
| `true` (default) | `acknowledged` with the acknowledgement's first argument |
| `"error-first"`  | A non-null first argument settles `rejected`             |
| `false`          | `sent`, without waiting                                  |

`volatile: true` may be dropped when the transport is not writable and implies
`ack: false`. Acknowledgement functions never cross to the page.

Acknowledgement IDs continue across handles on the shared connection. A late
acknowledgement for a released handle is dropped, so it cannot settle a replacement
handle's command. A command still pending when its handle is released stays
`unknown`.

## Recovery

Socket.IO's Manager owns reconnection, with a finite budget. A middleware
`connect_error` is classified by `classifyConnectError`. By default, status 401 or
a message matching "unauthorised" is `auth-blocked` and rejects the revision the
handshake sent. Status 403 or "forbidden" ends the connection as `failed`, code
`forbidden`, and rejects nothing. Anything else is a permanent failure. An
anonymous page and a page with a `credentials` callback never share a socket.

Spinetab allows one recovery attempt per Socket.IO session. A later disconnect,
explicit retry or credential restart opens a fresh session, restores active
memberships and reports uncertain continuity. This avoids restoring stale room
state. Commands are never replayed.

Server recovery does not repair a consumer's overflowed delivery window. Use a
[reconciliation policy](/docs/concepts/continuity/) to refresh application state
when recovery is unavailable or events were dropped locally.

Your server must stop emitting through a disconnected server socket. A new
socket for the same namespace can otherwise receive those writes; the client
cannot distinguish them from events intended for the replacement.

## Namespace lifetime

The last subscriber leaving releases its namespace and buffered events. Closing
and immediately reopening a namespace can require a reconnect while the old
handshake is finishing; sibling namespaces then recover their subscriptions.

## Custom event routing

A membership without a route gets its own socket. To share one socket between
listeners with different memberships, register a route in the worker that maps an
event's arguments to membership keys, and select it on the subscription. Register the route in a
[custom worker](/docs/your-worker/):

```ts title="spinetab.worker.ts"
import { socketIoAdapter } from "spinetab/socket-io/runtime";
import { defineWorker } from "spinetab/worker";

export default defineWorker(() => [
  socketIoAdapter({
    routes: {
      byRoom: (args) => {
        const message = args[0] as { room?: string } | undefined;
        return message?.room ? [message.room] : undefined;
      },
    },
  }),
]);
```

Select that route when subscribing:

```ts
spinetab.subscribe(
  chat.subscription<[Message]>({
    event: "message",
    route: "byRoom",
    membership: "general",
    join: { event: "join", args: ["general"] },
    leave: { event: "leave", args: ["general"] },
  }),
  ([message]) => render(message.text),
);
```

`socketIoAdapter()` also accepts `responders` for server-requested
acknowledgements and `classifyConnectError` for application-specific failures.
Responders run in the worker. Their results are discarded after the requesting
session ends, but Spinetab cannot cancel asynchronous work inside your function.

`socketIo({ url, ...options })` is equivalent to `socketIo(url, options)`.
