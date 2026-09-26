---
title: Documentation
description: The Spinetab documentation scaffold.
---

Spinetab is in development. This site and the library entry points are scaffolds;
there is no working connection API yet.

The planned distribution is one npm package, `spinetab`, with separate imports for:

- A framework-independent client and SharedWorker host.
- WebSocket, SSE, fetch streams and polling.
- GraphQL over WebSocket/SSE and Socket.IO.
- Apollo, TanStack Query, SWR, tRPC and AI SDK integrations.
- Small React, Vue, Svelte and Solid bindings, alongside vanilla TypeScript usage.

Spinetab coordinates live subscriptions and recovery. Application caches and backend
replay remain with your existing tools. There is no Spinetab backend to deploy.

Guides and API documentation will be added alongside tested implementations.

[View the embedded examples](/examples/).
