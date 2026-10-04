---
title: Compatibility
description: Browser support, supported build tools, peer versions and setup restrictions.
---

Use the versions below as the supported starting point. Only install the peer
libraries needed by your chosen adapters and bindings.

## Browser engines

| Engine   | Tested version |
| -------- | -------------- |
| Chromium | 153.0.8010.12  |
| Firefox  | 155.0          |
| WebKit   | 26.6           |

These are automated test engine versions, not minimum browser versions. Physical
mobile suspension and recovery are not yet verified.
Spinetab uses SharedWorker when available and falls back to per-tab execution
otherwise. See [execution modes](/docs/concepts/modes/) for controlling fallback.
Browser support for SharedWorker varies by platform; check the
[MDN compatibility table](https://developer.mozilla.org/en-US/docs/Web/API/SharedWorker#browser_compatibility)
for your target browsers.

## Bundlers

| Bundler                                     | Tested version |
| ------------------------------------------- | -------------- |
| Vite                                        | 8.3.1          |
| Next.js App Router (Turbopack)              | 16.3.6         |
| Next.js App Router (`next build --webpack`) | 16.3.6         |
| webpack                                     | 5.111.1        |
| Rspack                                      | 2.2.7          |
| Astro                                       | 7.3.5          |

### SSR frameworks

| Framework                                 | Tested version | Setup                                    |
| ----------------------------------------- | -------------- | ---------------------------------------- |
| [SvelteKit](/docs/setup/sveltekit/)       | 2.70.3         | `sveltekit()` and `spinetab()` in Vite   |
| [Nuxt](/docs/setup/nuxt/)                 | 4.5.2          | `modules: ["spinetab/nuxt"]`             |
| [React Router](/docs/setup/react-router/) | 7.18.4, 8.4.0  | `reactRouter()` and `spinetab()` in Vite |

Framework integrations support server rendering, hydration, navigation and
subscription cleanup. See each framework's setup guide for configuration.

CommonJS page code is supported with the webpack and Rspack plugins and with
Next.js under both bundlers. Runtime modules remain ESM-only. Yarn Plug'n'Play is
unsupported: the plugins use the project's on-disk `node_modules` layout to resolve
Spinetab and selected peers, and stop with `package-not-installed` when that lookup
fails.

## TypeScript

Use TypeScript 5.7 or later. The declarations use `NoInfer` to keep subscription
payload types tied to their source, and the generic `ArrayBufferView` type for
WebSocket frames. The repository checks the declarations with TypeScript 5.7.3
and 6.0.3. Peer dependencies can have their own compiler requirements.

## Peers

Core has no runtime dependencies. Every peer is optional, and each range starts at
the version used by the package's compatibility checks. Older versions fall
outside the supported peer range.

| Peer                   | Range      | Used by                                     |
| ---------------------- | ---------- | ------------------------------------------- |
| `graphql`              | `^17.0.2`  | `graphql-ws/runtime`, `graphql-sse/runtime` |
| `graphql-ws`           | `^6.3.0`   | `graphql-ws/runtime`                        |
| `graphql-sse`          | `^2.6.1`   | `graphql-sse/runtime`                       |
| `socket.io-client`     | `^4.8.4`   | `socket-io/runtime`                         |
| `@apollo/client`       | `^4.3.1`   | `apollo`                                    |
| `rxjs`                 | `^7.8.2`   | `apollo`                                    |
| `@tanstack/query-core` | `^5.104.0` | `tanstack-query` (types)                    |
| `swr`                  | `^2.5.1`   | `swr` (types)                               |
| `@trpc/client`         | `^11.19.0` | `trpc`, `trpc/runtime`                      |
| `@trpc/server`         | `^11.19.0` | `trpc`, `trpc/runtime` (types)              |
| `ai`                   | `^7.0.116` | `ai-sdk` (types)                            |
| `react`                | `^19.3.0`  | `react`                                     |
| `vue`                  | `^3.5.43`  | `vue`                                       |
| `svelte`               | `^5.57.1`  | `svelte`                                    |
| `solid-js`             | `^1.9.15`  | `solid`                                     |

Unused peers can be absent entirely.

## Module formats and types

- Page entries ship ESM, CommonJS and declarations. Runtime entries (`/runtime`,
  `/worker` and `<capability>/runtime`) are ESM only.
- Spinetab declarations support `strict` and `skipLibCheck: false`. Some peer
  versions have upstream type issues: `@trpc/client` 11.19.0 reports TS2694 errors
  in `@trpc/server`'s `ws` adapter declarations; under `nodenext`,
  `@apollo/client` 4.3.1 reports TS2835 errors in `@wry/caches`. These also occur
  without Spinetab.
- AI SDK 7.0.116 needs its Zod peer, `@types/json-schema` and Node types for strict
  declaration checking; see [AI SDK setup](/docs/integrations/ai-sdk/).
- CommonJS (`node16`) typing of peer-typed entries is not supported: `ai` and
  `solid-js` ship ESM-only types.
- Only `spinetab/react` carries `"use client"`.

## Known restrictions

- **WebKit SharedWorker replacement.** WebKit 26.6 re-initialises a SharedWorker
  when its first client page closes. Spinetab detects the new runtime and reattaches
  at once, reporting continuity `unknown/runtime-replaced`.
- **webpack and Rspack workers.** Their default output uses classic workers and
  `importScripts`. Native module output is also supported; configure CSP for the
  output format you use.
- **CDN asset prefixes** are tested only for Next.js.
- **Vue keepalive.** `<KeepAlive>` retains a cached component's subscription and
  value while it is inactive.
- **Nuxt development restart.** Adding a previously unused adapter can require a
  full dev-server restart. In WebKit 26.6, a reload can retain mismatched Vue
  dependency-cache generations afterwards. Reload with the browser's HTTP cache
  disabled if this occurs.
- **Nuxt type checking.** Nuxt 4.5.2's generated and third-party declarations have
  upstream errors with `skipLibCheck: false`. Its default is `skipLibCheck: true`.
- **Next.js CSP.** Configure [nonces or the required script permissions](https://nextjs.org/docs/app/guides/content-security-policy) for your Next.js deployment.
- **Runtimes.** No Node or React Native runtime; page entries only import safely
  during server-side rendering.
