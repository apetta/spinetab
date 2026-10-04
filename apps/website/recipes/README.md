# Recipe source files

These files are the source of the documentation's resolved recipes. `src/recipes/files.ts` selects and places them; it does not rewrite their code. The same files are assembled into isolated consumer apps for validation. Framework starters and a backend matching each recipe's stated contract are prerequisites.

Do not import these examples into the website runtime. Each example compiles in its own framework/peer context, not against the documentation site's dependencies. When adding a recipe, update the catalogue and verify it in a standalone app with the stated framework and dependencies. Check both the development server and a production build against an endpoint matching its contract.
