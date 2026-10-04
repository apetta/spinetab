import { LiveView } from "./live-view";

// Server Component: prerendered as static content; the Spinetab client and
// the feed live in client modules.
export default function Page() {
	return (
		<main>
			<h1>Spinetab Next monorepo consumer</h1>
			<LiveView sse="fx/sse/ticks" />
		</main>
	);
}
