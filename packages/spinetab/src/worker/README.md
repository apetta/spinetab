# SharedWorker

The worker host belongs here. `index.ts` reserves the ESM-only `spinetab/worker`
entry; importing it does not register handlers or start a worker.

Applications own their small worker entry and import only selected adapter code.
Their bundler must see the worker URL expression. Adapter runtime logic must also
support explicit lazy local loading; a worker URL alone cannot provide fallback.

The host, handshake, recovery and supported consumer builds still need implementation
and tests. Add adapter runtime/worker subpaths only when those contracts are proved.
