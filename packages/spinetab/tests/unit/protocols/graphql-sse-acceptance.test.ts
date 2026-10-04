import { afterEach, describe, expect, it } from "vitest";
import type {
	AdapterConnection,
	SubscriptionSink,
} from "../../../src/core/adapter.ts";
import { graphqlSseAdapter } from "../../../src/protocols/graphql-sse/runtime.ts";
import {
	createRecordingSink,
	createTestContext,
	waitFor,
} from "../../integration/protocols/helpers.ts";

const connections: AdapterConnection[] = [];
afterEach(() => {
	for (const connection of connections.splice(0)) connection.dispose();
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function setup(retry: () => Promise<void> = async () => {}) {
	const log: string[] = [];
	const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
	const posts: Array<{
		id: string;
		query: string;
		response: ReturnType<typeof deferred<Response>>;
		signal?: AbortSignal;
	}> = [];
	const context = createTestContext();
	const setStatus = context.ctx.setStatus.bind(context.ctx);
	context.ctx.setStatus = (status) => {
		log.push(`status:${status.state}`);
		setStatus(status);
	};
	let token = 0;
	const encoder = new TextEncoder();
	const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
		if (init?.method === "PUT")
			return new Response(`token-${++token}`, { status: 201 });
		if (init?.method === "DELETE") return new Response(null, { status: 200 });
		if (init?.method === "POST") {
			const body = JSON.parse(String(init.body));
			const response = deferred<Response>();
			posts.push({
				id: body.extensions.operationId,
				query: body.query,
				response,
				...(init.signal ? { signal: init.signal } : {}),
			});
			return response.promise;
		}
		return new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					streams.push(controller);
					controller.enqueue(encoder.encode(": open\n\n"));
					init?.signal?.addEventListener(
						"abort",
						() => {
							try {
								controller.error(new DOMException("Aborted", "AbortError"));
							} catch {}
						},
						{ once: true },
					);
				},
			}),
			{ status: 200, headers: { "content-type": "text/event-stream" } },
		);
	}) as typeof fetch;
	const connection = graphqlSseAdapter({
		fetchFn,
		retry,
	}).connect(
		{ url: "https://api.test/stream", mode: "single", anonymous: true },
		context.ctx,
	);
	connections.push(connection);
	const subscribe = (
		name: string,
		repeatable = true,
		onContinuity?: () => void,
	) => {
		const recording = createRecordingSink();
		const sink: SubscriptionSink = {
			...recording.sink,
			continuity(reason, options) {
				log.push(`${name}:continuity`);
				recording.sink.continuity(reason, options);
				onContinuity?.();
			},
		};
		const subscription = connection.subscribe(
			{ query: `subscription ${name} { ticks { n } }` },
			sink,
			{ key: name, repeatable },
		);
		return { recording, subscription };
	};
	const accept = (index: number) => {
		log.push(`accepted:${index}`);
		posts[index]?.response.resolve(new Response(null, { status: 202 }));
	};
	const deliver = (index: number, n: number) =>
		streams
			.at(-1)
			?.enqueue(
				encoder.encode(
					`event: next\ndata: ${JSON.stringify({ id: posts[index]?.id, payload: { data: { ticks: { n } } } })}\n\n`,
				),
			);
	const drop = () => streams.at(-1)?.error(new Error("Connection lost"));
	return {
		connection,
		context,
		log,
		streams,
		posts,
		subscribe,
		accept,
		deliver,
		drop,
	};
}

