export type ExampleKind = "orbit" | "transit";
export type ExampleMode = "shared" | "local";

export interface Experiment {
	kind: ExampleKind;
	group: string;
	epoch: string;
	mode: ExampleMode;
	orbitEndpoint: string;
	transitEndpoint: string;
	snapshotEndpoint: string;
	intervalMs: number;
}

export interface NetworkSnapshot {
	type: "network";
	source: string;
	epoch: string;
	requests: number;
	completed: number;
	active: number;
	lastRequest: number;
	lastUpdate: number;
}

export interface TabSnapshot {
	type: "tab";
	id: string;
	joinedAt: number;
	epoch: string;
	mode: string;
	runtimeId: string | undefined;
	connected: boolean;
	received: number;
	valueTime: number;
	visible: boolean;
	at: number;
}

export function channelName(kind: ExampleKind, group: string) {
	return `spinetab-example:${kind}:${group}`;
}

export function isLoopback(hostname: string) {
	return ["127.0.0.1", "localhost", "[::1]"].includes(hostname);
}

function endpointOverride(
	params: URLSearchParams,
	key: string,
	fallback: string,
) {
	if (!isLoopback(location.hostname)) return fallback;
	const value = params.get(key);
	if (!value) return fallback;
	try {
		const url = new URL(value);
		if (isLoopback(url.hostname) && ["http:", "ws:"].includes(url.protocol))
			return url.href;
	} catch {}
	return fallback;
}

export function readExperiment(kind: ExampleKind): Experiment {
	const url = new URL(location.href);
	const requested = url.searchParams.get("group") ?? "";
	const group = /^[a-zA-Z0-9-]{1,80}$/.test(requested)
		? requested
		: crypto.randomUUID();
	const stored = readMode(kind, group);
	const mode =
		stored?.mode ??
		(url.searchParams.get("mode") === "local" ? "local" : "shared");
	const epoch = stored?.epoch ?? "initial";
	url.searchParams.set("group", group);
	url.searchParams.set("mode", mode);
	history.replaceState(null, "", url);
	const transitEndpoint = endpointOverride(
		url.searchParams,
		"transitEndpoint",
		"wss://api.entur.io/realtime/v2/vehicles/subscriptions",
	);
	const snapshotEndpoint = transitEndpoint.startsWith("ws://")
		? transitEndpoint.replace("ws://", "http://")
		: "https://api.entur.io/realtime/v2/vehicles/graphql";
	return {
		kind,
		group,
		epoch,
		mode,
		orbitEndpoint: endpointOverride(
			url.searchParams,
			"orbitEndpoint",
			"https://api.wheretheiss.at/v1/satellites/25544",
		),
		transitEndpoint,
		snapshotEndpoint,
		intervalMs: isLoopback(
			new URL(
				endpointOverride(
					url.searchParams,
					"orbitEndpoint",
					"https://api.wheretheiss.at/v1/satellites/25544",
				),
			).hostname,
		)
			? 1_000
			: 5_000,
	};
}

export function readMode(
	kind: ExampleKind,
	group: string,
): { mode: ExampleMode; epoch: string } | null {
	try {
		const value = JSON.parse(
			localStorage.getItem(`${channelName(kind, group)}:mode`) ?? "null",
		);
		if (
			value &&
			(value.mode === "shared" || value.mode === "local") &&
			typeof value.epoch === "string"
		)
			return value;
	} catch {
		/* Mode persistence is optional when storage is unavailable. */
	}
	return null;
}

export function saveMode(experiment: Experiment) {
	try {
		localStorage.setItem(
			`${channelName(experiment.kind, experiment.group)}:mode`,
			JSON.stringify({ mode: experiment.mode, epoch: experiment.epoch }),
		);
	} catch {
		/* The live control channel still works without storage. */
	}
}

export function workerName(experiment: Experiment) {
	return `${channelName(experiment.kind, experiment.group)}:${experiment.epoch}`;
}

export function workerExperiment(
	kind: ExampleKind,
): Pick<Experiment, "kind" | "group" | "epoch"> {
	const name = (globalThis as unknown as { name?: string }).name ?? "";
	const parts = name.split(":");
	if (
		parts[0] !== "spinetab-example" ||
		parts[1] !== kind ||
		!parts[2] ||
		!parts[3]
	)
		throw new Error("Invalid example worker name.");
	return { kind, group: parts[2], epoch: parts[3] };
}
