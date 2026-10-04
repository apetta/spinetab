/**
 * Fixture-server access for the consumer stages. Reuses a running fixture
 * (Playwright's `webServer` or a manual `pnpm fixtures`) and otherwise starts
 * one in-process, returning a deterministic close.
 */
const FIXTURE = "http://127.0.0.1:4500";

export async function ensureFixtures(): Promise<() => Promise<void>> {
	try {
		const response = await fetch(`${FIXTURE}/__fixture/counters`, {
			signal: AbortSignal.timeout(2_000),
		});
		await response.body?.cancel();
		if (response.ok) return async () => undefined;
	} catch {
		// Not running: start it below.
	}
	const { startFixtures } = await import("../../fixtures/servers/start.ts");
	const running = await startFixtures([4500, 4501]);
	return () => running.close();
}

interface AllCounters {
	ws?: { opens?: number };
	sse?: { streams?: number };
	stream?: { requests?: Record<string, number> };
	polling?: { requests?: unknown[] };
	"graphql-ws"?: { connections?: number };
	"graphql-sse"?: { tags?: Record<string, { streams?: number }> };
	"socket-io"?: { tags?: Record<string, { connections?: number }> };
	ai?: { generations?: number };
}

/** Global upstream counters: any change means a server-side connection. */
export async function counterTotals(): Promise<Record<string, number>> {
	const response = await fetch(`${FIXTURE}/__fixture/counters`);
	const all = (await response.json()) as AllCounters;
	return {
		wsOpens: all.ws?.opens ?? 0,
		sseStreams: all.sse?.streams ?? 0,
		streamRequests: Object.values(all.stream?.requests ?? {}).reduce(
			(sum, count) => sum + count,
			0,
		),
		pollingRequests: all.polling?.requests?.length ?? 0,
		graphqlWsConnections: all["graphql-ws"]?.connections ?? 0,
		graphqlSseStreams: Object.values(all["graphql-sse"]?.tags ?? {}).reduce(
			(sum, tag) => sum + (tag.streams ?? 0),
			0,
		),
		socketIoConnections: Object.values(all["socket-io"]?.tags ?? {}).reduce(
			(sum, tag) => sum + (tag.connections ?? 0),
			0,
		),
		aiGenerations: all.ai?.generations ?? 0,
	};
}
