"use client";

import {
	QueryClient,
	QueryClientProvider,
	useQuery,
} from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type ClientStatus, resolveEndpoint } from "spinetab";
import { sse } from "spinetab/sse";
import { bindQuery } from "spinetab/tanstack-query";
import { websocket } from "spinetab/websocket";
import { base, spinetab, useSpinetabStatus, useSubscription } from "./live";

interface Probe {
	run: string;
	clients: number;
	events: unknown[];
	errors: Array<{ code: string; message: string }>;
	endpoint: string;
	firstRender?: string;
	extra: { ticks: number[]; scope: string };
	status(): Record<string, unknown>;
}

const SCOPES = ["alpha", "beta", "gamma", "delta"];
const queryClient = new QueryClient();

const probe: Probe = {
	run: "",
	clients: 0,
	events: [],
	errors: [],
	endpoint: "",
	extra: { ticks: [], scope: "" },
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
		...(error
			? {
					error: {
						code: error.code,
						message: error.message,
						detail: error.detail,
					},
				}
			: {}),
	};
}

const statusText = (status: ClientStatus) =>
	status.reason ? `${status.mode}/${status.reason}` : status.mode;

interface LiveViewProps {
	endpoint: string;
	sse: string;
	scope: string;
}

export function LiveView(props: LiveViewProps) {
	return (
		<QueryClientProvider client={queryClient}>
			<Live {...props} />
		</QueryClientProvider>
	);
}

function Live({ endpoint, sse: ssePath, scope }: LiveViewProps) {
	const status = useSpinetabStatus();
	const statusRef = useRef<HTMLParagraphElement>(null);
	const [run, setRun] = useState<string | null>(null);
	const [scopeIndex, setScopeIndex] = useState(() =>
		Math.max(0, SCOPES.indexOf(scope)),
	);
	const currentScope = SCOPES[scopeIndex] ?? "alpha";

	// The first client render must show exactly what the server rendered.
	useLayoutEffect(() => {
		probe.firstRender ??= statusRef.current?.textContent ?? "";
	}, []);
	// Endpoints come from the page URL inside an effect so the route stays static.
	useEffect(() => {
		setRun(new URLSearchParams(location.search).get("run") ?? "default");
	}, []);

	const url =
		run === null
			? null
			: `${endpoint}?run=${encodeURIComponent(run)}&scope=${currentScope}&rate=250`;
	const request = useMemo(
		() =>
			url === null
				? null
				: websocket({ url, protocol: "topics" }).subscription<{ seq: number }>(
						"ticks",
					),
		[url],
	);
	useEffect(() => {
		if (!url || run === null) return;
		probe.run = run;
		probe.endpoint = resolveEndpoint(url, base ?? document.baseURI);
		probe.extra.scope = currentScope;
	}, [url, run, currentScope]);
	const subscription = useSubscription(request, {
		next(event) {
			probe.events.push(event);
		},
		error(error) {
			probe.errors.push({ code: error.code, message: error.message });
		},
	});

	// Fetch SSE into the application's TanStack Query cache.
	useEffect(() => {
		if (run === null) return;
		// SSE events arrive as their decoded JSON data.
		const ticks = sse(
			`${ssePath}?run=${encodeURIComponent(run)}&scope=next&rate=250`,
		).subscription<{ n: number }>({ event: "tick" });
		// A full-state feed: after a gap or a scope switch the next tick is the
		// reconciled value, so continuity loss never reaches reportError.
		const binding = bindQuery(spinetab, ticks, {
			queryClient,
			queryKey: ["tick", run],
			map: (tick) => tick.n,
			reconcile: "latest",
			onEvent(tick) {
				probe.extra.ticks.push(tick.n);
			},
		});
		return () => binding.unsubscribe();
	}, [run, ssePath]);
	const tick = useQuery({
		queryKey: ["tick", run],
		queryFn: () => 0,
		enabled: false,
		initialData: 0,
	});

	return (
		<section>
			<p data-testid="status" ref={statusRef}>
				{statusText(status)}
			</p>
			<p data-testid="connection">{subscription.status.connection.state}</p>
			<p data-testid="tick">{String(tick.data)}</p>
			<button
				type="button"
				data-testid="next-scope"
				onClick={() => setScopeIndex((index) => (index + 1) % SCOPES.length)}
			>
				Scope {currentScope}
			</button>
		</section>
	);
}
