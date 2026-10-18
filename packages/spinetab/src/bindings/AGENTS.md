# Framework bindings

- Bindings use the application's client. Values belong to each subscriber;
  switching A → B → A or replacing the client must not resurrect old folded data.
- Equivalent feeds and changed callback closures must not resubscribe. Identity
  changes reset the subscription. Consumer options update in place, but the
  reconciliation policy kind stays fixed until the next handle identity.
- Publish React callback refs and imperative handles after commit, then clear
  them on cleanup. Discarded renders must not redirect the visible subscription.
- Keep React, Vue, Svelte and Solid lifecycle semantics distinct. Svelte shares
  subscription/status but keeps per-subscriber folds; unowned Vue use needs disposal.
- Preserve stable SSR/hydration snapshots; `throwOnError` must not throw during SSR.

Changes to `shared/live.ts` need identity/control coverage across all four
frameworks. Use the `dom` project for lifecycle/hydration and unit tests for SSR;
see [test commands](../../tests/AGENTS.md).
