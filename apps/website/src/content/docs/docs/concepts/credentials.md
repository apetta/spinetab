---
title: Credentials and scopes
description: Supply credentials, separate users with scopes and choose which API origins may receive tokens.
---

Configure authentication on the client. Use a different `scope` for each user or
tenant whose subscriptions must stay separate:

```ts title="live.ts"
import { createSpinetab } from "spinetab";

export const spinetab = createSpinetab({
  scope: "user:42", // Replace with your signed-in user's identity.
  credentials: async ({ signal }) => ({
    headers: { Authorization: `Bearer ${await getAccessToken({ signal })}` },
  }),
});
```

`getAccessToken` is your app's token lookup or refresh function. The worker asks a
tab for credentials and keeps them in memory. It does not refresh tokens itself.

For a public API or a cookie session, use `anonymous: true` instead of
`credentials`. This means **no Spinetab-supplied token**, not "no cookies".
Cookies still follow the endpoint's cookie mode. These two options cannot be
combined.

## Choose the credential format

| Return key         | Used by                                                                                                   |
| ------------------ | --------------------------------------------------------------------------------------------------------- |
| `headers`          | Polling, SSE, fetch streams, GraphQL over SSE and AI SDK; tRPC over SSE with a header-capable EventSource |
| `connectionParams` | GraphQL over WebSocket, tRPC over WebSocket and a custom WebSocket protocol's `authenticate` hook         |
| `auth`             | Socket.IO                                                                                                 |

Return `{ headers?, connectionParams?, auth? }` with the keys your adapters need.
For example, a GraphQL WebSocket server that reads a `token` field needs
`{ connectionParams: { token } }`. Unsupported keys or invalid headers block the
connection with `credentials-missing`.

Protocol adapters require `credentials` or `anonymous: true`. Polling, SSE and
fetch streams can read without either, using their normal cookie settings and no
provider headers.

## Where tokens may go

Provider credentials are allowed on the worker's own origin. To allow another
origin, configure the generated worker through the plugin:

```ts title="vite.config.ts"
import { spinetab } from "spinetab/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [spinetab({ credentialOrigins: ["https://api.example.com"] })],
});
```

With a [custom worker](/docs/your-worker/), set `credentialOrigins` in
`defineWorker` instead. Configuring it in both places is a build error.

- Use exact `https:` origins without paths, queries, fragments or user information.
  `https://api.example.com` also permits `wss://api.example.com`.
- Subdomains and different ports are separate origins.
- Credentials require HTTPS or WSS, except on loopback hosts during local
  development. A worker served from loopback accepts other loopback origins.
- The allow-list is built into the worker. A page cannot widen it at runtime.
  Deploy a new worker for changes to take effect.

Polling, SSE and fetch streams attach provider headers automatically only for
same-origin requests. For an API on a listed origin, also opt in on the source:

```ts
const queue = polling<Queue>("https://api.example.com/queue", {
  authHeaders: true,
});
```

Use `authHeaders: false` to omit provider headers for a public HTTP endpoint.
Protocol builders accept `anonymous: true` for the equivalent choice.

For cross-origin cookies, configure the API's CORS policy and use
`credentials: "include"` on fetch-based sources, or `withCredentials: true` on
EventSource and Socket.IO. See [deployment](/docs/deployment/#cross-origin-apis).

## Refresh credentials

After your app refreshes its token, increase the revision. Set `restart: true`
when an open connection must authenticate again:

```ts
spinetab.setCredentialRevision(2, { restart: true });
```

A revision is a non-negative safe integer. Without `restart`, new credentials
apply to the next connection or unblock one waiting for credentials. A revision
rejected by the server is not reused.

## Scopes

Switch scope when the signed-in user or tenant changes:

```ts
spinetab.setScope(`tenant:${tenantId}`, 1);
```

Subscriptions using the client's scope restart in the new scope with continuity
`unknown/scope-changed`. Subscriptions explicitly pinned to the old scope end
with `scope-changed`. Old-scope delivery stops before new-scope delivery starts.

Calling `setScope` for the current scope with a new revision also restarts its
subscriptions. Use `setCredentialRevision` to rotate a token without changing the
principal.

Within a scope, tabs can use credentials supplied by any tab in that scope.
An anonymous client and a client with a credential provider stay separate.
Use distinct scopes for distinct principals, and clear or replace your
application cache when the principal changes. Spinetab does not clear Apollo,
TanStack Query or SWR caches.

## Authentication failures

| Situation                                             | Outcome                             | Action                                                         |
| ----------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------- |
| A protocol has no credential declaration              | `auth-blocked/no-credential-source` | Supply `credentials` or declare `anonymous: true`.             |
| The provider fails or times out                       | `auth-blocked/credentials-missing`  | Fix the provider, then call `retry()` or advance the revision. |
| The server rejects credentials (for example HTTP 401) | `auth-blocked/credentials-rejected` | Refresh the token and advance the revision.                    |
| The server forbids the request (for example HTTP 403) | `failed`, code `forbidden`          | Check server permissions.                                      |
| A token would go outside the allowed origins          | `auth-blocked/credentials-audience` | Correct `credentialOrigins` and deploy the worker.             |

A request with `authHeaders: true` to a disallowed origin, or from an anonymous
client, fails earlier with `unsupported-option`. A provider failure never falls
back to an anonymous request. Native EventSource cannot expose HTTP status codes;
see the [SSE mode restrictions](/docs/transports/sse/#modes).

## Credential handling

Keep secrets in the `credentials` callback. Token-like URL parameters and static
credential headers, including `Authorization` and `Cookie`, are rejected. Token
fields in static `connectionParams` or `auth` are rejected too. Requests carrying
provider headers do not follow redirects.

These checks catch common mistakes; your origin and server remain the security
boundaries. A scope is not access control against other scripts on the same
origin. Cookies belong to the browser session, so scopes cannot give tabs
independent cookie sessions.

### Credential requests

The worker asks the most recently active eligible tab, waits up to five seconds,
and tries at most three tabs. It caches credentials for the current revision and
asks again after rotation or an explicit credential retry. The callback receives
`scope`, `revision`, `reason` and an abort `signal`.

Credentials are released when no remaining connection can use them, or when the
scope's last page leaves. They are not written to storage or included in request
identity or diagnostics.
