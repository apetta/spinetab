# Website

Static Astro/Starlight with React demos; consumes the built workspace package.
Paths below are website-relative.

- Edit source, not generated Markdown or `llms.txt`. The exporters in
  `src/integrations/` derive these from built pages. Essential content must survive
  without the visual UI; `data-markdown-exclude` is for decoration only.
- Keep agent instructions out of `public/`, `src/pages/` and `src/content/docs/`:
  those directories publish their contents.
- Use existing cream/purple tokens and SVG icons. Verify UI changes with
  agent-browser across themes, narrow layouts, keyboard use and reduced motion.
- Keep decorative interactions in Astro/DOM scripts rather than adding hydration.
  Pointer effects should schedule frames on demand and stop work when idle.

From the repo root, run
`pnpm exec turbo run build typecheck test --filter=website`.
After building, run affected E2E checks with `pnpm --filter website e2e`:
`--project=content` for exports/HTTP contracts, or `e2e/shell.spec.ts`,
`e2e/recipes.spec.ts`, `e2e/examples.spec.ts` for the relevant UI.

Tests inspect/serve `dist/`, so rebuild first. Playwright uses Wrangler Pages
(port 4322) to apply `public/_headers`; Astro preview is not equivalent.
`WEBSITE_TEST_PORT` changes the port; `WEBSITE_TEST_URL` targets an existing server.
