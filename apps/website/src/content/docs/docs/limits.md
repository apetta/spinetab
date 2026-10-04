---
title: Limits
description: Where connection sharing helps, what recovery needs and which responsibilities stay with your app.
---

Spinetab reduces duplicate subscription work in apps used across several tabs.
Your backend still authorises requests and owns durable data. Your app or data
library still owns its cache.

## Sharing boundaries

Matching subscriptions share work when they reach the same worker with the same
scope and request options. Separate browser profiles, storage partitions and
worker URLs use separate workers. In local mode, each tab runs its own work.

Connection counts depend on the source: GraphQL over SSE in `distinct` mode uses
one response per subscription, for example. See
[sharing and identity](/docs/concepts/identity/) for the matching rules.

## Recovery needs a data policy

Reconnecting restores live delivery. To recover missed events, your server must
replay them or your app must refresh its data. Spinetab reports known gaps and
uncertain delivery through [continuity](/docs/concepts/continuity/); it does not
guarantee exactly-once delivery.

Mutations, commands and AI generation starts are not automatically resent. If a
command may have reached the server, its outcome is `unknown`; check the resulting server state
before retrying.

The browser cannot deliver events while it is suspended. Recovery starts when
execution resumes. A worker can also stop after its last tab closes: work that
must outlive every tab belongs on your backend.

## Authentication

Your app supplies credentials, refreshes tokens and chooses a scope for each user
or tenant. Scopes separate subscription work; they do not protect against other
scripts on the same origin. Your server must authorise every request. See
[credentials and scopes](/docs/concepts/credentials/).

## Package size

Spinetab has no runtime dependencies. Import the subpaths you use and install
their optional peers. The generated worker includes the selected adapters; the
local fallback loads only when needed. Framework and protocol libraries add their
own code to your build.

## Browser runtime

Spinetab runs in browsers. Its page imports are safe during server rendering, but
do not start subscriptions there. Node.js and React Native are not subscription
runtimes. See [compatibility](/docs/compatibility/) for supported setups.
