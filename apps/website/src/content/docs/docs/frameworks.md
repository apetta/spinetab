---
title: Using subscriptions
description: Subscribe with vanilla JavaScript or use React, Vue, Svelte and Solid bindings for component lifecycle cleanup.
---

[Choose a complete recipe](/docs/recipes/) for your framework, connection and data
library. This page is the reference for direct component bindings.

Use the core API directly in vanilla JavaScript, or a UI binding to start and stop
subscriptions with your components. Each approach receives updates from the same
shared runtime.

If you already use [Apollo](/docs/integrations/apollo/),
[TanStack Query](/docs/integrations/tanstack-query/) or [SWR](/docs/integrations/swr/),
use that library's integration instead.

First follow the [setup guide for your app](/docs/getting-started/#choose-your-setup).
Then choose a recipe below. Each binding accepts all seven
[subscription sources](/docs/choose-integration/#match-your-backend); replace the
`polling(...)` expression with your source and adapt the returned value. The React, Vue, Svelte and Solid recipes use
`bindClient` so components do not have to pass the client on every call. No
provider is required.

The examples expect `/api/queue` to return `{ "open": 12 }`. Keep the client module
alongside the component, or adjust the relative import for your app. Type arguments
such as `polling<Queue>()` describe the expected value; they do not validate server
data. Use a custom decoder or validate in your callback when needed.

## Vanilla JavaScript

Use the core API directly; no binding is needed. The examples below use
TypeScript annotations, which you can omit in JavaScript.

After adding the bundler plugin, create one client module:

```ts title="src/live.ts"
import { createSpinetab } from "spinetab";

export const spinetab = createSpinetab();
```

Subscribe where your view starts. This example expects your server's
`GET /api/queue` to return JSON such as `{ "open": 12 }`:

```ts title="src/queue.ts"
import { reconcileLatest } from "spinetab";
import { polling } from "spinetab/polling";
import { spinetab } from "./live";

export function mountQueue(element: HTMLElement) {
  element.textContent = "Loading queue…";

  const subscription = spinetab.subscribe(
    polling<{ open: number }>("/api/queue"),
    {
      next: (queue) => {
        element.textContent = `${queue.open} open`;
        recovery.onEvent();
      },
      error: (error) => {
        element.textContent = `Could not load the queue: ${error.code}`;
      },
    },
  );

  const recovery = reconcileLatest(subscription);

  return () => {
    recovery.stop();
    subscription.unsubscribe();
  };
}
```

Call `mountQueue` in the browser after the target element exists.
Call the returned cleanup function when you remove the view. Other consumers
keep their subscriptions. Dispose the client only when the whole app has
finished using it. `reconcileLatest` handles delivery gaps here because each
polling response contains the complete current value.

## React

```ts title="live.ts"
import { createSpinetab } from "spinetab";
import { bindClient } from "spinetab/react";

export const spinetab = createSpinetab();

export const { useLive, useSubscription } = bindClient(spinetab);
```

```tsx title="Queue.tsx"
import { polling } from "spinetab/polling";
import { useLive } from "./live";

export function Queue() {
  const { data, error } = useLive(polling<{ open: number }>("/api/queue"), {
    reconcile: "latest",
  });
  if (error) return <p role="alert">Could not load the queue: {error.code}</p>;
  if (data === undefined) return <p role="status">Loading queue…</p>;
  return <p>{data.open} open</p>;
}
```

In Next.js, put `live.ts` in `app/` and import it only from Client Components.
See the [Next.js guide](/docs/setup/nextjs/).

## Vue

```ts title="live.ts"
import { createSpinetab } from "spinetab";
import { bindClient } from "spinetab/vue";

export const spinetab = createSpinetab();

export const { useLive, useSubscription } = bindClient(spinetab);
```

```vue title="Queue.vue"
<script setup lang="ts">
import { polling } from "spinetab/polling";
import { useLive } from "./live";

const { data, error } = useLive(polling<{ open: number }>("/api/queue"), {
  reconcile: "latest",
});
</script>

<template>
  <p v-if="error" role="alert">Could not load the queue: {{ error.code }}</p>
  <p v-else-if="data === undefined" role="status">Loading queue…</p>
  <p v-else>{{ data.open }} open</p>
</template>
```

## Svelte

```ts title="live.ts"
import { createSpinetab } from "spinetab";
import { bindClient } from "spinetab/svelte";

export const spinetab = createSpinetab();

export const { liveStore, subscriptionStore } = bindClient(spinetab);
```

```svelte title="Queue.svelte"
<script lang="ts">
  import { polling } from "spinetab/polling";
  import { liveStore } from "./live";

  const queue = liveStore(polling<{ open: number }>("/api/queue"), {
    reconcile: "latest",
  });
</script>

{#if $queue.error}
  <p role="alert">Could not load the queue: {$queue.error.code}</p>
{:else if $queue.data === undefined}
  <p role="status">Loading queue…</p>
{:else}
  <p>{$queue.data.open} open</p>
{/if}
```

For a source that changes with props or state, see
[Svelte's reactive store rules](/docs/bindings/#svelte). Use `$queue` to read the
value; `get(queue)` creates a separate subscriber and returns its initial value.

## Solid

```ts title="live.ts"
import { createSpinetab } from "spinetab";
import { bindClient } from "spinetab/solid";

export const spinetab = createSpinetab();

export const { createLive, createSubscription } = bindClient(spinetab);
```

```tsx title="Queue.tsx"
import { polling } from "spinetab/polling";
import { createLive } from "./live";

export function Queue() {
  const queue = createLive(polling<{ open: number }>("/api/queue"), {
    reconcile: "latest",
  });
  return (
    <p role={queue.error() ? "alert" : "status"}>
      {queue.error()
        ? `Could not load the queue: ${queue.error()?.code}`
        : queue.data() === undefined
          ? "Loading queue…"
          : `${queue.data()?.open} open`}
    </p>
  );
}
```

## Your own state

To update state you already own, use a subscription callback. In React, call
`useSubscription` inside the component alongside your `useState` hook. Vue's
`useSubscription`, Svelte's `subscriptionStore` and Solid's `createSubscription`
take the same arguments.

```tsx
const [open, setOpen] = useState<number>();
useSubscription(queue, (value) => setOpen(value.open));
```

## Default behaviour

These defaults apply to the UI bindings. With the vanilla API, you own the
subscription callbacks, rendered value and cleanup.

| Behaviour           | Default                                                                                                                 |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| When work starts    | In the browser through the framework lifecycle. Svelte stores start when subscribed; Vue also supports `effectScope()`. |
| Resubscribing       | React, Vue and Solid compare the source by identity. Svelte follows the store lifecycle described above.                |
| The value           | Held for this mount only. It resets when the source changes and never seeds a later mount.                              |
| Disabling           | Pass `null` or `false` as the source.                                                                                   |
| Continuity loss     | `needsReconcile` is `true` until recovery completes. Without a policy, `error` is also `continuity-lost`.               |
| Failed connection   | `error` is `upstream-error`; `status.connection` carries the reason and code. The retry control remains available.      |
| Errors without hook | `useLive` returns them as `error`. `useSubscription` without an `error` hook reports them once.                         |

## Configure a subscription

The examples below use the bound React hooks. For equivalent Vue, Svelte and
Solid options, see the [binding reference](/docs/bindings/).

Select a field from each event:

```tsx
const { data: open } = useLive(queue, { map: (value) => value.open });
```

Poll at another rate with `pollEvery` from `spinetab/polling`; a changed rate
updates the consumer without resubscribing:

```tsx
import { pollEvery } from "spinetab/polling";

const { data } = useLive(queue, pollEvery(30_000));
```

Read status next to the value:

```tsx
const { data, status, needsReconcile } = useLive(queue);
```

Reconcile a full-state feed automatically, or pass a refresh function for a feed
of changes:

```tsx
const { data } = useLive(queue, { reconcile: "latest" });
```

Throw terminal errors to the nearest error boundary:

```tsx
const { data } = useLive(queue, { throwOnError: true });
```

## Additional binding APIs

- Subscription and client-status hooks also exist unbound, taking the client
  first: `useLive(spinetab, source, options)` from `spinetab/react`.
- `useSubscriptionStatus(subscription)` reads any subscription's status in React.
- [Binding API](/docs/bindings/) lists every function, option and return value.
