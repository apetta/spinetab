import { useEffect, useState } from "react";

export function DemoShell() {
	const [hydrated, setHydrated] = useState(false);
	const [ready, setReady] = useState(false);

	useEffect(() => {
		setHydrated(true);
	}, []);

	return (
		<section className="demo-shell" aria-label="Example shell">
			<button type="button" disabled={!hydrated} onClick={() => setReady(true)}>
				Check interactivity
			</button>
			<p role="status">{ready ? "React is ready." : "Ready to check."}</p>
		</section>
	);
}
