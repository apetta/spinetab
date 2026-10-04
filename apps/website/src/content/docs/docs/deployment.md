---
title: Deployment
description: Serving the worker same-origin, CSP, versioned worker assets across deploys and cross-origin APIs.
---

Spinetab adds no server. Deploying it means serving the worker asset your bundler
emits, with a policy that lets it run and connect.

## Serve the worker from the page's origin

A SharedWorker script must be same-origin with the page. Serve the emitted worker
next to your other assets, with a JavaScript content type.

Serve it with `Content-Type: text/javascript` and
`X-Content-Type-Options: nosniff`. A missing asset, blocked worker or cross-origin
worker URL follows the client's sharing policy:

| Policy             | Outcome                                                                    |
| ------------------ | -------------------------------------------------------------------------- |
| `prefer` (default) | Local mode, with the startup reason in `spinetab.status`                   |
| `require`          | `failed` with `sharing-unavailable` and the same reason; no local fallback |

If your assets are served from a CDN, keep the worker on the page's origin. For
Next.js, `experimental.turbopackWorkerAssetPrefix: ""` does this under an
`assetPrefix`; see [Bundler configuration](/docs/bundlers/#base-paths-and-asset-prefixes).

## Content Security Policy

Spinetab's worker needs only `worker-src 'self'`, without `blob:` or inline
workers. A same-origin production app can start with:

```text
default-src 'self'; script-src 'self'; worker-src 'self'; connect-src 'self';
style-src 'self'; object-src 'none'; base-uri 'self'
```

A worker follows the CSP of its own script response, not the page's. In shared mode
the worker's `connect-src` decides which endpoints it can reach; in local mode the
page's does. Serve the worker script with a `connect-src` that allows your
endpoints, or shared and local mode will behave differently.

Your framework may require additional script permissions. Next.js supports
[nonce-based CSP](https://nextjs.org/docs/app/guides/content-security-policy);
its development server also needs development-specific allowances. Under Trusted
Types, supply an application policy for the worker's same-origin script URL;
Spinetab does not create one.

## New deployments

Bundlers give each build's worker a hashed URL, and the browser runs one
SharedWorker per script URL. After a deploy:

- Tabs still on the old build keep using the old worker; new tabs use the new one.
  Both stay in shared mode.
- The two workers do not merge or terminate each other. Matching subscriptions
  share within each build, so old and new builds may duplicate connections.
- The bridge is versioned. A page that meets a worker speaking a different bridge
  version reports `incompatible-version` and follows its sharing policy.

Keep the hashed worker URL produced by the plugin. Reusing a stable URL can attach
new pages to a worker running older code while another tab keeps it alive.

Keep the previous build's worker asset and its lazy chunk available for a while
after deploying. If an old tab loses its worker and both are gone, it ends in
`failed` with reason `local-runtime-load-failed` under the default sharing policy.
With `sharing: "require"`, the failed worker attachment is reported instead.

## Cross-origin APIs

Endpoints are resolved in the page, against the application's base URL, before they
reach the worker, never against the worker asset directory. Requests from the
worker come from your page's origin, so a cross-origin API needs the same CORS and
cookie configuration it would need for the page:

- For HTTP requests, allow the page's origin through CORS, including required
  headers and credentials if you send cookies. WebSocket servers should validate
  the handshake's `Origin`; WebSocket handshakes do not use CORS preflight.
- For cookies, use `credentials: "include"` on fetch-based options or
  `withCredentials: true` on EventSource and Socket.IO.
- Allow the API origin in `connect-src`, for both the page and the worker script.

Bearer tokens come from the client's `credentials` callback, never from options or
URLs, and go only to origins the worker allows. List a token API's origin in
`credentialOrigins`, in the plugin options or in your worker file's
`defineWorker`, and set `authHeaders: true` on polling, SSE and fetch streams that
call it. See
[Credentials and scopes](/docs/concepts/credentials/#where-tokens-may-go).
