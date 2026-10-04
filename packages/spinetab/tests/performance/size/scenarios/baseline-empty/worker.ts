interface ConnectEvent extends Event {
	ports: MessagePort[];
}

self.addEventListener("connect", (event) => {
	const port = (event as ConnectEvent).ports[0];
	port?.addEventListener("message", () => port.postMessage("pong"));
	port?.start();
});
