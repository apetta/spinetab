---
title: GraphQL
description: Share GraphQL subscriptions across tabs over graphql-ws or graphql-sse, with the real protocol clients running in the worker.
---

For a complete component, provider and framework setup, [choose your recipe](/docs/recipes/).
This page covers the protocol API and its options.

Share GraphQL subscriptions over `graphql-ws` or `graphql-sse`. Queries and
mutations stay with your existing client. If you use Apollo, start with the
[Apollo integration](/docs/integrations/apollo/) after setting up the plugin.

[Set up the plugin and client](/docs/getting-started/) first. The examples use
`spinetab.subscribe()`; call the returned handle's `unsubscribe()` when your view
is removed. [UI bindings](/docs/frameworks/) handle that cleanup for components.

```sh
pnpm add spinetab graphql graphql-ws
```

```ts title="live.ts"
import { createSpinetab } from "spinetab";

export const spinetab = createSpinetab({ anonymous: true });
```

```ts
import { graphqlWs } from "spinetab/graphql-ws";
import { spinetab } from "./live";

const api = graphqlWs("/graphql");

const subscription = spinetab.subscribe(
  api.subscription({ query: "subscription { tick { n } }" }),
  (result) => console.log(result.data),
);
```

The worker runs `graphql-ws`; compatible tabs share its socket. The plugin
registers the adapter for you. Results arrive unchanged, including partial data
and GraphQL errors.

`anonymous: true` declares that this page supplies no token; cookies still flow.
For a token, declare a `credentials` callback instead:

```ts title="live.ts"
import { createSpinetab } from "spinetab";

export const spinetab = createSpinetab({
  credentials: async ({ signal }) => ({
    connectionParams: { token: await getAccessToken({ signal }) },
  }),
});
```

## Default behaviour

| Setting     | Default                                                  |
| ----------- | -------------------------------------------------------- |
| Credentials | Neither declared: `auth-blocked`, reported once          |
| Keep-alive  | A ping every 15 s; 5 s to answer                         |
| Retries     | graphql-ws's own loop, 5 attempts                        |
| Results     | Unchanged, errors and partial data included              |
| Identity    | Query, variables, operation name, extensions and context |
| Reconnect   | Continuity `unknown/reconnected`                         |

## Configure subscriptions

Type the result and variables with a typed document, such as a
`TypedDocumentNode` or a GraphQL Code Generator string:

```ts
spinetab.subscribe(
  api.subscription({ query: OnMessage, variables: { room } }),
  show,
);
```

Use GraphQL over SSE instead: `pnpm add graphql-sse` and build the endpoint with
`graphqlSse("/graphql/stream")` from `spinetab/graphql-sse`. The plugin registers
its adapter too.

Handle Spinetab errors and status next to the results:

```ts
spinetab.subscribe(onTick, {
  next: show,
  error: (error) => warn(error.code),
  status: (status) => log(status.connection.state),
});
```

Refetch after a reconnect, then mark the subscription reconciled. The refresh must
reject when the refetch fails:

```ts
import { reconcileOnLoss } from "spinetab";

const stopRecovery = reconcileOnLoss(subscription, async ({ signal }) => {
  const snapshot = await fetchMessages({ signal });
  if (!signal.aborted) mergeMessages(snapshot);
});
```

The fetch and merge functions belong to your application. Use a server version
or watermark to merge the snapshot with live updates. Call `stopRecovery()`
alongside `subscription.unsubscribe()` on teardown; see
[recovery](/docs/concepts/continuity/).

Declare one public endpoint in an app whose client has a `credentials` callback:

```ts
const publicApi = graphqlWs("/public/graphql", { anonymous: true });
```

## GraphQL over WebSocket

| Option                       | Default       | Meaning                                                 |
| ---------------------------- | ------------- | ------------------------------------------------------- |
| `connectionParams`           | None          | Non-secret init payload; credentials are merged over it |
| `keepAliveMs`                | 15 000        | Client ping interval                                    |
| `pongTimeoutMs`              | 5 000         | Missing-pong deadline before the socket is replaced     |
| `retryAttempts`              | 5             | Upstream retry budget                                   |
| `lazyCloseTimeoutMs`         | `idleCloseMs` | Close delay after the last subscription                 |
| `connectionAckWaitTimeoutMs` | 10 000        | Wait for `ConnectionAck`; `0` is refused                |
| `anonymous`                  | `false`       | This endpoint needs no credentials                      |

`http:` and `https:` URLs are mapped to `ws:` and `wss:`. A missing pong replaces
the socket, reports `reconnecting/heartbeat-timeout`, and graphql-ws reconnects
and resubscribes.

| Close code                               | Outcome                                                         |
| ---------------------------------------- | --------------------------------------------------------------- |
| 4401                                     | `auth-blocked`; the revision the socket sent is never reused    |
| 4403                                     | `failed/permanent-error`, code `forbidden`; nothing is rejected |
| 4408, 4504, 4499                         | Retried by graphql-ws                                           |
| 4400, 4004, 4005, 4406, 4409, 4429, 4500 | `failed/protocol-error`                                         |

When retries run out the connection is `retry-exhausted` and intent is kept;
`subscription.retry()` starts a fresh series.

## GraphQL over SSE

| Option               | Default         | Meaning                                                        |
| -------------------- | --------------- | -------------------------------------------------------------- |
| `mode`               | `"distinct"`    | `distinct` or `single`, to match your server                   |
| `headers`            | None            | Non-credential, response-affecting headers                     |
| `credentials`        | `"same-origin"` | The fetch cookie mode                                          |
| `retryAttempts`      | 5               | Upstream retry budget                                          |
| `lazyCloseTimeoutMs` | `idleCloseMs`   | Single mode: close delay after the last operation              |
| `heartbeatMs`        | None            | The server's heartbeat interval; 2.5× without bytes is a stall |
| `anonymous`          | `false`         | This endpoint needs no credentials                             |

`distinct` opens one response per subscription and suits HTTP/2. `single` reserves
one stream per connection and suits browsers limited to a few HTTP/1 connections
per origin. Spinetab never probes, switches or falls back.

A 401 is `auth-blocked` and rejects the revision that request carried. A 403 is
`failed`, code `forbidden`. A redirect on a request that carries provider headers
is not followed. Network failures, 408, 425, 429 and 5xx responses are retried by
graphql-sse.

In single mode, a 400 or 422 response with valid GraphQL errors rejects only that
operation. Other subscriptions keep running. The rejected operation is not retried.

## Credential rotation

`spinetab.setCredentialRevision(revision, { restart: true })` restarts the
connection: repeatable subscriptions reopen with the new credentials, and
non-repeatable ones end `interrupted`. The restart reports continuity once, when
the new connection is up. `repeatable: false` also holds when graphql-ws or
graphql-sse reconnect by themselves: a non-repeatable subscription the server
accepted ends `interrupted` rather than being sent again. Without `restart`, new
credentials apply at the next connect or when the connection is `auth-blocked`.

## Custom adapter behaviour

`graphqlWsAdapter()` accepts `retryWait`, a stricter `classifyClose`,
`webSocketImpl` and `applyContext`. `graphqlSseAdapter()` accepts `retry` and
`fetchFn`. These need your own worker file ([Custom worker](/docs/your-worker/)).
`graphqlWs({ url, ...options })` is the same endpoint as
`graphqlWs(url, options)`. An endpoint is not itself a source: pass
`endpoint.subscription({ query })`.
