# Spinetab

A client-side TypeScript library for sharing live subscriptions across browser tabs
and recovering after interruptions.

**Scaffold only:** every entry is empty. There is no working connection API yet.
The package remains private until the implementation and release checks pass.

One npm package, with independent subpath exports:

| Area                 | Imports                                                          |
| -------------------- | ---------------------------------------------------------------- |
| Core                 | `spinetab`                                                       |
| Worker host          | `spinetab/worker`                                                |
| Transports           | `spinetab/websocket`, `/sse`, `/stream`, `/polling`              |
| Protocol adapters    | `spinetab/graphql-ws`, `/graphql-sse`, `/socket-io`              |
| Library integrations | `spinetab/apollo`, `/tanstack-query`, `/swr`, `/trpc`, `/ai-sdk` |
| Framework bindings   | `spinetab/react`, `/vue`, `/svelte`, `/solid`                    |

Page entries build to ESM, CommonJS and declarations. The worker host entry is
ESM-only; it is a library module, not a ready-to-run worker asset. Adapter runtime
and worker subpaths will be added when their implementation contracts are proved.

The React entry carries `"use client"`, with emitted-directive checks for both
formats. Core and worker entries remain unmarked. This prepares the package boundary;
React APIs and Next.js runtime/hydration acceptance are not implemented yet.

Core must stay independent of protocols and frameworks. Add optional peers only
alongside the corresponding implementations. Keep imports side-effect-free and
never re-export all integrations from the root. Application state, caches and
backend replay are outside the library's scope.

Run `pnpm --filter spinetab build` to build, or `pnpm test` from the repository
root to build and check export resolution. Current tests verify package plumbing
only. They do not establish sharing, recovery, protocol support or tree shaking
of real implementations.

See the [repository README](../../README.md) for setup and contribution guidelines.
