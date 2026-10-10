# Spinetab

Share live subscriptions across browser tabs with a SharedWorker. Spinetab manages
connection sharing, subscription cleanup and recovery, with a per-tab fallback
when sharing is unavailable. Your application keeps control of its data and cache.

Use your existing HTTP, WebSocket or protocol endpoints. Optional integrations
connect Spinetab to Apollo, TanStack Query, SWR, tRPC and AI SDK; bindings cover
React, Vue, Svelte and Solid.

Spinetab is maintained by agents.

## Install

```sh
pnpm add spinetab
```

Add the bundler plugin, create one client and subscribe. The
[quick start](packages/spinetab/README.md#quick-start) walks through a polling feed
in an existing Vite app. See the
[framework guides](apps/website/src/content/docs/docs/frameworks.md) for Next.js,
Astro, Nuxt, SvelteKit and React Router setup.

- [Package API and configuration](packages/spinetab/README.md)
- [Documentation](apps/website/src/content/docs/docs)
- [Compatibility](apps/website/src/content/docs/docs/compatibility.md)
- [Release notes](packages/spinetab/CHANGELOG.md)

Reconnection restores live delivery. Recovering missed events requires backend
replay or application reconciliation; there is no exactly-once delivery guarantee.

During 0.x, breaking API changes use a minor version; patch releases remain
backwards-compatible.

## Repository structure

```text
apps/website/          Astro + Starlight site: documentation and landing page
packages/spinetab/     The library: page, worker, runtime and build entries, adapters, bindings, tests
packages/typescript/   Private shared TypeScript presets
```

`packages/spinetab/tests/fixtures/harness` is a private workspace used only by the
library's browser tests. The website consumes the built package through
`workspace:*`, never source aliases.

## Development setup

Use Node 24.11+ and pnpm 10.24.0:

```sh
pnpm install
pnpm dev
```

The website runs at `http://127.0.0.1:4321` (documentation under `/docs/`). Turbo builds the library before
starting the website and the library watcher. No environment files are required.
`pnpm install` also installs the repository's Git hooks.

## Commands

Run from the repository root:

| Command          | Purpose                                                                 |
| ---------------- | ----------------------------------------------------------------------- |
| `pnpm dev`       | Start the website and library watcher                                   |
| `pnpm build`     | Build the library and static website                                    |
| `pnpm check`     | Check formatting, lint and imports                                      |
| `pnpm check:fix` | Apply Biome's safe fixes and Prettier formatting                        |
| `pnpm format`    | Format code with Biome and documentation/configuration with Prettier    |
| `pnpm typecheck` | Check TypeScript and Astro                                              |
| `pnpm test`      | Build the library and run its unit, integration, DOM and package suites |
| `pnpm e2e`       | Run the library and website browser suites                              |

Validation tooling in the library, run with `pnpm --filter spinetab run <script>`:

| Script              | Purpose                                                             |
| ------------------- | ------------------------------------------------------------------- |
| `consumers:prepare` | Pack the library and prepare out-of-tree consumer applications      |
| `test:consumers`    | Install, build and type-check the packed package in those consumers |
| `e2e:consumers`     | Run the consumer applications in browsers                           |
| `test:tree-shaking` | Verify unused-export removal and production worker retention        |
| `perf`              | Run the Playwright performance scenarios                            |

`perf:sizes`, `perf:aggregate` and `consumers:matrix` summarise their results. These
scripts are not part of `pnpm test` or routine CI. A manually dispatched CI run
also verifies tree shaking and packed consumer applications. Run the library
build before `test:tree-shaking`; it packs that build and checks Vite, webpack,
Rspack and Next.js (Turbopack and webpack).

Before the first browser test run:

```sh
pnpm --filter website exec playwright install
```

## Testing

The test suites cover core behaviour, real protocol integration, framework
bindings, package exports and browser recovery. Packed consumer applications
exercise installation, bundling, SSR and lifecycle behaviour in supported
frameworks. Browser checks run in Chromium, Firefox and WebKit.

See the [compatibility guide](apps/website/src/content/docs/docs/compatibility.md)
for tested versions and known restrictions. Test fixtures live under
`packages/spinetab/tests`; generated reports are ignored by Git.

## Continuous integration

CI runs in Microsoft's Playwright container, whose image tag matches
`@playwright/test` (1.63.0), as a non-root user with
`PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`:

```sh
pnpm install --frozen-lockfile
pnpm exec biome ci .
pnpm exec prettier --check .
pnpm exec turbo run typecheck test e2e
```

Keep the image tag, the `@playwright/test` versions and the browser path aligned
when upgrading Playwright. CI uploads the library's and the website's Playwright HTML
reports as artefacts, and the raw test output when a run fails.

## Contributing

- Biome formats and lints code, including package manifests. Astro support is
  experimental; `astro check` supplies additional diagnostics.
- Prettier formats Markdown, MDX and YAML only. `.prettierignore` keeps its scope
  separate from Biome and excludes generated files and the lockfile.
- Commit the pnpm lockfile. CI installs with `--frozen-lockfile`.
- Keep adapters, integrations and bindings inside the single library package, each
  behind its own subpath. Pin each optional peer range to the version it is tested
  against.
- Run `pnpm check` and `pnpm exec turbo run typecheck test e2e` before opening a
  pull request. CI enforces them.
- Pre-commit formats and lints staged files. Pre-push checks formatting and lint,
  then builds, type-checks and tests the workspace. Browser E2E runs in CI.

Application state, caches, backend replay and server helpers are outside the
library's scope.
