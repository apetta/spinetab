// Plain SharedWorker WITHOUT Spinetab, for separating engine behaviour from
// library behaviour. Each instance has a random id; every connected port gets
// a hello and then a tick every 250 ms. Ports are never removed (a page gives
// no reliable close signal), exactly as a naive application would do.
const workerId = crypto.randomUUID();
const ports = new Set<MessagePort>();
let seq = 0;

self.addEventListener("connect", (event) => {
	const port = (event as MessageEvent).ports[0];
	if (!port) return;
	ports.add(port);
	port.start();
	port.postMessage({ type: "hello", workerId, clients: ports.size });
});

setInterval(() => {
	seq += 1;
	for (const port of ports) {
		port.postMessage({ type: "tick", workerId, seq, at: Date.now() });
	}
}, 250);

export {};