describe("graphql-sse single-mode operation acceptance", () => {
	it("keeps a quiet initial operation connecting until its POST is accepted", async () => {
		const h = setup();
		const a = h.subscribe("A");
		await waitFor(() => h.posts.length === 1);
		expect(h.context.lastStatus()?.state).toBe("connecting");
		expect(a.recording.continuity).toEqual([]);
		h.accept(0);
		await waitFor(() => h.context.lastStatus()?.state === "connected");
		expect(a.recording.events).toEqual([]);
	});

	it("reports loss early and restoration only after the replacement operation is accepted", async () => {
		const h = setup();
		const a = h.subscribe("A");
		await waitFor(() => h.posts.length === 1);
		h.accept(0);
		h.deliver(0, 1);
		await waitFor(() => a.recording.events.length === 1);
		h.log.length = 0;
		h.drop();
		await waitFor(() => h.posts.length === 2);
		expect(a.recording.continuity).toHaveLength(1);
		expect(h.context.lastStatus()?.state).toBe("reconnecting");
		h.accept(1);
		await waitFor(() => a.recording.continuity.length === 2);
		expect(h.log).toEqual([
			"A:continuity",
			"status:reconnecting",
			"accepted:1",
			"A:continuity",
			"status:connected",
		]);
	});

	it("restores each operation after its own acceptance and waits for all live operations before connected", async () => {
		const h = setup();
		const a = h.subscribe("A");
		const b = h.subscribe("B");
		await waitFor(() => h.posts.length === 2);
		h.accept(0);
		h.accept(1);
		h.deliver(0, 1);
		h.deliver(1, 1);
		await waitFor(
			() => a.recording.events.length === 1 && b.recording.events.length === 1,
		);
		h.drop();
		await waitFor(() => h.posts.length === 4);
		expect(a.recording.continuity).toHaveLength(1);
		expect(b.recording.continuity).toHaveLength(1);
		h.accept(3);
		await waitFor(() => b.recording.continuity.length === 2);
		expect(a.recording.continuity).toHaveLength(1);
		expect(h.context.lastStatus()?.state).toBe("reconnecting");
		h.accept(2);
		await waitFor(() => a.recording.continuity.length === 2);
		expect(h.context.lastStatus()?.state).toBe("connected");
	});

	it("unsubscribing an unaccepted operation allows the accepted sibling to become connected", async () => {
		const h = setup();
		h.subscribe("A");
		const b = h.subscribe("B");
		await waitFor(() => h.posts.length === 2);
		h.accept(0);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(h.context.lastStatus()?.state).toBe("connecting");
		b.subscription.unsubscribe();
		expect(h.context.lastStatus()?.state).toBe("connected");
		h.accept(1);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(b.recording.continuity).toEqual([]);
	});

	it("an unsuccessful operation POST does not announce restoration", async () => {
		const h = setup();
		const a = h.subscribe("A");
		await waitFor(() => h.posts.length === 1);
		h.accept(0);
		h.deliver(0, 1);
		await waitFor(() => a.recording.events.length === 1);
		h.drop();
		await waitFor(() => h.posts.length === 2);
		h.posts[1]?.response.resolve(new Response(null, { status: 503 }));
		await waitFor(() => h.posts.length === 3);
		expect(a.recording.continuity).toHaveLength(1);
		expect(h.context.lastStatus()?.state).toBe("reconnecting");
		h.accept(2);
		await waitFor(() => a.recording.continuity.length === 2);
	});

	it("a failed sibling POST does not hold back an operation still running on an older reservation", async () => {
		const h = setup();
		h.subscribe("A");
		const b = h.subscribe("B");
		await waitFor(() => h.posts.length === 2);
		h.accept(1);
		h.deliver(1, 1);
		await waitFor(() => b.recording.events.length === 1);
		h.posts[0]?.response.resolve(new Response(null, { status: 503 }));
		await waitFor(() => h.posts.length === 3);
		h.accept(2);
		await waitFor(() => h.context.lastStatus()?.state === "connected");
		expect(b.recording.continuity).toHaveLength(2);
		expect(h.posts.map((post) => post.query.includes(" B "))).toEqual([
			false,
			true,
			false,
		]);
		h.streams[0]?.enqueue(
			new TextEncoder().encode(
				`event: next\ndata: ${JSON.stringify({ id: h.posts[1]?.id, payload: { data: { ticks: { n: 2 } } } })}\n\n`,
			),
		);
		await waitFor(() => b.recording.events.length === 2);
	});

	it("reports reservation recovery when a retained sibling clears the upstream retry flag", async () => {
		const retryEntered = deferred<void>();
		const retryFinished = deferred<void>();
		const h = setup(async () => {
			retryEntered.resolve();
			await retryFinished.promise;
		});
		const b = h.subscribe("B", false);
		await waitFor(() => h.posts.length === 1);
		h.accept(0);
		h.deliver(0, 1);
		await waitFor(() => b.recording.events.length === 1);
		h.subscribe("A");
		await waitFor(() => h.posts.length === 2);
		h.posts[1]?.response.resolve(new Response(null, { status: 503 }));
		await retryEntered.promise;
		// The live operation remains on the old reservation. Its next result
		// resets graphql-sse's shared retry flag before the pending retry ends.
		h.deliver(0, 2);
		await waitFor(() => b.recording.events.length === 2);
		retryFinished.resolve();
		await waitFor(() => h.posts.length === 3);
		expect(b.recording.continuity).toHaveLength(1);
		expect(h.context.lastStatus()?.state).toBe("reconnecting");
		h.accept(2);
		await waitFor(() => h.context.lastStatus()?.state === "connected");
		expect(b.recording.continuity).toHaveLength(2);
		expect(h.posts.map((post) => post.query.includes(" B "))).toEqual([
			true,
			false,
			false,
		]);
	});

	it("a late accepted response from a rotated generation cannot restore the new generation", async () => {
		const h = setup();
		const a = h.subscribe("A");
		await waitFor(() => h.posts.length === 1);
		h.accept(0);
		h.deliver(0, 1);
		await waitFor(() => a.recording.events.length === 1);
		h.drop();
		await waitFor(() => h.posts.length === 2);
		h.connection.rotate?.();
		await waitFor(() => h.posts.length === 3);
		const count = a.recording.continuity.length;
		h.accept(1);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(a.recording.continuity).toHaveLength(count);
		expect(h.context.lastStatus()?.state).not.toBe("connected");
		h.accept(2);
		await waitFor(() => a.recording.continuity.length > count);
	});

	it("rotation inside a sibling restoration callback cannot publish a stale connected status", async () => {
		const h = setup();
		h.subscribe("A");
		let notices = 0;
		h.subscribe("B", true, () => {
			if (++notices === 2) h.connection.rotate?.();
		});
		await waitFor(() => h.posts.length === 2);
		h.accept(1);
		h.deliver(1, 1);
		await new Promise<void>((resolve) => setImmediate(resolve));
		h.posts[0]?.response.resolve(new Response(null, { status: 503 }));
		await waitFor(() => h.posts.length === 3);
		h.accept(2);
		await waitFor(() => h.posts.length === 5);
		expect(notices).toBe(2);
		expect(h.context.lastStatus()?.state).toBe("connecting");
		h.accept(3);
		h.accept(4);
		await waitFor(() => h.context.lastStatus()?.state === "connected");
	});
	it("rotation during one retained sibling outcome cannot settle another sibling before its new POST", async () => {
		const h = setup();
		h.subscribe("A");
		let notices = 0;
		h.subscribe("B", true, () => {
			if (++notices === 2) h.connection.rotate?.();
		});
		const c = h.subscribe("C");
		await waitFor(() => h.posts.length === 3);
		h.accept(1);
		h.accept(2);
		h.deliver(1, 1);
		h.deliver(2, 1);
		await waitFor(() => c.recording.events.length === 1);
		h.posts[0]?.response.resolve(new Response(null, { status: 503 }));
		await waitFor(() => h.posts.length === 4);
		expect(c.recording.continuity).toHaveLength(1);
		h.accept(3);
		await waitFor(() => h.posts.length === 7);
		expect(notices).toBe(2);
		expect(c.recording.continuity).toHaveLength(1);
		expect(h.context.lastStatus()?.state).toBe("connecting");
		h.accept(4);
		h.accept(5);
		h.accept(6);
		await waitFor(() => h.context.lastStatus()?.state === "connected");
		expect(c.recording.continuity).toHaveLength(2);
	});
});
