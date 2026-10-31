---
name: spinetab
description: >-
  Integrate or debug Spinetab to share live subscriptions across browser tabs.
  Use for duplicate WebSocket connections, SSE streams, HTTP polling or GraphQL
  subscriptions across tabs; replacing custom SharedWorker subscription plumbing;
  or following resumable AI SDK generations. Covers React, Vue, Svelte and Solid,
  with TanStack Query, SWR, Apollo and tRPC integrations.
license: MIT
---

# Spinetab

Spinetab shares matching live subscription work through a SharedWorker, with a
per-tab fallback. It connects to the application's existing API; the application
or its data library retains its cache.

## Establish the fit

Identify the app's framework, bundler, data library and backend contract from its
existing code. Distinguish full-state events from incremental changes; this
determines recovery. Ask only for API details that the project does not establish.

Use Spinetab where sharing live work across tabs addresses the task. It does not
provide cross-tab cache synchronisation, persistence, a backend or exactly-once
delivery. Page imports are SSR-safe, but subscriptions run in browsers, not Node.js
or React Native. Work that must continue after every tab closes belongs on the
backend. See [limits](https://spinetab.com/docs/limits.md) when assessing suitability.

## Find the matching implementation

For a new integration, search the [recipe index](https://spinetab.com/recipe-index.md)
for the matching framework, data library and protocol. For basic transport setup,
start with [getting started](https://spinetab.com/docs/getting-started.md).
Treat the recipe's server contract as a prerequisite, not something the plugin creates.
For an existing integration, start with its guide or the failure diagnostics in
[verification](references/verification.md); there is no need to rebuild the setup.

Use the relevant integration guide to adapt it to the existing application:

| Application uses                               | Guide                                                                      |
| ---------------------------------------------- | -------------------------------------------------------------------------- |
| Component state in React, Vue, Svelte or Solid | [Framework bindings](https://spinetab.com/docs/frameworks.md)              |
| TanStack Query                                 | [TanStack Query](https://spinetab.com/docs/integrations/tanstack-query.md) |
| SWR                                            | [SWR](https://spinetab.com/docs/integrations/swr.md)                       |
| Apollo Client                                  | [Apollo](https://spinetab.com/docs/integrations/apollo.md)                 |
| tRPC                                           | [tRPC](https://spinetab.com/docs/integrations/trpc.md)                     |
| AI SDK chat                                    | [AI SDK](https://spinetab.com/docs/integrations/ai-sdk.md)                 |

For an unlisted setup or a specific API question, use the
[documentation index](https://spinetab.com/llms.txt) to find the relevant guide.
Where no exact recipe exists, verify support in the integration and framework
guides before adapting the nearest example.
Raw WebSocket, GraphQL over WebSocket, Socket.IO and tRPC are different protocols;
an SSE response alone does not imply the GraphQL SSE protocol.

Check [compatibility](https://spinetab.com/docs/compatibility.md) against the
installed package and peer versions before applying examples. The live docs may
describe a newer release. Resolve a mismatch using the installed package's types
and version-matched sources; make any required migration explicit. If docs cannot
be fetched, use available package sources and identify missing evidence.

## Adapt the application

Choose authentication and recovery for the application's session and event contract.
Recipe defaults such as `anonymous: true` and `reconcile: "latest"` are not universal.
Read [reliability](references/reliability.md) for these choices, account changes,
commands or resumable streams; for a focused repair, read only the relevant sections.

- Keep existing providers, caches, routes, authentication and query/mutation
  behaviour. Recipe providers and demo schemas make examples standalone; reuse
  the application's equivalents. Keep its data library's hooks instead of adding
  a second subscription through Spinetab's direct bindings.
- Use the framework or bundler plugin to generate the worker and lazy local
  fallback. Merge it into existing configuration. Install only the optional peers
  needed for the chosen integration, using the project's package manager.
- Use a [custom worker](https://spinetab.com/docs/your-worker.md) for function-valued
  protocol hooks, decoders or transformers. Functions cannot cross the worker
  bridge. A custom worker must register every adapter the app uses; the plugin
  stops inferring them. Explicit `worker` or `local` factories replace plugin
  wiring entirely; a worker factory alone does not retain the generated fallback.
- Follow the chosen binding's lifecycle and retain SSR. Client construction is
  inert on the server; subscription work belongs in the browser lifecycle. Release
  each subscription when its consumer ends, and dispose an app-wide client only
  when the application no longer needs it.

### Direct subscription example

For a plain browser consumer, this is the shape after adding the bundler plugin.
The example assumes an existing `GET /api/ticks` SSE endpoint whose JSON events,
such as `{ "n": 1 }`, each contain the complete current counter value, not an
increment. Substitute the application's real endpoint and payload.

```ts
import { createSpinetab, reconcileLatest } from "spinetab";
import { sse } from "spinetab/sse";

type Tick = { n: number };
const spinetab = createSpinetab();
const ticks = sse<Tick>("/api/ticks");

export function watchTicks(onTick: (tick: Tick) => void) {
  const subscription = spinetab.subscribe(ticks, {
    next: (tick) => {
      onTick(tick);
      recovery.onEvent();
    },
    error: (error) => console.error(error.code),
  });
  const recovery = reconcileLatest(subscription);
  return () => {
    recovery.stop();
    subscription.unsubscribe();
  };
}
```

Call `watchTicks` when the browser view starts and its returned cleanup when the
view ends.

## Verify the result

For a new shared feed, the expected result is two tabs receiving updates from one
matching upstream operation, with one tab continuing when the other unsubscribes.
Validate the affected behaviour with [verification](references/verification.md),
including protocol-specific counts and local fallback. Report the evidence
obtained and any remaining backend requirements or unverified behaviour.
