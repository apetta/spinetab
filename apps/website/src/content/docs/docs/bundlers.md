---
title: Bundler configuration
description: Configure Spinetab for Vite, Next.js, Astro, webpack or Rspack, including plugin options and manual worker wiring.
---

For your first subscription, choose your app in the
[setup guides](/docs/getting-started/#choose-your-setup). This page covers plugin configuration for all
supported build tools, followed by development behaviour and advanced options.

Add the plugin to your existing config without removing its other plugins or
options. It generates the worker from your `spinetab/<source>` imports and builds
the local fallback as a separate chunk. Server rendering starts no subscriptions.

## Vite

```ts title="vite.config.ts"
import { spinetab } from "spinetab/vite";
import { defineConfig } from "vite";

export default defineConfig({ plugins: [spinetab()] });
```

`vite` and `vite build` emit the worker and the lazy chunk separately. The lazy
chunk is requested only in local mode, once per page.

## Next.js App Router

```ts title="next.config.ts"
import { withSpinetab } from "spinetab/next";

export default withSpinetab({ reactStrictMode: true });
```

`withSpinetab` wraps an object, a function or an async function config, and keeps
your own `turbopack` and `webpack` settings. The same line covers Turbopack, the
default, and `next build --webpack`. Pass plugin options as the second argument:
`withSpinetab(config, options)`. No `transpilePackages`, no
`dynamic(…, { ssr: false })` and no wrapper around Spinetab's exports are needed.

Run `next dev` and `next build` from the project directory. From a monorepo root
(`next dev apps/web`), set `dir` to the directory that holds `next.config`:

```js title="apps/web/next.config.mjs"
import { withSpinetab } from "spinetab/next";

export default withSpinetab({}, { dir: import.meta.dirname });
```

`import.meta.dirname` needs Node.js 20.11 or later. Without `dir`, `next dev`
started from another directory fails with `project-directory-unknown` rather than
planning against the wrong tree.

Use the [Next.js setup guide](/docs/setup/nextjs/) for the client module and
Client Component. Subscription work starts in the browser; server rendering stays
inactive.

### Base paths and asset prefixes

Next.js routes have no trailing slash, so `document.baseURI` on `/app` would
resolve `api/feed` outside the base path. Set the client's `baseUrl` to the base
with a trailing slash, for example `new URL("/app/", location.origin).href`,
computed in the browser.

With `assetPrefix` pointing at a CDN, set
`experimental.turbopackWorkerAssetPrefix: ""` so worker chunks stay on the page's
origin while other assets come from the CDN. Without it, the worker URL is
cross-origin: under the default `sharing: "prefer"` the page falls back to local
mode with a startup reason, and under `sharing: "require"` it fails with
`sharing-unavailable`.

## webpack

```js title="webpack.config.mjs"
import HtmlWebpackPlugin from "html-webpack-plugin";
import { spinetab } from "spinetab/webpack";

export default { plugins: [new HtmlWebpackPlugin(), spinetab()] };
```

Put `spinetab()` beside your HTML plugin, with the default worker settings.
webpack rewrites `type: "module"` and emits a classic worker that loads its chunks
with `importScripts`. Keep `module.parser.javascript.worker` (and
`javascript/esm`) at its default, or include `"..."` or `"SharedWorker"` in a
custom list; otherwise the build stops with `worker-parser-disabled`. CommonJS page
code (`require("spinetab")`) is supported here and on Rspack.

## Rspack

```js title="rspack.config.mjs"
import { rspack } from "@rspack/core";
import { spinetab } from "spinetab/rspack";

export default { plugins: [new rspack.HtmlRspackPlugin(), spinetab()] };
```

Put `spinetab()` beside the built-in `rspack.HtmlRspackPlugin`. Its default output
uses a classic worker and `importScripts`, as webpack does. Both bundlers also
support native module output; see below.

### Native module output

With webpack or Rspack `output.module: true`, the worker loads native ES modules.
The document must load its page entry as a module too. For webpack's
`HtmlWebpackPlugin`, set `scriptLoading: "module"`; Rspack's built-in HTML plugin
sets the module type for module output. Leaving the HTML script in classic mode
can fail on `import.meta` before Spinetab starts.

## SSR frameworks using Vite

For complete walkthroughs, see [SvelteKit](/docs/setup/sveltekit/),
[React Router](/docs/setup/react-router/) or [Nuxt](/docs/setup/nuxt/).

SvelteKit and React Router keep their framework plugin and add `spinetab()` beside
it: `plugins: [sveltekit(), spinetab()]` or
`plugins: [reactRouter(), spinetab()]`. Use the binding for the framework in your
components. Imports and server rendering stay inert; component lifecycle starts
browser work.

Nuxt uses `modules: ["spinetab/nuxt"]` in `nuxt.config.ts`, with the Vue binding.
Pass plugin options through Nuxt's module tuple, for example
`modules: [["spinetab/nuxt", { adapters: ["sse"] }]]`. The module adds the plugin
to the client build and removes resource hints only for Spinetab's worker and lazy
local runtime; application hints remain.

## Astro

For a complete hydrated island, follow the [Astro setup guide](/docs/setup/astro/).

```js title="astro.config.mjs"
import { defineConfig } from "astro/config";
import { spinetab } from "spinetab/astro";

export default defineConfig({ integrations: [spinetab()] });
```

The integration adds the Vite plugin to Astro's client build. Add it by hand:
`astro add` does not support it.

## Options

Every option is optional. Pass them to `spinetab(options)`, or as the second
argument of `withSpinetab`.

- `worker`: your own worker file, relative to the project root. The plugin stops
  generating one. By default, `spinetab.worker.ts` in `src/`, `app/` or the root,
  if present.
- `adapters`: the generated worker's adapters, such as `["polling", "sse"]`. By
  default, inferred from your `spinetab/<source>` imports.
- `credentialOrigins`: origins, besides the page's own, that may receive provider
  credentials; compiled into the generated worker. None by default.

- `dir` (`withSpinetab` only): the absolute path of the Next.js project directory,
  for builds started from another directory.

A worker file cannot be combined with `adapters` or `credentialOrigins`: set them
in `defineWorker` instead. [Custom worker](/docs/your-worker/) covers each option and
the build messages.

## Development

- Adding the first import of a new source regenerates the worker. Vite, webpack
  and Rspack dev servers reload every open tab onto the new worker.
- Under Nuxt, importing the first source of a new adapter can require dependency
  preparation. The plugin logs `adapter-restart-required`: restart the dev server,
  then reload the open tabs. In WebKit, reload with the HTTP cache disabled if Vue
  reports mismatched dependency generations after the restart; see
  [Compatibility](/docs/compatibility/#known-restrictions).
- Under `next dev`, reload the open tabs yourself after adding a new source: they
  keep the running worker until they reload.
- Creating or deleting `spinetab.worker.ts` switches between the generated worker
  and yours: restart the dev server. The Vite plugin logs `restart-required`. Under
  `next dev`, reload the open tabs after editing or deleting the worker file, or
  restart `next dev` after adding or removing it.
- `vite build --watch` decides the adapters when it starts. After adding the first
  import of a new Spinetab source, restart the watch build.
- In development the worker carries a `name` that changes with its content, so a
  stale worker is never reused. With your own worker file, the name covers the
  worker file only, not modules it imports. Production builds keep no `name`.

## Base paths

| Bundler | Base path setup                                                           |
| ------- | ------------------------------------------------------------------------- |
| Vite    | `base` in the Vite config                                                 |
| Next.js | `basePath`, plus `baseUrl` on the client                                  |
| webpack | The default `publicPath: "auto"`, with the same build served under a path |
| Rspack  | As webpack                                                                |

Relative endpoints resolve against the application base in both shared and local
mode, never against the worker asset directory. Keep the worker on the page's
origin even when other assets use a CDN. The Next.js recipe above has a dedicated
worker asset-prefix setting.

## Content Security Policy

Allow the worker and its endpoints in your deployment's CSP. See the
[deployment guide](/docs/deployment/#content-security-policy) for a starting policy
and the distinction between page and worker headers.

## Wire it by hand

If your bundler recognises `new SharedWorker(new URL(..., import.meta.url))`,
you can wire the worker and local fallback directly:

```ts title="spinetab.worker.ts"
import { pollingAdapter } from "spinetab/polling/runtime";
import { defineWorker } from "spinetab/worker";

export default defineWorker(() => [pollingAdapter()]);
```

```ts title="live.ts"
import { createSpinetab } from "spinetab";

export const spinetab = createSpinetab({
  worker: () =>
    new SharedWorker(new URL("./spinetab.worker.ts", import.meta.url), {
      type: "module",
    }),
  local: () => import("./spinetab.worker"),
});
```

The bundler sees two literals: the `new SharedWorker(new URL(…))` expression, which
emits the worker, and the `import("./spinetab.worker")`, which emits the same
module as a lazy chunk. A tab that shares never downloads that chunk.

- Put `new URL(…, import.meta.url)` directly inside the constructor. webpack and
  Rspack do not follow a URL held in a variable.
- Keep the options literal. Do not wrap the expression in a helper.
- A worker `name` is optional. If you add one, make it a literal and use the same
  name on every page: pages with different names run separate workers.
- Keep the worker on the page's origin. See [Deployment](/docs/deployment/).
- Under Next.js, this recipe publishes the referenced worker source file under
  `/_next/static/media`. With the plugin, only a stub is copied there.

Passing either `worker` or `local` opts that client out of the plugin's wiring
entirely. Remove the plugin when no client uses its generated wiring.

## Separate files

For async worker setup, a custom runtime or tests, serve the runtime yourself and
give the client a separate local module. Remove the plugin for this recipe: it
takes `spinetab.worker.ts` as your worker file and fails the build with
`worker-file-no-default`, because this file has no default export.

```ts title="spinetab.worker.ts"
import { pollingAdapter } from "spinetab/polling/runtime";
import { createRuntime } from "spinetab/runtime";
import { serveSharedWorker } from "spinetab/worker";

serveSharedWorker(() => createRuntime({ adapters: [pollingAdapter()] }));
```

```ts title="live.local.ts"
import { pollingAdapter } from "spinetab/polling/runtime";
import { createRuntime } from "spinetab/runtime";

export default () => createRuntime({ adapters: [pollingAdapter()] });
```

Point `local` at `import("./live.local")`. Call `serveSharedWorker` synchronously,
before any top-level `await`, so the first tab's connection is never missed. Call
`serveSharedWorker` or `defineWorker` once per worker: serving twice turns every
page away with `worker-startup-error`.

See [compatibility](/docs/compatibility/#bundlers) for supported build tools.

## Adapter inference

The plugin scans application source and linked workspace packages that use
Spinetab. An import can select an adapter even if the file is not reachable from
your current page. Type-only imports, comments, tests, stories and build output
are normally excluded.

Inference is a source scan, not a full TypeScript or template compiler. Unusual
syntax can add an unused adapter or miss an import. A `scan-fallback` warning
means the scanner could not finish parsing part of a file and included every
Spinetab entry named there.

For a predictable adapter set, configure it explicitly:

```ts
spinetab({ adapters: ["polling", "graphql-ws"] });
```

This **replaces** inference. Include every adapter your app uses. The available
names are `polling`, `sse`, `stream`, `websocket`, `graphql-ws`, `graphql-sse`,
`socket-io`, `trpc-ws`, `trpc-sse` and `ai-sdk`.

If an adapter is missing, Vite, webpack and Rspack usually report
`adapter-not-generated` in production builds. Some cases, including Turbopack,
reach the browser as `adapter-not-registered`. Add the adapter to the list, or
register it in a custom worker, then restart the dev server or rebuild.
