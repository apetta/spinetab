import { LiveView } from "../live-view";

// Rendered per request, so concurrent requests with different scopes can be
// compared: each response carries its own marker and the server status only.
export const dynamic = "force-dynamic";

export default async function Ssr({
	searchParams,
}: {
	searchParams: Promise<{ scope?: string }>;
}) {
	const { scope = "alpha" } = await searchParams;
	return (
		<main>
			<p data-testid="marker">{crypto.randomUUID()}</p>
			<p data-testid="scope">{scope}</p>
			<LiveView
				endpoint="ws://127.0.0.1:4500/ws/topics"
				sse="fx/sse/ticks"
				scope={scope}
			/>
		</main>
	);
}
