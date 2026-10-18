# Build integrations

- Preserve literal worker URL/import expressions and the `spinetab/wiring` and
  `spinetab/worker-config` seams: bundlers must discover these statically.
- Keep the named `wiring` export for CJS and the `auto/worker` binding guard for
  tree shaking. A bare re-export can produce an empty worker under consumer
  `sideEffects: false`. The missing-config stub throws on call, not import.
- Wiring redirects apply to client builds only. Retain framework config callbacks,
  async results, phases, custom directories and user plugin/hook composition.
- Infer adapters from imports, not comments or string examples. Exclude type-only
  imports/generated output but include linked workspaces; tRPC named imports
  distinguish WS from SSE. Empty inference warns in development and fails
  production; explicit `adapters: []` is intentional.
- Keep adapter mappings, package exports and allow-list tests aligned. Generated
  output uses code-unit ordering, not locale-dependent ordering.

Run affected `tests/unit/build/` tests, package tests and `test:tree-shaking`, then
exercise the affected packed consumer. Next.js has separate Turbopack/webpack
paths; plugin mocks cannot establish either. Commands are in
[the test guide](../../tests/AGENTS.md).
