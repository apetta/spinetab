# SharedWorker

`index.ts` is the ESM-only `spinetab/worker` entry: `serveSharedWorker(runtime)`
over the host in `src/core/host.ts`. Importing it registers nothing; the
application's own worker entry calls it synchronously, before any top-level
await, so the first page's `connect` is never missed. Early ports are buffered
(64) and answered with `startupError` when setup fails or exceeds 10 s.

The bundler plugin generates the worker entry and selects its adapters. An
application can provide its own worker file with `defineWorker`, or wire the
SharedWorker and lazy local runtime explicitly. A worker URL alone cannot provide
fallback. Tests live in `tests/unit/core/worker-host.test.ts` and the browser
suites through `tests/fixtures/harness`.
