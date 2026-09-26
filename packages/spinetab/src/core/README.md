# Core

Framework-independent identity, subscriber references, bridge messaging, lifecycle
recovery and bounded delivery belong here. The public page entry is `src/index.ts`.
Keep protocol clients, framework code and application cache policy out of core.

The same selected adapter logic must work in a SharedWorker and a lazily loaded
per-tab runtime. Core does not import or automatically register adapters. No runtime
implementation exists yet.
