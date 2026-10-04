---
title: Binding API
description: Every function, option and return value of the React, Vue, Svelte and Solid bindings, with server rendering rules.
---

The bindings start and stop subscriptions with each framework's lifecycle. Values
are held for the current mount; a configured `reconcile` policy can refresh your data. [Using subscriptions](/docs/frameworks/) shows the
short path; this page is the reference.

| Framework | Import            | Bound with `bindClient`                                                    |
| --------- | ----------------- | -------------------------------------------------------------------------- |
| React 19  | `spinetab/react`  | `useLive`, `useSubscription`, `useSubscriptionStatus`, `useSpinetabStatus` |
| Vue 3.5   | `spinetab/vue`    | `useLive`, `useSubscription`, `useSpinetabStatus`                          |
| Svelte 5  | `spinetab/svelte` | `liveStore`, `subscriptionStore`, `statusStore`                            |
| Solid 1.9 | `spinetab/solid`  | `createLive`, `createSubscription`, `createSpinetabStatus`                 |

## `bindClient(spinetab)`

Returns the functions in the table with the client applied. It creates no
provider or context, keeps no module-level state and starts nothing. Call it in
the client module, `live.ts`. Unbound subscription and client-status functions take the client first, for
example `useLive(spinetab, source, options)`. React's
`useSubscriptionStatus(subscription)` takes a subscription handle in both forms.

## Sources

Value and subscription functions take a source: a feed such as `polling<T>(url)`, or a request such
as `feed.subscription<T>({ event })`. A GraphQL or Socket.IO endpoint is not a
source; pass `endpoint.subscription(…)`.

- `null`, `undefined` or `false` disables the subscription.
- React, Vue and Solid compare a source by canonical identity, so an equivalent builder result
  created on each render does not resubscribe. A Svelte store is tied to the source it
  was created with; see Svelte below.
- Vue accepts a ref or getter of the source and of the options. Solid accepts a
  value or an accessor for both.

## Options

Every option is optional.

| Option         | On          | Meaning                                                                                                                                               |
| -------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `consumer`     | All         | Per-consumer adapter options, for example `...pollEvery(30_000)` from `spinetab/polling`. A change updates in place                                   |
| `resume`       | All         | A hook that forwards a cursor when intent is re-registered                                                                                            |
| `reconcile`    | All         | `"latest"` for a full-state feed, or a refresh function `(context) => Promise<void>` that resolves once your data is refreshed and rejects on failure |
| `throwOnError` | All         | Send terminal errors to the framework's error boundary; see the framework-specific behaviour below                                                    |
| `initial`      | Value hooks | The value before the first event, and after the source or client changes or a principal change (`setScope`)                                           |
| `map`          | Value hooks | `(event, meta) => value`. Default: the event                                                                                                          |
| `reduce`       | Value hooks | `(current, event, meta) => value`. Returning `undefined` leaves the value unchanged                                                                   |

In React, Vue and Solid, changing the policy kind (`"latest"`, a function or no
policy) takes effect when the source or client next changes. Within a function
policy, a new callback takes over immediately; removing it retains the previous
callback until resubscription. Svelte stores keep the options they were created
with; create a new store to change the policy.

`map` and `reduce` cannot be combined. A changed or removed `consumer` calls
`subscription.update()` and never resubscribes; a structurally equal one does
nothing. `reconcile` runs the core engine: `"latest"` uses `reconcileLatest`, and a
function uses `reconcileOnLoss`, calling your newest function each time. The
engine trusts the promise: a refresh that resolves on failure, such as
`invalidateQueries` or key-only `mutate(key)`, declares lost events recovered. See
[Continuity](/docs/concepts/continuity/).

## Value hooks

`useLive`, `liveStore` and `createLive` return:

| Field            | Meaning                                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `data`           | The current value for this mount, or `initial`                                                                                        |
| `error`          | A subscription error, `upstream-error` for a failed connection, or `continuity-lost` while a loss without `reconcile` is unreconciled |
| `status`         | The subscription's `SubscriptionStatus`                                                                                               |
| `needsReconcile` | `summariseStatus(status).needsReconcile`: `data` may be incomplete                                                                    |
| `subscription`   | The live handle, or `null` while disabled, on the server or before the effect ran                                                     |
| `markReconciled` | `subscription.markReconciled(options?)`; accepts `{ pending: true }`, ignores other arguments                                         |
| `retry`          | Retries this subscription's connection only                                                                                           |

The value is held for one mount and dropped on unmount. A later mount starts at
`initial`. Read `needsReconcile` alongside `data`: a value can still be present
while events are missing. Svelte's `liveStore` holds one value per store subscriber.

A failed connection keeps the subscription's intent so `retry()` can try again.
Its `upstream-error` clears when the connection leaves `failed`; inspect
`status.connection.reason` and `status.connection.code` for the cause.
`throwOnError` also sends a failed connection to the framework's error boundary.
Authentication blocks and exhausted retries stay resumable status states.

