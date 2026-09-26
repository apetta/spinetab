# Spinetab

One npm package for sharing live subscriptions across browser tabs and recovering
after interruptions, plus a public website with embedded examples.

This repository is a scaffold: the package entry points are empty and the
example only demonstrates React interactivity. Runtime behaviour is not implemented.

## Structure

```text
apps/website/          Astro + Starlight documentation and embedded React demos
packages/spinetab/     The npm library, including bindings and adapter subpaths
packages/typescript/  Private shared TypeScript presets
```

Only `spinetab` is intended for publication. It remains private until a working
release is ready. Future demo backend code belongs in the website; no separate
example apps or services are needed.

## Getting started

Use Node 24.11+ and pnpm 10.24.0:

```sh
pnpm install
pnpm dev
```

The website runs at `http://127.0.0.1:4321`. Turbo builds the library before
starting the website and library watcher. No environment files or Git hooks are
required. The website consumes the built package through `workspace:*`.

## Commands

| Command          | Purpose                                                              |
| ---------------- | -------------------------------------------------------------------- |
| `pnpm dev`       | Start the website and library watcher                                |
| `pnpm build`     | Build the library and static website                                 |
| `pnpm check`     | Check formatting, lint and imports                                   |
| `pnpm check:fix` | Apply Biome's safe fixes and Prettier formatting                     |
| `pnpm format`    | Format code with Biome and documentation/configuration with Prettier |
| `pnpm typecheck` | Check TypeScript and Astro                                           |
| `pnpm test`      | Build the library and run Vitest                                     |
| `pnpm e2e`       | Build the website and run Playwright against its preview             |

Before the first browser test run:

```sh
pnpm --filter website exec playwright install
```

Browser tests start their own preview on port 4322 and cover Chromium, Firefox
and WebKit. Current tests check package export resolution, website navigation
and React hydration. They do not prove connection sharing or recovery behaviour.

CI runs the same checks:

```sh
pnpm check
pnpm exec turbo run typecheck test e2e
```

CI uses the monorepo's Playwright container setup, with browsers and system
dependencies included. Keep its image tag aligned with the website's
`@playwright/test` version.

## Contributing

- Biome formats and lints code, including package manifests. Astro
  support is experimental; `astro check` supplies additional diagnostics.
- Prettier formats Markdown, MDX and YAML only. `.prettierignore` keeps its scope
  separate from Biome and excludes generated files and the lockfile.
- Commit the pnpm lockfile. CI installs it with `--frozen-lockfile`.
- Keep integrations within the single library package. Add optional peers and
  runtime tests as their implementations arrive.
- CI enforces checks; contributors do not need Git hooks or a particular editor.

The library owns subscription transport and coordination; application state,
caches and backend replay remain outside its scope. Set Astro's `site` URL when
choosing the public host.
