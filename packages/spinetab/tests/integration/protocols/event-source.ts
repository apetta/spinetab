/**
 * Minimal header-capable EventSource for Node test workers, which have no
 * global EventSource. It follows the HTML algorithm closely enough for the
 * tRPC fixture: `Last-Event-ID` on reconnect, `retry:` hints, named events,
 * CONNECTING → OPEN → CLOSED, and "fail the connection" (CLOSED, no retry)
 * on a non-200 status or wrong content type. The error event carries the
 * HTTP `status`, which native browsers do not expose. Native EventSource
 * behaviour is exercised in `tests/browser/protocols-trpc.spec.ts`.
 */
export interface TestEventSourceInit {
	headers?: Record<string, string>;
	withCredentials?: boolean;
}

type Listener = (event: {
	type: string;
	data?: string;
	lastEventId?: string;
	status?: number;
}) => void;

export class TestEventSource {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSED = 2;
	static created: Array<{ url: string; headers: Record<string, string> }> = [];

	readonly CONNECTING = 0;
	readonly OPEN = 1;
	readonly CLOSED = 2;
	readonly url: string;
	readonly withCredentials: boolean;
	readyState = 0;
	onopen: Listener | null = null;
	onmessage: Listener | null = null;
	onerror: Listener | null = null;
	#listeners = new Map<string, Set<Listener>>();
	#controller = new AbortController();
	#headers: Record<string, string>;
	#lastEventId = "";
	#retryMs = 100;

	constructor(url: string | URL, init: TestEventSourceInit = {}) {
		this.url = String(url);
		this.withCredentials = init.withCredentials ?? false;
		this.#headers = { ...init.headers };
		TestEventSource.created.push({
			url: this.url,
			headers: { ...this.#headers },
		});
		queueMicrotask(() => void this.#connect());
	}

	addEventListener(type: string, listener: Listener): void {
		let set = this.#listeners.get(type);
		if (!set) {
			set = new Set();
			this.#listeners.set(type, set);
		}
		set.add(listener);
	}

	removeEventListener(type: string, listener: Listener): void {
		this.#listeners.get(type)?.delete(listener);
	}

	close(): void {
		this.readyState = 2;
		this.#controller.abort();
	}

	#dispatch(event: Parameters<Listener>[0]): void {
		const handler =
			event.type === "open"
				? this.onopen
				: event.type === "error"
					? this.onerror
					: event.type === "message"
						? this.onmessage
						: null;
		handler?.call(this, event);
		for (const listener of [...(this.#listeners.get(event.type) ?? [])])
			listener.call(this, event);
	}

	async #connect(): Promise<void> {
		if (this.readyState === 2) return;
		let response: Response;
		try {
			response = await fetch(this.url, {
				headers: {
					accept: "text/event-stream",
					...this.#headers,
					...(this.#lastEventId ? { "last-event-id": this.#lastEventId } : {}),
				},
				signal: this.#controller.signal,
			});
		} catch {
			return this.#reconnect();
		}
		if (this.readyState === 2) return;
		if (
			response.status !== 200 ||
			!(response.headers.get("content-type") ?? "").includes(
				"text/event-stream",
			)
		) {
			this.readyState = 2;
			response.body?.cancel().catch(() => {});
			this.#dispatch({ type: "error", status: response.status });
			return;
		}
		this.readyState = 1;
		this.#dispatch({ type: "open" });
		try {
			await this.#read(response.body as ReadableStream<Uint8Array>);
		} catch {
			// Dropped stream; reconnect below.
		}
		this.#reconnect();
	}

	#reconnect(): void {
		if (this.readyState === 2) return;
		this.readyState = 0;
		this.#dispatch({ type: "error" });
		setTimeout(() => void this.#connect(), this.#retryMs);
	}

	async #read(body: ReadableStream<Uint8Array>): Promise<void> {
		const decoder = new TextDecoder();
		let buffer = "";
		let data: string[] = [];
		let type = "";
		const reader = body.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return;
			buffer += decoder.decode(value, { stream: true });
			let index = buffer.search(/\r\n|\r|\n/);
			while (index >= 0) {
				const line = buffer.slice(0, index);
				const newline = buffer.startsWith("\r\n", index) ? 2 : 1;
				buffer = buffer.slice(index + newline);
				if (line === "") {
					if (data.length > 0) {
						this.#dispatch({
							type: type || "message",
							data: data.join("\n"),
							lastEventId: this.#lastEventId,
						});
					}
					data = [];
					type = "";
				} else if (!line.startsWith(":")) {
					const colon = line.indexOf(":");
					const field = colon < 0 ? line : line.slice(0, colon);
					let value = colon < 0 ? "" : line.slice(colon + 1);
					if (value.startsWith(" ")) value = value.slice(1);
					if (field === "data") data.push(value);
					else if (field === "event") type = value;
					else if (field === "id" && !value.includes("\0"))
						this.#lastEventId = value;
					else if (field === "retry" && /^\d+$/.test(value))
						this.#retryMs = Number(value);
				}
				index = buffer.search(/\r\n|\r|\n/);
			}
		}
	}
}
