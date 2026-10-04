// Browser-worker baseline: answers pings without importing Spinetab.
interface ConnectEvent extends Event {
	ports: MessagePort[];
}

self.addEventListener("connect", (event) => {
	const port = (event as ConnectEvent).ports[0];
	if (!port) return;
	port.addEventListener("message", (message: MessageEvent) => {
		if ((message.data as { op?: string } | null)?.op === "ping") {
			port.postMessage({
				op: "pong",
				at: performance.timeOrigin + performance.now(),
			});
		}
	});
	port.start();
});
