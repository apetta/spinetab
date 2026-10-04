"use client";

import { useEffect, useMemo, useState } from "react";
import { sse } from "spinetab/sse";
import { client, hooks } from "./live.cjs";

const probe = {
	run: "",
	clients: 1,
	events: [] as unknown[],
	errors: [] as Array<{ code: string; message: string }>,
	endpoint: "",
	status: () => client.status.get(),
};
if (typeof window !== "undefined") {
	Object.assign(window, { __consumer: probe });
}

function Feed({ run }: { run: string }) {
	const source = useMemo(() => {
		const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
		probe.endpoint = `${location.origin}${base}/fx/sse/ticks?run=${encodeURIComponent(run)}&scope=cjs&rate=250`;
		return sse<{ n: number }>(probe.endpoint).subscription({ event: "tick" });
	}, [run]);
	const [tick, setTick] = useState(0);
	hooks.useSubscription(source, {
		next(value) {
			probe.events.push(value);
			setTick(value.n);
		},
		error(error) {
			probe.errors.push({ code: error.code, message: error.message });
		},
	});
	return <p data-testid="tick">{tick}</p>;
}

export function CommonJsView() {
	const status = hooks.useSpinetabStatus();
	const [run, setRun] = useState<string | null>(null);
	const [enabled, setEnabled] = useState(true);
	useEffect(() => {
		probe.run = new URLSearchParams(location.search).get("run") ?? "default";
		setRun(probe.run);
	}, []);
	return (
		<main>
			<h1>CommonJS client</h1>
			<p data-testid="status">
				{status.mode}
				{status.reason ? `/${status.reason}` : ""}
			</p>
			{enabled && run ? <Feed run={run} /> : <p data-testid="tick">0</p>}
			<button
				type="button"
				data-testid="stop"
				onClick={() => setEnabled(false)}
			>
				Stop subscription
			</button>
		</main>
	);
}
