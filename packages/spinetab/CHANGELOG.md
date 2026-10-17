# Changelog

## [0.2.0](https://github.com/apetta/spinetab/compare/v0.1.0...v0.2.0) (2026-10-17)


### ⚠ BREAKING CHANGES

* **solid:** The optional solid-js peer range changes from ^1.9.15 to ^1.9.17. Solid 1.9.15 and 1.9.16 are no longer supported; applications using spinetab/solid must upgrade solid-js to a version satisfying ^1.9.17.

### Bug Fixes

* **solid:** raise the supported solid-js minimum to 1.9.17 ([85d99b4](https://github.com/apetta/spinetab/commit/85d99b4c6956722edbe3a6d65992c0a3d7d77a35))

## 0.1.0 — 2026-10-04

During 0.x, breaking API changes use a minor version; patch releases remain
backwards-compatible.

### Included

- SharedWorker connection ownership, matching subscription sharing, session
  isolation and lazy per-tab fallback when sharing is unavailable.
- Bounded delivery queues, subscription cleanup, connection recovery and explicit
  continuity status. Applications choose backend replay, a refresh callback or a
  complete-state `latest` policy to recover data missed during an interruption.
- WebSocket, SSE, fetch-stream and polling transports; GraphQL over WebSocket or
  SSE, and Socket.IO protocol adapters.
- Apollo, TanStack Query, SWR, tRPC over WebSocket or SSE, and AI SDK integrations.
  Apollo and tRPC support per-operation reconciliation after recoverable delivery
  gaps. AI stream observation can discover subsequent generations after a gap;
  an interrupted generation remains explicitly interrupted.
- React, Vue, Svelte and Solid bindings, with inert server-side imports and a
  preserved `use client` directive on the React entry.
- Vite, webpack, Rspack, Next.js, Astro and Nuxt build integrations. Generated
  workers are the default; application-owned workers and explicit wiring remain
  available. Framework coverage includes SvelteKit and React Router.
- Isolated subpath exports, optional peers and no library runtime dependencies.
  Page and build entries support ESM and CommonJS; worker/runtime entries use ESM.

### Boundaries and known limitations

- Reconnection restores live delivery; recovering missed events requires backend
  replay or application reconciliation. There is no exactly-once delivery claim,
  application cache or replay backend.
- Mutations, arbitrary commands, AI generation starts and tool actions are never
  automatically replayed.
- Physical mobile suspension is not yet verified.
- tRPC 11.19.0 has an upstream `ws` declaration issue in strict browser-only
  TypeScript projects. Tested versions, its scope and configuration guidance are
  recorded in the
  [compatibility page](https://github.com/apetta/spinetab/blob/main/apps/website/src/content/docs/docs/compatibility.md).
