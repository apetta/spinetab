# Authentication and recovery

## Credentials and identities

Read [credentials and scopes](https://spinetab.com/docs/concepts/credentials.md)
for private feeds or account changes.

- Supply tokens through the client's `credentials` callback, in the format the
  protocol and server expect: `headers` for HTTP, `connectionParams` for GraphQL
  or tRPC over WebSocket, or `auth` for Socket.IO. Existing HTTP-client
  authentication does not automatically configure the worker's connection.
- Plain `websocket()` does not read provider credentials. Use cookies, or a
  custom-worker protocol with an `authenticate` hook consuming `connectionParams`.
  The server must support the chosen authentication exchange.
- `anonymous: true` means no Spinetab-supplied token; browser cookies can still
  flow. GraphQL, Socket.IO, tRPC and custom WebSocket protocols with `authenticate`
  require an explicit credential or anonymous declaration.
- Use distinct scopes for distinct users or tenants. Change scope when the
  principal changes and clear or replace the application's cache separately.
  Rotate the credential revision when tokens change. Scopes separate shared work;
  the server still authorises every request.
- Cross-origin provider credentials need an exact HTTPS origin in
  `credentialOrigins`: set it in the plugin options for a generated worker, or
  in `defineWorker` for a custom worker, never both. Polling, fetch-mode SSE and
  fetch streams also need `authHeaders: true` on the source to send provider
  headers cross-origin. Check the transport's cookie/CORS rules. Permit only
  the API origins needed; keep credentials out of URLs and static source options.

Matching subscriptions share only within the same worker and compatible scope,
credentials mode and request identity. See
[identity](https://spinetab.com/docs/concepts/identity.md) when deciding which work
can be shared or diagnosing duplicate connections.

## Choose a recovery policy

Read [continuity](https://spinetab.com/docs/concepts/continuity.md) and the chosen
integration's recovery section. Reconnection restores delivery; it does not prove
that missing data was recovered.

| Event contract                                 | Recovery approach                                                                          |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Each event contains the complete current state | `reconcile: "latest"` can recover on the next complete event.                              |
| Events contain deltas or partial results       | Refresh a snapshot and merge live updates using the server's version or watermark.         |
| The backend supports replay                    | Follow the adapter's cursor/replay contract and account for duplicates and local overflow. |
| Neither replay nor refresh is available        | Keep the loss visible; identify the missing backend capability.                            |

A refresh callback must resolve only when recovery has succeeded and reject on
failure. An invalidation or refetch request may resolve without fetching fresh
data. Use the integration's documented success conditions. Check cancellation
before writing a refresh result; cancellation alone cannot undo a stale cache
write or order a snapshot against newer live events.

Late subscribers receive future events, not retained history. Load any initial
snapshot or history through the application's existing data path. Do not infer
replay from a connection reopening or from a cursor merely being forwarded.

## Protocol-specific decisions

Read the relevant guide before treating these operations as ordinary feeds:

- [Fetch streams](https://spinetab.com/docs/transports/stream.md): requests are
  non-repeatable by default, even for GET. Declare `repeatable: true` only when
  opening another request is safe; sharing and restarts depend on that contract.
- [Socket.IO](https://spinetab.com/docs/protocols/socket-io.md): choose shared or
  per-tab semantics deliberately. Room membership and presence may change when
  tabs share a socket. Namespace and transport path are different settings.
- [tRPC](https://spinetab.com/docs/integrations/trpc.md): keep queries and mutations
  on their existing links. Custom transformers need the matching worker setup;
  do not pass functions across the bridge.
- [AI SDK](https://spinetab.com/docs/integrations/ai-sdk.md): following a generation
  requires the documented backend generation identity and resumable stream
  contract. Keep the existing chat hooks, register and clean up following, and
  resume without resending the generation-start request. Detaching a tab does not
  cancel the server's generation.

Mutations, commands and generation starts are not automatically resent. When an
operation's outcome is unknown, check server state before retrying it.
