# Library

[README.md](README.md) is the public API reference. Paths below are package-relative.
Keep plugin setup as the simple path, with custom workers and explicit wiring
available for applications that need control.

- Page, worker/local runtime and Node build imports are separate realms, enforced
  by `tests/package/allowlist.ts`. Keep imports inert and optional peers isolated.
- Export changes must agree across `package.json`, `tsdown.config.ts`, declarations
  and package tests. Page/build entries support ESM/CJS; runtime entries are ESM-only.
- Explicit `worker` or `local` disables automatic wiring. A worker URL alone
  does not provide fallback. Call `defineWorker()` synchronously before top-level
  await; it returns a local factory but registers only in a SharedWorker global.
- Requests crossing the bridge must be cloneable. Functions stay in worker
  configuration and are selected by name. Builders accept relative URLs;
  runtime validation expects resolved absolute URLs.
- Failed credential lookup must not fall back to anonymous networking. Check
  audiences on requests/redirects; 401 rejects the attached grant, while 403 is
  permanent failure. Anonymous mode still permits ambient cookies.
- Recovery differs by transport. Reconnection is not replay, and commands with
  unknown outcomes cannot safely be retried. Preserve explicit retry ownership.
- Scope transport hook failures to their owning subscription or connection;
  failed unsubscribe/cleanup must not terminate healthy sibling subscriptions.

Use [tests/AGENTS.md](tests/AGENTS.md) to choose source, browser and packed-package
checks. Build/export changes need artefact evidence, not only source mocks.
