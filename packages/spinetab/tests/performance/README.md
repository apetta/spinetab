# Performance checks

Contributor tooling for connection sharing, recovery, memory retention and bundle
size. These checks run separately from the default test suite and CI.

## Running checks

Build the package and harness first:

```sh
pnpm exec turbo run build --filter spinetab --filter @spinetab/harness
```

Keep ports 4500 and 4501 free; the fixture server is shared with browser tests.
Use a fresh run name and keep build watchers stopped during measurements.

Run a functional smoke check:

```sh
SPINETAB_PERF_PROFILE=smoke SPINETAB_PERF_RUN=local-smoke SPINETAB_PERF_REP=01 \
  pnpm --filter spinetab exec playwright test \
  -c tests/performance/playwright.config.ts --grep @smoke
```

Inspect available scenarios with `--list`. The configuration provides
`chromium-perf`, `firefox-functional` and `webkit-functional` projects.

Measure a packed production build:

```sh
pnpm --filter spinetab pack --pack-destination /tmp/spinetab-pack
pnpm --filter spinetab exec node tests/performance/size/measure.ts \
  --run local-size --tarball /tmp/spinetab-pack/spinetab-0.1.0.tgz \
  --work /tmp/spinetab-size
```

Use a fresh work directory. The default measurement covers the scenario catalogue
with Vite and Next.js. `--only` and `--bundlers` narrow the selection; an incomplete
selection exits with status 1 and records the omitted measurements.

## Interpreting results

Generated reports live in git-ignored directories. `budgets.json` defines the
checked metrics and thresholds; the aggregate command summarises a run:

```sh
pnpm --filter spinetab exec node tests/performance/aggregate.ts \
  --run local-smoke
```

Smoke checks validate instrumentation and behaviour. Timing and retained-memory
comparisons require the `pinned` profile, a quiet machine, repeated measurements
and a recorded package archive via `SPINETAB_PERF_TARBALL`. Reports distinguish
eligible measurements, diagnostic results and missing data. Inspect those
qualifications before comparing results or changing a budget.

Source-map-attributed gzip estimates separate Spinetab from peers; they are not
the exact transfer size of an application's complete compressed chunks. Use your
own production build to assess the cost of your selected adapters and peers.
