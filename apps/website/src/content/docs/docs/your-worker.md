---
title: Custom worker
description: Add custom parsers, protocol handlers or runtime settings without changing how components subscribe.
---

The plugin generates a worker from the adapters your app imports. Keep that
default unless you need custom parsing, protocol handlers or runtime settings.
You can supply your own worker file while keeping the plugin and client setup.

| Setup            | What you configure                                                                |
| ---------------- | --------------------------------------------------------------------------------- |
| Generated worker | The bundler plugin and `createSpinetab()`                                         |
| Custom worker    | The same setup, plus `spinetab.worker.ts` listing your adapters and their options |
| Manual wiring    | Worker and local runtime factories passed to `createSpinetab()`                   |

## When you need it

The generated worker constructs every adapter without options. Anything that takes
a function, or a runtime setting, belongs in your own worker file:

| Need                                       | In your worker file                                                   |
| ------------------------------------------ | --------------------------------------------------------------------- |
| WebSocket topic protocols                  | `websocketAdapter({ protocols })`                                     |
| Custom SSE decoders                        | `sseAdapter({ decoders })`                                            |
| Custom stream parsers                      | `streamAdapter({ parsers })`                                          |
| Socket.IO event routes                     | `socketIoAdapter({ routes })`                                         |
| A tRPC data transformer, such as superjson | `trpcWsAdapter({ transformer })` or `trpcSseAdapter({ transformer })` |
| Runtime limits                             | `defineWorker(adapters, { limits })`                                  |
| Diagnostics                                | `defineWorker(adapters, { diagnostics })`                             |

A tRPC link also needs `transformer: true` on the page; see
[tRPC](/docs/integrations/trpc/). Each source page describes its worker customisation options.

## Your own worker file

Create `src/spinetab.worker.ts` and register the adapters you use:

```ts title="src/spinetab.worker.ts"
import { pollingAdapter } from "spinetab/polling/runtime";
import { sseAdapter } from "spinetab/sse/runtime";
import { defineWorker } from "spinetab/worker";

export default defineWorker(() => [pollingAdapter(), sseAdapter()]);
```

The plugin looks for `spinetab.worker.ts` in `src/`, in `app/` and at the project
root (`.mts`, `.js` and `.mjs` work too). When it finds one, it stops generating
and uses yours. The plugin line and `createSpinetab()` stay as they are.

Anywhere else, name the file with the `worker` option, relative to the project
root:

```ts
spinetab({ worker: "src/live/spinetab.worker.ts" });
```

Your file lists every adapter the app uses; the plugin no longer infers them.
Restart the dev server after creating or deleting the file.

## `credentialOrigins`

Provider credentials go only to the worker's own origin. To allow another origin,
list it in one place. For a generated worker, that is the plugin options:

```ts
spinetab({ credentialOrigins: ["https://api.example.com"] });
```

For your own worker file, it is `defineWorker`:

```ts title="src/spinetab.worker.ts"
import { graphqlWsAdapter } from "spinetab/graphql-ws/runtime";
import { defineWorker } from "spinetab/worker";

export default defineWorker(() => [graphqlWsAdapter()], {
  credentialOrigins: ["https://api.example.com"],
});
```

Never both: a worker file with `adapters` or `credentialOrigins` in the plugin
options fails the build. The list is deployment configuration, compiled into the
worker. It takes effect for new SharedWorker instances; open tabs keep the old
worker until they close. [Credentials and scopes](/docs/concepts/credentials/#where-tokens-may-go)
has the rules for entries.

## By hand

Pass `worker` and `local` to `createSpinetab` and the client ignores the plugin's
wiring entirely. [Wire it by hand](/docs/bundlers/#wire-it-by-hand) has the recipe.

## Build messages

Build messages start with `[spinetab]` and include a code. Use the message's file
path, when present, to locate the problem.

| Code                                              | What to do                                                                                                 |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `no-adapters`                                     | Import a source, set `adapters`, or remove the plugin if unused.                                           |
| `adapter-not-generated`                           | Add the missing adapter to `adapters` or your worker file.                                                 |
| `missing-peer`                                    | Install the peer package named in the message.                                                             |
| `unknown-adapter`                                 | Use an adapter name from the list below.                                                                   |
| `unknown-option`, `invalid-options`               | Pass an options object containing `worker`, `adapters` or `credentialOrigins`; Next.js also accepts `dir`. |
| `invalid-worker-option`, `worker-file-missing`    | Point `worker` at an existing file relative to the project root.                                           |
| `invalid-dir-option`, `project-directory-unknown` | Run Next.js from its project directory, or set an absolute `dir`.                                          |
| `package-not-installed`                           | Install Spinetab in the application package.                                                               |
| `scan-fallback`                                   | Check the named source file, or set `adapters` explicitly.                                                 |
| `invalid-credential-origin`                       | Use an exact HTTPS origin without a path, query or fragment; HTTP is allowed for loopback.                 |
| `worker-file-with-options`                        | Move `adapters` and `credentialOrigins` from the plugin into your custom worker.                           |
| `worker-file-conflict`                            | Keep one conventionally named worker file, or select one with `worker`.                                    |
| `worker-file-no-default`                          | Export `defineWorker(...)` as the worker file's default export.                                            |
| `worker-file-not-wired`                           | Check the Next.js project directory and `dir` option.                                                      |
| `restart-required`, `adapter-restart-required`    | Restart the dev server and reload open tabs.                                                               |
| `wiring-not-applied`                              | Check for aliases or plugins resolving Spinetab before its plugin.                                         |
| `worker-parser-disabled`                          | Restore the bundler's `module.parser.javascript.worker` setting.                                           |

`no-adapters` warns in development and fails production builds. Use `adapters: []`
only if an empty worker is intentional. `missing-peer` can be a warning for
inferred adapters; explicitly selected adapters require their peers.

## What the plugin generates

For an app that imports `spinetab/polling` and `spinetab/sse`, the plugin
generates a module like this:

```ts
// Generated by spinetab. Do not edit.
import { pollingAdapter } from "spinetab/polling/runtime";
import { sseAdapter } from "spinetab/sse/runtime";
import { defineWorker } from "spinetab/worker";
export default defineWorker(() => [pollingAdapter(), sseAdapter()]);
```

The same module runs as the SharedWorker and, in a tab that cannot share, as the
lazy local runtime. [Adapter inference](/docs/bundlers/#adapter-inference) explains
how imports select adapters. To choose the set yourself, pass `adapters`:

```ts
spinetab({ adapters: ["polling", "sse"] });
```

The names are `polling`, `sse`, `stream`, `websocket`, `graphql-ws`,
`graphql-sse`, `socket-io`, `trpc-ws`, `trpc-sse` and `ai-sdk`.
