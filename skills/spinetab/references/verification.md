# Verify the integration

Use the application's existing checks and browser tooling. Select checks that
exercise the change. Use local or test endpoints for interruption and
authentication scenarios.

## Build and lifecycle

- Run relevant type and build checks. For initial bundler integration, exercise
  both development and the production build: development success alone does not
  establish worker asset loading, CSP or SSR behaviour in production.
- Confirm Spinetab starts no server-side subscription or credential lookup.
  Mount the browser consumer, change its source if supported, then unmount it.
  Check loading/error behaviour and release of the previous subscription.
- Keep the existing data library's providers, queries and mutations working.

## Prove sharing

Open two pages in the same browser context/profile and storage partition. Give
them matching subscription identities and scopes. Inspect client mode and
`runtimeId`, then measure upstream work using server counters or equivalent trusted
instrumentation. A worker-owned socket may not appear in the page's network log.

- Both pages should receive the expected live updates while sharing the upstream
  operation or polling schedule. Two changing UIs alone prove delivery, not sharing.
- Measure connections and subscription operations according to the protocol.
  GraphQL SSE distinct mode uses a response per distinct subscription; polling
  may make an initial catch-up read for a joining consumer. Do not equate every
  request with a duplicate ongoing feed.
- Remove one consumer: the other should continue. Remove the last: upstream work
  should stop after the documented linger/idle delays, not necessarily immediately.
- For new worker wiring, exercise local fallback or sharing-off mode. Per-tab
  work is expected there and should be reported as local, not shared.

## Recovery and private data

For the behaviour being added or repaired, exercise the relevant cases:

- Interrupt and restore the upstream connection. Observe the continuity state
  and prove that the configured replay or refresh restores the application data.
- For deltas, deliver events during a delayed snapshot refresh; ensure an older
  snapshot cannot overwrite newer state. Make a refresh fail and confirm the
  application does not declare recovery complete.
- For private feeds, rotate credentials and switch principal/tenant. Check both
  subscription isolation and removal of the old principal's cached data.
- For resumable AI, verify that another tab follows the same generation without
  issuing a second generation-start request. A late join may need a separate
  HTTP response to replay the generation; that is not another generation.

## Diagnose failures

| Observation                         | First checks                                                                                                                           |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Local mode when sharing is expected | Client mode reason, worker URL/loading, CSP, plugin configuration and browser support.                                                 |
| Shared mode but duplicate work      | `runtimeId`, scope, query/variables/options and worker URL/name. Different deployments or browser partitions can use separate workers. |
| No events or authentication blocked | Server protocol, endpoint, credential declaration/format, `credentialOrigins`, `authHeaders` and credential revision.                  |
| Data diverges after reconnect       | Continuity state, snapshot/replay contract and application ordering; do not hide the loss by restarting the hook.                      |
| Works in development only           | Emitted worker assets, base paths, deployment retention and document/worker CSP.                                                       |

Use [execution modes](https://spinetab.com/docs/concepts/modes.md),
[status](https://spinetab.com/docs/concepts/status.md) and
[deployment](https://spinetab.com/docs/deployment.md) for the relevant diagnosis.

Report build, browser, sharing and recovery evidence separately. If access to a
backend, browser or upstream counters is missing, say which claim remains
unverified rather than treating a passing build as proof.
