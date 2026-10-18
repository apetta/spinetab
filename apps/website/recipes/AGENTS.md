# Copyable recipes

These files become consumer source and are excluded from website type checking.
A passing Astro check does not establish recipe compatibility.

- `../src/recipes/files.ts` assembles destination files and dependencies;
  `catalogue.ts` defines combinations. Check the assembled layout before changing
  imports: it differs from the source directory layout.
- Keep catalogue constraints, dependencies and snippets consistent. Preserve
  existing host plugins, providers and server/client boundaries in recipes.
- `reconcile: "latest"` assumes replacement state; delta streams need an explicit
  merge/refresh contract.

Website tests check assembly, not execution. Validate executable changes using
an affected packed-consumer fixture; see
[the library test guide](../../../packages/spinetab/tests/AGENTS.md).
