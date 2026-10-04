// Minimal native SharedWorker client WITHOUT Spinetab (native.html). It
// exposes `window.nativeRepro` so browser tests can observe, per page, which
// worker instance serves it and whether its messages keep arriving after
// another client page closes.
interface NativeRepro {
	/** Id of the worker instance that last messaged this page. */
	workerId: string | null;
	/** Every distinct worker id seen, in order. */
	workerIds: string[];
	/** Messages received (hello and ticks). */
	messages: number;
	/** Page clock (Date.now()) of the last message, or null. */
	lastAt: number | null;
	/** Worker tick sequence of the last tick, or null. */
	lastSeq: number | null;
	/** Worker `error` events observed by this page. */
	errors: number;
}

const state: NativeRepro = {
	workerId: null,
	workerIds: [],
	messages: 0,
	lastAt: null,
	lastSeq: null,
	errors: 0,
};
(window as unknown as { nativeRepro: NativeRepro }).nativeRepro = state;

const log = document.getElementById("log");
const worker = new SharedWorker(
	new URL("./native.worker.ts", import.meta.url),
	{
		type: "module",
		name: "spinetab-native-repro",
	},
);
worker.addEventListener("error", () => {
	state.errors += 1;
});
worker.port.addEventListener("message", (event: MessageEvent) => {
	const data = event.data as { workerId?: string; seq?: number };
	state.messages += 1;
	state.lastAt = Date.now();
	if (typeof data.seq === "number") state.lastSeq = data.seq;
	if (typeof data.workerId === "string") {
		state.workerId = data.workerId;
		if (!state.workerIds.includes(data.workerId)) {
			state.workerIds.push(data.workerId);
		}
	}
	if (log) log.textContent = `${state.workerId} ${state.messages}`;
});
worker.port.start();
