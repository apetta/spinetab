import { socketIoAdapter } from "spinetab/socket-io/runtime";

/**
 * Socket.IO part of the harness worker (add to live.adapters.ts). The fixture
 * emits `room` events `{ room, n }`; the `byRoom` route lets listeners with
 * different membership keys share one socket. `ask` is answered by a
 * worker-side responder (server-requested acknowledgements never cross the
 * bridge).
 */
export const socketIoHarnessAdapter = socketIoAdapter({
	routes: {
		byRoom: (args) => {
			const first = args[0] as { room?: unknown } | undefined;
			return typeof first?.room === "string" ? [first.room] : [];
		},
	},
	responders: {
		ask: (args) => ({
			answer: ((args[0] as { question?: number })?.question ?? 0) + 1,
		}),
	},
});
