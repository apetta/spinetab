// Reports how often the credentials callback ran in this server process: it
// must never run during import, render or prerender.
export const dynamic = "force-dynamic";

export function GET() {
	const calls = (globalThis as { __credCalls?: number }).__credCalls ?? 0;
	return Response.json({ credCalls: calls });
}
