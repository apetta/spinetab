# Library tests

Run commands from the repo root. Test paths are package-relative.
Cover shared behaviour in core and integration policy at its boundary; avoid
multiplying every network fault by every framework.

| Change                     | Starting check                                        |
| -------------------------- | ----------------------------------------------------- |
| Core/build/builder logic   | `pnpm --filter spinetab test:unit <test-path>`        |
| Protocol/server behaviour  | `pnpm --filter spinetab test:integration <test-path>` |
| Framework lifecycle/cache  | `pnpm --filter spinetab test:dom <test-path>`         |
| Exports/declarations/peers | Build, then `pnpm --filter spinetab test:package`     |
| Browser behaviour          | `pnpm exec turbo run e2e --filter=spinetab`           |

- Unit/integration/dom projects alias selected imports to source; package tests
  read `dist/`. Normal `test` excludes consumer and tree-shaking suites.
- Turbo builds the browser harness; direct package `e2e` expects it already built.
  Fixture counters are global, so suites use one worker and serial files. Avoid
  concurrent suites sharing servers/ports.
- SharedWorker evidence needs server-counted work and runtime identity, not just
  matching UI. Recovery must deliver newer events, not merely become `connected`.
  Report which browsers actually ran.
- When a test assumes recovery has settled, await the relevant acknowledgement;
  `connected` alone may be premature. Use one-shot faults when only the original
  connection should fail: clearing a persistent fault can race its replacement.
- `tests/package/fixtures/generated/*.txt` are upstream-output test inputs,
  not disposable build output.

## Packed consumers

`.github/actions/verify-consumers/action.yml` is the canonical pipeline. Locally,
run these package scripts in order with `pnpm --filter spinetab <script>`:
`build`, `test:tree-shaking`, `consumers:prepare`, `test:consumers`, `e2e:consumers`.
Run `consumers:matrix` when producing the compatibility report.

- Consumers install outside the repo to expose missing peers. Keep
  `SPINETAB_CONSUMERS_DIR` outside project ancestors.
- Do not rebuild `dist/` between preparation and verification; evidence is tied
  to that archive. Re-prepare after changes.
- `consumers:prepare --only <name>` filters installation, not subsequent suites.
  Filter later tests explicitly and prepare all cells they require.
- Matrix records must match the current candidate/run and actual executed
  projects. Test inventories and historical green rows are not execution evidence.
- Use `SPINETAB_CONSUMERS_UPDATE_LOCK=1` only for intentional lockfile updates.
- Routine package PRs check packed builds/declarations/isolation; the longer
  packed-browser matrix runs through release/manual verification.
