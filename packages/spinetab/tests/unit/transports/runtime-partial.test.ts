import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntime, type Runtime } from "../../../src/core/runtime.ts";
import { sseAdapter } from "../../../src/transports/sse/runtime.ts";
import { streamAdapter } from "../../../src/transports/stream/runtime.ts";
import { ManualClock, settle } from "../core/helpers/clock.ts";
import { RawPage } from "../core/helpers/page.ts";

// Frames completed before a size failure must reach the page regardless of network chunk boundaries.

const runtimes: Runtime[] = [];
afterEach(() => {
	for (const runtime of runtimes.splice(0)) runtime.dispose();
	vi.unstubAllGlobals();
});

const encoder = new TextEncoder();

function body(chunks: string[]): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			controller.close();
		},
	});
}

async function quiet(clock: ManualClock, raw: RawPage) {
	for (let index = 0; index < 6; index += 1) {
		await new Promise((resolve) => setTimeout(resolve, 5));
		raw.ackControl();
		await settle(clock);
	}
}

async function run(
	request: Record<string, unknown>,
	contentType: string,
	chunks: string[],
) {
	vi.stubGlobal(
		"fetch",
		async () =>
			new Response(body(chunks), {
				status: 200,
				headers: { "content-type": contentType },
			}),
	);
	const clock = new ManualClock();
	const runtime = createRuntime({
		adapters: [sseAdapter() as never, streamAdapter() as never],
		clock,
	});
	runtimes.push(runtime);
	const raw = new RawPage(runtime);
	raw.hello();
	await settle(clock);
	raw.ackControl();
	await settle(clock);
	raw.subscribe("s", request);
	await quiet(clock, raw);
	return {
		data: raw.data("s"),
		terminal: raw
			.events("s")
			.filter((message) => message.kind !== "next")
			.map((message) =>
				message.kind === "error"
					? `error:${(message as { error: { code: string } }).error.code}`
					: message.kind,
			),
	};
}

const SSE = {
	adapter: "sse",
	connection: {
		url: "https://api.example.test/sse",
		mode: "fetch",
		decoder: "text",
	},
	subscription: {},
};
const LINES = {
	adapter: "stream",
	connection: {
		url: "https://api.example.test/lines",
		repeatable: true,
		parser: "lines",
	},
	subscription: {},
};

describe("frames completed before frame-too-large reach the page", () => {
	const big = "x".repeat(300_000);
	for (const [label, request, contentType, head, tail] of [
		["stream lines", LINES, "text/plain", "a\nb\n", big],
		[
			"fetch-mode SSE",
			SSE,
			"text/event-stream",
			"data: a\n\ndata: b\n\n",
			`data: ${big}`,
		],
	] as const) {
		it(`${label}: the same frames for split and coalesced chunks`, async () => {
			const split = await run(request, contentType, [head, tail]);
			const coalesced = await run(request, contentType, [`${head}${tail}`]);
			for (const result of [split, coalesced]) {
				expect(result.data).toEqual(["a", "b"]);
				expect(result.terminal).toEqual(["error:frame-too-large"]);
			}
		});
	}
});
