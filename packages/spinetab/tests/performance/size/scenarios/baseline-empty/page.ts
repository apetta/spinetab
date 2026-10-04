/** Shell plus a no-op SharedWorker: the browser-worker baseline. */
export function start(root: HTMLElement): void {
	const worker = new SharedWorker(new URL("./worker.ts", import.meta.url), {
		type: "module",
		name: "size-baseline-empty",
	});
	worker.port.addEventListener("message", (event: MessageEvent) => {
		root.textContent = String(event.data);
		(globalThis as { __sizeReady?: string }).__sizeReady = "baseline";
	});
	worker.port.start();
	worker.port.postMessage("ping");
}
