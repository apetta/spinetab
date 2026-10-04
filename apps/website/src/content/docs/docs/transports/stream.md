---
title: Fetch streams
description: Share streaming fetch responses across tabs, parsed as NDJSON or lines in the worker, with explicit repeatability.
---

Use a fetch stream when your endpoint sends NDJSON or line-delimited data.
Declare `repeatable: true` only when requesting the feed again is safe; a request
that starts one-off work must not be restarted automatically.

[Set up the plugin and client](/docs/getting-started/) first. The examples use
`spinetab.subscribe()`; call the returned handle's `unsubscribe()` when your view
is removed. [UI bindings](/docs/frameworks/) handle that cleanup for components.

```ts
import { stream } from "spinetab/stream";
import { spinetab } from "./live";

type Order = { id: string; status: string };

const orders = stream<Order>("/api/orders/live", { repeatable: true });
const subscription = spinetab.subscribe(orders, (order) =>
  console.log(order.status),
);
```

The worker reads one response for every tab and splits it into frames, one JSON
value per line. The plugin registers the adapter for you. `repeatable: true`
says the request is a feed that may be shared and restarted. Spinetab cannot know
that about a response, so you declare it.

## Default behaviour

| Setting        | Default                                                       |
| -------------- | ------------------------------------------------------------- |
| Parser         | NDJSON: one JSON value per line, blank lines skipped          |
| Repeatable     | `false` for every method, including GET                       |
| Not repeatable | Never shared; an interruption ends it `interrupted`           |
| Repeatable     | Shared by identity; restarted with backoff                    |
| Frame size     | 256 KiB                                                       |
| Credentials    | Same-origin cookies; provider headers only on your own origin |

## Configure a stream

Read plain lines as strings:

```ts
const log = stream<string>("/api/log", { parser: "lines", repeatable: true });
```

Handle errors and status next to the frames:

```ts
spinetab.subscribe(orders, { next: show, error: (error) => warn(error.code) });
```

Skip malformed frames with a reported gap instead of failing the response:

```ts
const lenient = stream<Order>("/api/orders/live", {
  malformed: "skip",
  repeatable: true,
});
```

Stream a one-off POST, which is never shared or restarted:

```ts
const rows = stream<Row>("/api/reports", { method: "POST", body: "{}" });
```

Reload your data after a loss on a repeatable feed. The reload must reject when it
fails:

```ts
import { reconcileOnLoss } from "spinetab";

const stopRecovery = reconcileOnLoss(subscription, async ({ signal }) => {
  const snapshot = await fetchOrders({ signal });
  if (!signal.aborted) mergeOrders(snapshot);
});
```

The fetch and merge functions belong to your application. Merge using a server
version so a snapshot cannot overwrite newer live events. Call `stopRecovery()`
alongside `subscription.unsubscribe()` on teardown; see
[recovery](/docs/concepts/continuity/).

## Options

| Option        | Default         | Meaning                                                                          |
| ------------- | --------------- | -------------------------------------------------------------------------------- |
| `parser`      | `"ndjson"`      | `ndjson`, `lines` or a parser registered in the worker                           |
| `repeatable`  | `false`         | Whether the request may be shared and restarted                                  |
| `method`      | `GET`           | `GET`, `POST`, `PUT`, `PATCH` or `DELETE`                                        |
| `headers`     | None            | Non-credential request headers                                                   |
| `body`        | None            | A string body                                                                    |
| `credentials` | `"same-origin"` | The fetch cookie mode                                                            |
| `authHeaders` | Auto            | Auto: provider headers on your own origin only. `true`: required. `false`: never |
| `malformed`   | `"error"`       | `"error"` fails the response on a malformed frame; `"skip"` reports a gap        |
| `heartbeat`   | None            | `{ expectInboundWithinMs }` for stall detection                                  |

## Restrictions

- A frame larger than `maxFrameBytes` aborts the response with `frame-too-large`
  (frames completed before it are still delivered, in order) and sets the
  connection to `failed`, without an automatic retry. Subscribe again to retry.
- Bodies must be strings.
- A 401 is `auth-blocked`, code `http:401`. A 403 is `failed`, code `forbidden`.
  A redirect on a request that carries provider headers is not followed.
- Static credential headers are refused. Tokens come from the client's
  `credentials` callback. Header values must be characters up to U+00FF, without
  NUL, CR or LF; anything else is refused when the feed is defined.

## Custom parsers

`streamAdapter()` always registers `ndjson` (`ndjsonParser()`) and `lines`
(`lineFramer()`). Both accept `maxLineBytes`, and `ndjsonParser` accepts a
`heartbeat(value)` classifier whose matches are not delivered. A parser registered
under either name replaces the built-in one. A custom parser is a factory that
returns one instance per response. This example reads unquoted, pipe-separated
fields, one record per line. Register it in a [custom worker](/docs/your-worker/):

```ts title="spinetab.worker.ts"
import { type Parser, streamAdapter } from "spinetab/stream/runtime";
import { defineWorker } from "spinetab/worker";

const fields: Parser<string[]> = () => {
  let buffer = "";
  return {
    push(chunk) {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      return lines.map((line) => line.split("|"));
    },
    end: () => (buffer ? [buffer.split("|")] : []),
    // A conservative UTF-8 upper bound for the unfinished line.
    pendingBytes: () => buffer.length * 3,
  };
};

export default defineWorker(() => [streamAdapter({ parsers: { fields } })]);
```

Select it with `stream(url, { parser: "fields" })`. Output must depend only on the
bytes, never on how the network split them. Instances receive text by default;
declare `input: "bytes"` for `Uint8Array` chunks. Report `pendingBytes()` so
Spinetab can enforce `maxFrameBytes`.

`stream({ url, ...options })` is the same request as `stream(url, options)`.
