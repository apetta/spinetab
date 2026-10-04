# Spinetab

A client-side TypeScript library that shares live subscriptions across browser tabs
and recovers them after interruptions. A SharedWorker hosts the selected upstream
clients; each tab attaches through a small bridge, equivalent subscriptions share
one upstream connection, and Spinetab reports mode, connection and continuity state
separately. Where SharedWorker is unavailable, the same adapters run in the tab
through a lazily loaded local runtime. A bundler plugin generates the worker from
the application's imports; the application can own the worker file instead.

[Documentation](https://github.com/apetta/spinetab/tree/main/apps/website/src/content/docs/docs) · [Release notes](CHANGELOG.md) · [GitHub](https://github.com/apetta/spinetab)

## Quick start

Install Spinetab in your existing app:

```sh
pnpm add spinetab
```

Add the plugin alongside your existing bundler plugins. With Vite:

```ts
// vite.config.ts
import { spinetab } from "spinetab/vite";
import { defineConfig } from "vite";

export default defineConfig({ plugins: [spinetab()] });
```

Next.js wraps its config in `withSpinetab()` from `spinetab/next`. webpack and
Rspack take `plugins: [spinetab()]` from `spinetab/webpack` or `spinetab/rspack`.
Astro takes `integrations: [spinetab()]` from `spinetab/astro`. See the
[bundler setup guide](https://github.com/apetta/spinetab/blob/main/apps/website/src/content/docs/docs/bundlers.md)
for configuration details.

Create the client once:

```ts
// src/live.ts
import { createSpinetab } from "spinetab";

export const spinetab = createSpinetab();
```

Subscribe to an endpoint that returns JSON such as `{ "open": 12 }`:

```ts
import { polling } from "spinetab/polling";
import { spinetab } from "./live";

type Queue = { open: number };

const subscription = spinetab.subscribe(polling<Queue>("/api/queue"), {
  next: (queue) => console.log(queue.open),
  error: (error) => console.error(error),
});
```

Keep the returned handle and call `subscription.unsubscribe()` when the view is
removed. The [framework bindings](https://github.com/apetta/spinetab/blob/main/apps/website/src/content/docs/docs/bindings.md)
manage this cleanup for you.

The plugin generates the worker from the app's `spinetab/<source>` imports: here
`spinetab/polling`, so the worker registers `pollingAdapter()`. The same module is
the lazy local runtime for tabs that cannot share. Without the plugin, a client
with neither `worker` nor `local` fails with reason `not-configured` and reports
once: `add the spinetab plugin to your bundler config, or pass worker and local to createSpinetab.`

Polling reads every 5 s by default and pauses while none of the subscribed tabs is
visible; `pollEvery(ms)` from `spinetab/polling`, passed as the third argument,
changes the interval. An observer object `{ next, error, status }` in place of the
function also receives errors and status changes.

## Plugin configuration

The plugin takes three options, all optional:

| Option              | Default                                                                 | Use                                                                                 |
| ------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `worker`            | `spinetab.worker.{ts,mts,js,mjs}` in `src/`, `app/` or the root, if any | Your worker file, relative to the project root                                      |
| `adapters`          | Inferred from the app's `spinetab/<source>` imports                     | Replaces inference, for example `["polling", "sse"]`                                |
| `credentialOrigins` | Empty: only the page's own origin                                       | Exact `https:` origins that may receive provider credentials; generated worker only |

Adapter names are `polling`, `sse`, `stream`, `websocket`, `graphql-ws`,
`graphql-sse`, `socket-io`, `trpc-ws`, `trpc-sse` and `ai-sdk`. Inference reads
the code of every source file under the project root, so an import in a file no
page uses still adds its adapter; set `adapters` for an exact set. `withSpinetab`
also takes `dir`, the Next.js project directory, for builds started from another
directory. Build errors and warnings print as `[spinetab] <code>: <sentence>`.

Protocol endpoints (`spinetab/graphql-ws`, `/graphql-sse`, `/socket-io`, `/trpc`)
need one declaration on the client: `credentials`, a callback returning
`{ headers?, connectionParams?, auth? }`, or `anonymous: true`. Without either,
they stay `auth-blocked` and the omission is reported once; Spinetab never connects
unauthenticated by accident. Provider credentials go only to the worker's own
origin and to origins in `credentialOrigins`: the plugin option for a generated
worker, or `defineWorker` in your own worker file, never both. It is deployment
configuration compiled into the worker, so it takes effect for new SharedWorker
instances; open tabs keep the old worker until they close.

## Your own worker file

Keep the plugin line and add `spinetab.worker.ts` in `src/`, `app/` or the project
root, or name the file with the `worker` option. The plugin wires it in and stops
generating. It has the shape of the file the plugin generates:

```ts
// src/spinetab.worker.ts
import { pollingAdapter } from "spinetab/polling/runtime";
import { defineWorker } from "spinetab/worker";

export default defineWorker(() => [pollingAdapter()], {
  credentialOrigins: ["https://api.example.com"],
});
```

Every runtime entry names its factory `<entry>Adapter()`, such as `sseAdapter()`
from `spinetab/sse/runtime`. You need a worker file for function-valued options
(WebSocket topic `protocols`, SSE `decoders`, stream `parsers`, Socket.IO `routes`,
the tRPC `transformer`) and for `limits` and `diagnostics`.

With a worker file, set `credentialOrigins` in `defineWorker`; `adapters` or
`credentialOrigins` in the plugin options is then a build error
(`worker-file-with-options`). Creating or deleting the file needs a dev-server
restart.

A tRPC router with a data transformer such as superjson needs `transformer: true`
on `spinetabWsLink` or `spinetabSseLink`, and `trpcWsAdapter({ transformer })` or
`trpcSseAdapter({ transformer })` in the worker file. An adapter without a
transformer refuses marked subscriptions with `unsupported-option`.

## Wire it by hand

Pass `worker` and `local` to `createSpinetab` to wire the worker yourself, with or
without the plugin. Either option opts that client out of the plugin's wiring
entirely:

```ts
// src/live.ts: keep the SharedWorker expression literal so bundlers emit the worker
import { createSpinetab } from "spinetab";

export const spinetab = createSpinetab({
  worker: () =>
    new SharedWorker(new URL("./spinetab.worker.ts", import.meta.url), {
      type: "module",
    }),
  local: () => import("./spinetab.worker"),
});
```

The plugin may stay installed: its chunks are emitted but never downloaded. Remove
it when no client uses it, and the build no longer emits them.

## Signals

`spinetab.status` reports the execution mode (`shared`, `local`, `failed` and so
on, with a reason) and page-to-runtime health. Each subscription's `status` reports
its upstream connection and, separately, its continuity: `continuous`, `gap`,
`unknown` or `resumed`. `summariseStatus(status)` from `spinetab` condenses them
into a `phase` and a `needsReconcile` flag without merging them: a reconnected
connection never means nothing was missed.

Spinetab reports known gaps and uncertain delivery until recovery completes. `reconcileOnLoss(subscription, refresh)` runs a refresh after each
loss, restarting stopped delivery first, and marks the subscription reconciled only
when the refresh resolves, so the refresh must resolve only after the data is
refreshed and reject or throw on failure; bindings and integrations take the same
policy as a `reconcile` option. `subscription.markReconciled()` remains the manual
path. An unhandled terminal error, or delivery stopped after a loss with no
handler, is reported once through `onCallbackError`, else `reportError`, as a code
and a fixed sentence.

## Entries

One package with isolated subpath exports. Page entries ship ESM, CommonJS and
declarations. Runtime entries (`/runtime`, `/worker` and `<capability>/runtime`) are
ESM-only and load in the worker or the lazy local runtime. Build entries run in
Node, inside the bundler config.

| Area               | Page entries (ESM + CJS)                                         | Runtime entries (ESM)                                                               |
| ------------------ | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Core               | `spinetab`                                                       | `spinetab/runtime`, `spinetab/worker`                                               |
| Transports         | `spinetab/websocket`, `/sse`, `/stream`, `/polling`              | `spinetab/websocket/runtime`, `/sse/runtime`, `/stream/runtime`, `/polling/runtime` |
| Protocols          | `spinetab/graphql-ws`, `/graphql-sse`, `/socket-io`              | `spinetab/graphql-ws/runtime`, `/graphql-sse/runtime`, `/socket-io/runtime`         |
| Integrations       | `spinetab/apollo`, `/tanstack-query`, `/swr`, `/trpc`, `/ai-sdk` | `spinetab/trpc/runtime`, `/ai-sdk/runtime`                                          |
| Framework bindings | `spinetab/react`, `/vue`, `/svelte`, `/solid`                    | —                                                                                   |

Build entries (ESM + CJS, Node only): `spinetab/vite`, `/webpack`, `/rspack`,
`/next`, `/astro` and `/nuxt` export the bundler integrations, and `spinetab/loader` is the
loader they share. `spinetab/wiring`, `spinetab/auto/wiring`, `spinetab/auto/worker`
and `spinetab/worker-config` are seams the plugins redirect; applications do not
import them.

The root entry never imports adapters, frameworks or the runtime engine, and no
entry re-exports the others. Imports have no side effects. Only `spinetab/react`
carries `"use client"`.

## Optional peers

Core has no runtime dependencies. Install only the peers for the entries you use.
Each range starts at the version the package is tested against
(`^<tested version>`); older versions are not supported until they are tested.

| Peer                   | Tested  | Used by                                     |
| ---------------------- | ------- | ------------------------------------------- |
| `graphql`              | 17.0.2  | `graphql-ws/runtime`, `graphql-sse/runtime` |
| `graphql-ws`           | 6.3.0   | `graphql-ws/runtime`                        |
| `graphql-sse`          | 2.6.1   | `graphql-sse/runtime`                       |
| `socket.io-client`     | 4.8.4   | `socket-io/runtime`                         |
| `@apollo/client`       | 4.3.1   | `apollo`                                    |
| `rxjs`                 | 7.8.2   | `apollo`                                    |
| `@tanstack/query-core` | 5.104.0 | `tanstack-query` (types)                    |
| `swr`                  | 2.5.1   | `swr` (types)                               |
| `@trpc/client`         | 11.19.0 | `trpc`, `trpc/runtime`                      |
| `@trpc/server`         | 11.19.0 | `trpc`, `trpc/runtime` (types)              |
| `ai`                   | 7.0.116 | `ai-sdk` (types)                            |
| `react`                | 19.3.0  | `react`                                     |
| `vue`                  | 3.5.43  | `vue`                                       |
| `svelte`               | 5.57.1  | `svelte`                                    |
| `solid-js`             | 1.9.15  | `solid`                                     |

## Limits

Delivery queues, control messages, commands, frames, subscriptions and connections
are bounded, and exceeding a bound produces a reported outcome (for example a
`gap/overflow` for a slow consumer) rather than unbounded memory. Set them with
`defineWorker(adapters, { limits })` in your own worker file. Choose limits for
your payload sizes, subscription counts and application requirements.

## Non-goals

- No application cache, state management or persistence. Apollo, TanStack Query,
  SWR or the application own data.
- No replay backend, server helpers or custom wire protocol. Recovering missed
  events needs the backend's or protocol's own replay, or application reconciliation.
- No automatic resend of mutations, arbitrary sends or AI generation starts.
- No leader election or cross-tab locks.
- No Node or React Native runtime. Page entries import safely during server-side
  rendering and stay inert there.

## Compatibility

Use TypeScript 5.7 or later. Browser and application checks cover Chromium,
Firefox and WebKit, supported bundlers, and SSR framework integrations. Physical
mobile suspension is not yet verified. The
[compatibility guide](https://github.com/apetta/spinetab/blob/main/apps/website/src/content/docs/docs/compatibility.md)
lists tested versions and known restrictions, including upstream peer type issues.

See the [repository README](https://github.com/apetta/spinetab#readme) for development
setup and contribution guidelines.
