// A worker speaking bridge version 0, for the incompatible-version test: it
// answers every hello with a version 0 welcome.
self.addEventListener("connect", (event) => {
	const port = (event as MessageEvent).ports[0];
	if (!port) return;
	port.addEventListener("message", (message) => {
		const data = (message as MessageEvent).data as {
			t?: string;
			a?: string;
			g?: number;
		} | null;
		if (data?.t === "hello") {
			port.postMessage({
				v: 0,
				t: "welcome",
				a: data.a,
				g: data.g,
				runtime: "harness-v0",
			});
		}
	});
	port.start();
});

export {};
