# Package verification

- Probe installed peer resolution in plain Node with `NODE_PATH` removed;
  the test runner can otherwise resolve workspace dependencies accidentally.
- An upstream dependency may legitimately install an optional peer. Record its
  provenance while still rejecting the unused Spinetab integration from bundles.
- Fix declaration leaks without adding DOM globals to worker checks, hiding
  failures with `skipLibCheck`, or weakening public type narrowing. Use packed
  positive and negative type assertions; reproduce suspected upstream errors
  without a Spinetab import before attributing them to the package.
- Generated-code and sourcemap recognisers need contamination controls, including
  composed/indexed maps. Prove provenance; filename and empty-map exemptions can
  silently admit application code or unselected imports.
- Use `buildDeclarationMaps()` for declaration provenance. Its separate build
  must match candidate declarations byte-for-byte except their own map references;
  reject missing, stale or unrelated evidence. Bundler comments are not provenance.
  Keep declaration maps in test outputs, not the published package.
