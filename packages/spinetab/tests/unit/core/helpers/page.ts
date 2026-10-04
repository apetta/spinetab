import {
	BRIDGE_VERSION,
	type PageBody,
	type RuntimeMessage,
} from "../../../../src/core/bridge.ts";
import type { RuntimeHandle } from "../../../../src/core/types.ts";

let attachmentCounter = 0;

/**
 * A raw page speaking bridge v1 over a real MessageChannel. It never acks or
 * reacts on its own, so tests control every acknowledgement explicitly.
 */
export class RawPage {
	readonly a: string;
	g: number;
	readonly port: MessagePort;
	readonly received: RuntimeMessage[] = [];
	readonly raw: unknown[] = [];

	constructor(
		runtime: RuntimeHandle,
		options: { a?: string; g?: number } = {},
	) {
		attachmentCounter += 1;
		this.a = options.a ?? `page-${attachmentCounter}`;
		this.g = options.g ?? 1;
		const channel = new MessageChannel();
		this.port = channel.port1;
		this.port.addEventListener("message", (event) => {
			this.raw.push(event.data);
			this.received.push(event.data as RuntimeMessage);
		});
		this.port.start();
		runtime.accept(channel.port2);
	}

	send(
		body: PageBody | Record<string, unknown>,
		envelope: { a?: string; g?: number; v?: unknown } = {},
	): void {
		this.port.postMessage({
			v: BRIDGE_VERSION,
			a: this.a,
			g: this.g,
			...envelope,
			...body,
		});
	}

	hello(fields: Record<string, unknown> = {}): void {
		this.send({
			t: "hello",
			page: `${this.a}-page`,
			scope: "",
			revision: null,
			heartbeatMs: 20_000,
			...fields,
		} as PageBody);
	}

	subscribe(
		c: string,
		request: Record<string, unknown>,
		options?: unknown,
	): void {
		this.send({
			t: "subscribe",
			c,
			request: {
				adapter: "test",
				connection: { url: "https://example.test/feed" },
				subscription: {},
				...request,
			},
			...(options === undefined ? {} : { options }),
		} as PageBody);
	}

	ofType<T extends RuntimeMessage["t"]>(
		type: T,
	): Array<Extract<RuntimeMessage, { t: T }>> {
		return this.received.filter((message) => message.t === type) as Array<
			Extract<RuntimeMessage, { t: T }>
		>;
	}

	events(c?: string): Array<Extract<RuntimeMessage, { t: "event" }>> {
		return this.ofType("event").filter(
			(message) => c === undefined || message.c === c,
		);
	}

	data(c?: string): unknown[] {
		return this.events(c)
			.filter((message) => message.kind === "next")
			.map((message) => (message as { data: unknown }).data);
	}

	continuity(c: string): Array<Extract<RuntimeMessage, { t: "continuity" }>> {
		return this.ofType("continuity").filter((message) =>
			typeof message.c === "string" ? message.c === c : message.c.includes(c),
		);
	}

	lastControl(): number {
		let k = 0;
		for (const message of this.received) {
			if ("k" in message && typeof message.k === "number")
				k = Math.max(k, message.k);
		}
		return k;
	}

	ackAll(c: string): void {
		const events = this.events(c);
		const last = events[events.length - 1];
		if (last) this.send({ t: "ack", c, seq: last.seq });
	}

	ackControl(): void {
		this.send({ t: "ack", k: this.lastControl() });
	}

	close(): void {
		this.port.close();
	}
}
