---
title: Sharing and identity
description: When two requests share upstream work, how subscriber lifetimes work and what limits sharing.
---

Spinetab compares the endpoint, scope and request options to decide which work
can be shared. Two requests must match after normalisation.

## Two identities

- **Connection identity**: the adapter, the resolved endpoint, the connection
  options, the client's scope and whether the page is anonymous. Requests with the
  same connection identity share upstream work, subject to the protocol rules below.
- **Subscription identity**: the connection identity plus the feed, operation,
  parameters and any option that changes what the server sends. Requests with the
  same subscription identity share one upstream subscription.

Identity is canonical: object keys are sorted, `undefined` values are dropped and
array order is kept. Spinetab matches identical canonical requests only; it does
not treat differently written queries or requests as equivalent. A builder's defaults
are part of identity, so `sse(url)` and `sse(url, { decoder: "json" })` are the
same stream.

For example, in one scope:

- Two tabs subscribing to the same GraphQL subscription with the same variables
  share one upstream subscription.
- Different variables need separate subscriptions, possibly on the same socket.
- A different scope always needs separate upstream work.
- An anonymous page and a page with a `credentials` callback never share a
  connection.
- Two commands, mutations or AI generation starts stay two actions, even with the
  same payload.

Per-consumer options, such as a polling interval, never split identity. Unknown
options are refused with `unsupported-option`, and credentials never enter
identity. See [Credentials and scopes](/docs/concepts/credentials/).

## Subscriber lifetime

1. The first consumer of an identity starts the upstream subscription.
2. Later consumers, in any tab, join it and receive future events.
3. Removing one consumer leaves the others running.
4. When the last consumer leaves, the upstream subscription stops after
   `lingerMs` (default one macrotask, at most 5 s).
5. A connection with no remaining work closes after `idleCloseMs` (default 5 s,
   at most 60 s).

`unsubscribe()` is safe to call more than once. A page that disappears without cleaning up is
reclaimed when its attachment lease expires (default 180 s without a heartbeat).
A lease expiring means the page is no longer served, not that the tab is gone: a
returning page reattaches with continuity `unknown`.

## Connection counts follow the protocol

Sharing reduces duplicate work; it does not promise one socket for everything.

- GraphQL over SSE in `distinct` mode opens one response per subscription.
- Socket.IO with `sharing: "per-tab"` gives each tab its own socket.
- A fetch stream that is not declared `repeatable` is never shared.
- AI generation streams accept joiners only before their first chunk.

## What limits sharing

Only tabs that reach the same worker share it. The browser runs separate
SharedWorkers for different profiles, storage partitions (for example the same app
embedded under different top-level sites), worker script URLs and worker names. A
new deployment with a new hashed worker URL therefore runs a separate worker; see
[Deployment](/docs/deployment/).

In development, the bundler plugin names the worker with a hash of its
contents, so a tab still on an older adapter set keeps its old worker until it
reloads. For a custom worker, the hash covers the worker file, not its imported
modules. Production builds set no worker name.

A worker name or scope string is not a security boundary against other code on the
same origin. Your server must still authorise every request.
