"use client";

import { ticks } from "@consumer/feeds";
import { useEffect, useMemo, useState } from "react";
import { type ClientStatus, resolveEndpoint } from "spinetab";
import { spinetab, useSpinetabStatus, useSubscription } from "./live";

interface Probe {
	run: string;
	clients: number;
	events: unknown[];
	errors: Array<{ code: string; message: string }>;
	endpoint: string;
	status(): Record<string, unknown>;
}

const probe: Probe = {
	run: "",
	clients: 0,
	events: [],
	errors: [],
	endpoint: "",
	status: () => plain(spinetab.status.get()),
};
if (typeof window !== "undefined") {
	probe.clients += 1;
	(window as { __consumer?: Probe }).__consumer = probe;
}

function plain(status: ClientStatus): Record<string, unknown> {
	const { mode, reason, health, runtimeId, generation, error } = status;
	return {
		mode,
		reason,
		health,
		runtimeId,
		generation,
		...(error ? { error: { code: error.code, message: error.message } } : {}),
	};
}

export function LiveView({ sse }: { sse: string }) {
	const status = useSpinetabStatus();
	const [run, setRun] = useState<string | null>(null);
	useEffect(() => {
		const value = new URLSearchParams(location.search).get("run") ?? "default";
		probe.run = value;
		probe.endpoint = resolveEndpoint(sse, document.baseURI);
		setRun(value);
	}, [sse]);
	const subscription = useMemo(
		() => (run === null ? null : ticks(sse, run)),
		[sse, run],
	);
	const [last, setLast] = useState<number | null>(null);
	useSubscription(subscription, (value: { n: number }) => {
		probe.events.push(value);
		setLast(value.n);
	});
	return (
		<section>
			<p data-testid="status">
				{status.reason ? `${status.mode}/${status.reason}` : status.mode}
			</p>
			<p data-testid="value">{last === null ? "" : `n = ${last}`}</p>
		</section>
	);
}
