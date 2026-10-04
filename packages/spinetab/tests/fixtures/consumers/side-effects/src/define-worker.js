/**
 * Calling `defineWorker` outside a SharedWorker global
 * registers nothing (no listener, timer, message or `onconnect`) and returns
 * the local-runtime factory. `snapshot` is the realm's spy snapshot; the
 * factory itself is not called, because running a runtime is its own work.
 */
export function probeDefineWorker(defineWorker, snapshot) {
	snapshot();
	const factory = defineWorker(() => []);
	return {
		...snapshot(),
		factory: typeof factory,
		onconnect: typeof globalThis.onconnect,
	};
}
