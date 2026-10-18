# Protocol recovery

- Socket.IO desired memberships differ from rooms the server may still hold.
  Lost join/leave acknowledgements require bounded retirement and compensating
  cleanup; dropping that state can resurrect removed subscriptions on reconnect.
- When declining Socket.IO recovery, clear both session ID and cursor. An
  interrupted handshake may already have consumed the previous recovery session.
- Bind asynchronous work to its originating client/generation. In GraphQL SSE,
  late completion from a retired client must not close its replacement.

Use real-server tests in `tests/integration/protocols/` (package-relative) for
these transitions; mock connection flags cannot establish upstream recovery state.