## Subscription hooks

`useSubscription`, `subscriptionStore` and `createSubscription` take
`(source, observer, options?)`. The observer is a function that receives each
event and its metadata, or an object `{ next, error?, complete?, status? }`.
React, Vue and Solid read callbacks at call time, so a new closure does not
resubscribe. Svelte stores keep the observer passed at creation.

They return `status`, `subscription`, `markReconciled` and `retry`, as the value
hooks do, without `data`, `error` or `needsReconcile`. Vue and Solid also return
`dispose()`.

A Svelte store's value is the status (or, for `liveStore`, the `data`, `error`,
`status` and `needsReconcile` fields). `subscription`, `markReconciled`, `retry`
and `update(consumer)` are properties of the store itself.

Without an `error` hook and without `throwOnError`, a terminal error is reported
once through the client's `onCallbackError`, else `reportError`.

## Client status

`useSpinetabStatus`, `statusStore` and `createSpinetabStatus` return the client's
`ClientStatus`: `mode`, `reason`, `health` and the rest. See
[Execution modes](/docs/concepts/modes/).

## Per framework

### React

- Work starts in effects. Status uses `useSyncExternalStore` with a constant
  server snapshot.
- A render with a new source or client, or a return to an earlier source, returns
  `initial` in that same render.
- When `<Activity>` hides and reveals the component (including Next.js
  back-navigation with Cache Components), the subscription is re-created: the
  value is `initial` until the next event.
- `throwOnError` throws on the render after the error, for the same subscription
  only, so an error boundary catches it; an error that arrives with a source or
  client change is dropped.
- Strict Mode remounts settle at one upstream subscription per identity.

### Vue

- In a component, work starts in `onMounted`, never during server rendering. In an
  `effectScope()` it starts at once in the browser.
- Cleanup runs through `onScopeDispose`. Outside any scope the composables warn in
  development, and you call `dispose()` yourself.
- Results are refs. `throwOnError` throws from a watcher, so `onErrorCaptured`
  and `app.config.errorHandler` receive it.
- `status` and `subscription` follow the rendered source: after a source change
  they are inactive and `null` until the watcher resubscribes, and
  `markReconciled` and `retry` do nothing until then.
- `dispose()` and scope disposal drop the value.

### Svelte

- Stores follow the store contract; read them with `$store`. The first subscriber
  starts the subscription and the last one releases it.
- A store is tied to one source and its options. Every re-run of the `$derived`
  that builds a store creates a new store: a new subscription and a fresh value,
  even for the same source. Derive the identity's primitives first and build the
  store from those only:

  ```svelte
  <script lang="ts">
    let { params } = $props();
    const room = $derived(params.room);
    const live = $derived(liveStore(feed(room)));
  </script>
  ```

  Reading `params.room` inside the store's `$derived` restarts the value whenever
  any field of `params` changes.

- `throwOnError` makes the store's value throw when a field is read, so
  `<svelte:boundary>` receives it.

### Solid

- Work starts in `createEffect`, never during server rendering or hydration.
  Cleanup runs through `onCleanup`.
- Results are accessors. Without an owner, the primitives warn in development and
  you call `dispose()` yourself.
- `status` and `subscription` follow the rendered source, also in a render effect
  that runs before the resubscribe. Disposal drops the value.
- `throwOnError` throws from an effect, so `ErrorBoundary` receives it.

### Every framework

- After `setScope`, every value hook restarts at `initial` until the new
  principal's next event.
- Value hooks report stopped delivery through `error` and `needsReconcile`, not
  through `reportError`.
- Vue, Solid and Svelte take the client once. To change clients, re-create the
  component (Vue `key`, Solid `<Show keyed>`) or the store.

## Server rendering

Page entries can be imported during server rendering without starting browser
work. Client-status functions use `SERVER_STATUS` for the server snapshot.
Subscription functions use an inactive `SubscriptionStatus`, with no value beyond
`initial`, until their browser lifecycle starts.

Each binding exports this subscription snapshot as `INACTIVE_STATUS`. The core
`spinetab` export with the same name is a **client** status instead. The bundler
plugin wires client builds only; `createSpinetab()` stays inert on the server.

## Next.js App Router

Only `spinetab/react` carries `"use client"`, in its ESM and CommonJS builds. That
does not make hooks callable from Server Components.

- Import `live.ts` only from Client Components. Server Components can render a
  Client Component that uses it, but cannot call the bound hooks themselves.
- Call `createSpinetab()` and define any `credentials` callback in client
  modules. Pass only serialisable props from Server Components.
- Prerendering starts no worker, connection or timer and calls no credential
  callback. Live work starts in effects after hydration.
- Do not keep credentials or subscription state in a server singleton shared
  across requests.
- No `transpilePackages`, `dynamic(…, { ssr: false })` or wrapper modules are
  needed.

See [Bundler configuration](/docs/bundlers/) for `withSpinetab`.
