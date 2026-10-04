/** Native WebSocket with the same frames: the baseline for the websocket transport. */
export function start(root: HTMLElement): void {
	const url = new URL("/ws", location.href);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	const socket = new WebSocket(url.href);
	socket.addEventListener("open", () => {
		socket.send(JSON.stringify({ op: "sub", topic: "prices" }));
	});
	socket.addEventListener("message", (event) => {
		root.textContent = String(event.data);
	});
	(globalThis as { __sizeReady?: string }).__sizeReady = "baseline";
}
