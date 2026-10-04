# Core

Framework-independent page client, runtime engine and bridge. Page code
(`client`, `attachment`, `lifecycle`, `local`, `status`, `url`) never imports the
runtime engine (`runtime`, `broker`, `bounds`, `host`); both share the bridge
envelope module, identity, estimation, limits, errors and the store. Adapters and
protocol clients stay out of core, and nothing registers or starts at import time.

The same runtime serves the SharedWorker entry (`src/worker`) and the lazily
loaded local runtime over a `MessageChannel`, so both modes share one contract.
The runtime announces itself on every port it accepts; a page whose port an engine
moves to a new runtime instance (WebKit re-initialises a SharedWorker when its
first client page closes) reattaches at once instead of at its next heartbeat.
`status` holds the referentially constant snapshots the bindings share;
`bounds` holds the size policy for control-path content. Tests live in
`tests/unit/core`, `tests/integration/core` and `tests/browser/core-*.spec.ts`.
