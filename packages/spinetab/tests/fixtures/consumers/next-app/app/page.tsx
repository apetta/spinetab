import { LiveView } from "./live-view";
import { QueryLink } from "./query-link";

// Server Component: prerendered as static content. It passes only
// serialisable props; the client, worker factory and credential callback live
// in the client module.
export default function Page() {
	return (
		<main>
			<h1>Spinetab Next consumer</h1>
			<LiveView
				endpoint="ws://127.0.0.1:4500/ws/topics"
				sse="fx/sse/ticks"
				scope="alpha"
			/>
			<QueryLink href="/other" testId="to-other">
				Other page
			</QueryLink>
		</main>
	);
}
