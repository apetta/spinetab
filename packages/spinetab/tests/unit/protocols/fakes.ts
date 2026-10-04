import type {
	ConsumerOptions,
	SpinetabClient,
	Subscription,
	SubscriptionObserver,
	SubscriptionRequest,
	SubscriptionStatus,
} from "../../../src/core/types.ts";

/**
 * Scripted WebSocket for driving the real graphql-ws client deterministically
 * (it accepts `webSocketImpl`). Tests play the server: open, acknowledge,
 * answer pings, push messages and close with any code.
 */
export class FakeWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	static instances: FakeWebSocket[] = [];

	readonly CONNECTING = 0;
	readonly OPEN = 1;
	readonly CLOSING = 2;
	readonly CLOSED = 3;
	readonly url: string;
	readonly protocol: string;
	readyState = 0;
	sent: Array<Record<string, unknown>> = [];
	closedWith: { code?: number; reason?: string } | undefined;
	onopen: ((event: unknown) => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;
	onerror: ((event: unknown) => void) | null = null;
	onclose:
		| ((event: { code: number; reason: string; wasClean: boolean }) => void)
		| null = null;

	constructor(url: string, protocol: string) {
		this.url = url;
		this.protocol = protocol;
		FakeWebSocket.instances.push(this);
	}

	static reset(): void {
		FakeWebSocket.instances = [];
	}

	static last(): FakeWebSocket {
		const socket = FakeWebSocket.instances.at(-1);
		if (!socket) throw new Error("no socket was created");
		return socket;
	}

	send(data: string): void {
		this.sent.push(JSON.parse(data) as Record<string, unknown>);
	}

	close(code?: number, reason?: string): void {
		if (this.readyState >= 2) return;
		this.closedWith = { code, reason };
		this.readyState = 2;
		queueMicrotask(() => this.#closed(code ?? 1005, reason ?? ""));
	}

	open(): void {
		this.readyState = 1;
		this.onopen?.({});
	}

	receive(message: Record<string, unknown>): void {
		this.onmessage?.({ data: JSON.stringify(message) });
	}

	ack(): void {
		this.receive({ type: "connection_ack" });
	}

	/** Open and acknowledge. */
	accept(): void {
		this.open();
		this.ack();
	}

	serverClose(code: number, reason = ""): void {
		this.readyState = 2;
		this.#closed(code, reason);
	}

	networkError(): void {
		this.readyState = 3;
		this.onerror?.({ type: "error" });
		this.onclose?.({ code: 1006, reason: "", wasClean: false });
	}

	subscribeIds(): string[] {
		return this.sent
			.filter((message) => message.type === "subscribe")
			.map((message) => String(message.id));
	}

	#closed(code: number, reason: string): void {
		this.readyState = 3;
		this.onclose?.({ code, reason, wasClean: code === 1000 });
	}
}

export interface FakeCall {
	request: SubscriptionRequest;
	observer: SubscriptionObserver<unknown>;
	options: ConsumerOptions | undefined;
	unsubscribed: number;
	/** Arguments of each `markReconciled` call on the handle. */
	reconciled: Array<{ pending?: boolean } | undefined>;
	/** Number of `retry()` calls on the handle. */
	retries: number;
	status(
		state: SubscriptionStatus["connection"]["state"],
		extra?: Partial<SubscriptionStatus>,
	): void;
}

/** Page-client double recording subscribe calls; tests drive the observers. */
export function createFakeClient(): {
	client: SpinetabClient;
	calls: FakeCall[];
} {
	const calls: FakeCall[] = [];
	const notImplemented = () => {
		throw new Error("not used by these tests");
	};
	const client = {
		status: { get: notImplemented, subscribe: notImplemented },
		scope: "",
		start() {},
		subscribe(
			request: SubscriptionRequest,
			observer: SubscriptionObserver<unknown>,
			options?: ConsumerOptions,
		) {
			const call: FakeCall = {
				request,
				observer,
				options,
				unsubscribed: 0,
				reconciled: [],
				retries: 0,
				status(state, extra = {}) {
					observer.status?.({
						active: true,
						connection: { state, since: 0 },
						continuity: { state: "continuous", since: 0 },
						...extra,
					});
				},
			};
			calls.push(call);
			const subscription: Subscription = {
				id: `c${calls.length}`,
				status: { get: notImplemented, subscribe: notImplemented } as never,
				update() {},
				markReconciled(options?: { pending?: boolean }) {
					call.reconciled.push(options);
				},
				retry() {
					call.retries += 1;
				},
				unsubscribe() {
					call.unsubscribed += 1;
				},
			};
			return subscription;
		},
		command: notImplemented,
		setCredentialRevision: notImplemented,
		setScope: notImplemented,
		checkHealth: notImplemented,
		retry: notImplemented,
		dispose() {},
	} as unknown as SpinetabClient;
	return { client, calls };
}
