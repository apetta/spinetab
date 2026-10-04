import {
	channelName,
	type ExampleKind,
	type NetworkSnapshot,
} from "./protocol";

export function observeNetwork(
	kind: ExampleKind,
	group: string,
	epoch: string,
) {
	const channel = new BroadcastChannel(channelName(kind, group));
	const state: NetworkSnapshot = {
		type: "network",
		source: crypto.randomUUID(),
		epoch,
		requests: 0,
		completed: 0,
		active: 0,
		lastRequest: 0,
		lastUpdate: 0,
	};
	let disposed = false;
	let retiring = false;
	const publish = () => {
		if (disposed) return;
		channel.postMessage({ ...state });
		if (retiring && state.active === 0) {
			disposed = true;
			channel.close();
		}
	};
	channel.addEventListener("message", (event) => {
		if (event.data?.type === "network-request") publish();
	});

	const observedFetch: typeof fetch = async (input, init) => {
		state.requests++;
		state.active++;
		state.lastRequest = Date.now();
		publish();
		try {
			const response = await fetch(input, init);
			state.completed++;
			return response;
		} finally {
			state.active--;
			publish();
		}
	};

	class ObservedWebSocket extends WebSocket {
		constructor(url: string | URL, protocols?: string | string[]) {
			super(url, protocols);
			this.addEventListener("open", () => {
				state.active++;
				publish();
			});
			this.addEventListener("message", (event) => {
				if (typeof event.data !== "string") return;
				try {
					const message = JSON.parse(event.data);
					if (message.type === "next") {
						state.lastUpdate = Date.now();
						publish();
					}
				} catch {
					/* Malformed frames must not interrupt network measurement. */
				}
			});
			this.addEventListener("close", () => {
				// A socket can close without opening.
				if (this.opened) state.active--;
				publish();
			});
			this.addEventListener(
				"open",
				() => {
					this.opened = true;
				},
				{ once: true },
			);
		}
		private opened = false;
	}

	return {
		identify(id: string) {
			state.source = id;
		},
		fetch: observedFetch,
		WebSocket: ObservedWebSocket,
		dispose() {
			retiring = true;
			publish();
		},
	};
}
