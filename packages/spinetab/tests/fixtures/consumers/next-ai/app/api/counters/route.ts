// Generation starts seen by this server process (sharing proof for AI cells).
export const dynamic = "force-dynamic";

export function GET() {
	const counters = (globalThis as { __aiCounters?: unknown }).__aiCounters ?? {
		generations: 0,
		generationIds: [],
		byChat: {},
	};
	return Response.json(counters);
}
