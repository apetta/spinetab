import { lazy, Suspense, useEffect, useRef, useState } from "react";
import DeliveryDiagram from "./DeliveryDiagram";
import type { ExampleFeed } from "./feed";
import type { OrbitSample } from "./OrbitView";
import {
	channelName,
	type ExampleKind,
	type Experiment,
	type NetworkSnapshot,
	readExperiment,
	readMode,
	saveMode,
	type TabSnapshot,
} from "./protocol";
import type { TransitVehicle } from "./TransitView";
import "./examples.css";

const OrbitView = lazy(() => import("./OrbitView"));
const TransitView = lazy(() => import("./TransitView"));
type NetworkRecord = NetworkSnapshot & { seen: number };
type ReadRecord = { id: string; source: string; epoch: string; at: number };
type Presence = {
	mode: string;
	runtimeId: string | undefined;
	connected: boolean;
	received: number;
	valueTime: number;
};

export default function ExampleDemo({ kind }: { kind: ExampleKind }) {
	const [experiment, setExperiment] = useState<Experiment | null>(null);
	const [sample, setSample] = useState<OrbitSample | null>(null);
	const [history, setHistory] = useState<OrbitSample[]>([]);
	const [vehicles, setVehicles] = useState<readonly TransitVehicle[]>([]);
	const [mode, setMode] = useState("inactive");
	const [runtimeId, setRuntimeId] = useState<string>();
	const [launching, setLaunching] = useState(false);
	const [connected, setConnected] = useState(false);
	const [received, setReceived] = useState(0);
	const [error, setError] = useState<string | null>(null);
	const [paused, setPaused] = useState(false);
	const [now, setNow] = useState(0);
	const [tabs, setTabs] = useState<TabSnapshot[]>([]);
	const [networks, setNetworks] = useState<NetworkRecord[]>([]);
	const [reads, setReads] = useState<ReadRecord[]>([]);
	const [channelAvailable, setChannelAvailable] = useState(true);
	const tabId = useRef("");
	const joinedAt = useRef(0);
	const channel = useRef<BroadcastChannel | null>(null);
	const announceTab = useRef<((snapshot: Presence) => void) | null>(null);
	const tabRecords = useRef(new Map<string, TabSnapshot>());
	const networkRecords = useRef(new Map<string, NetworkRecord>());
	const valueTime =
		kind === "orbit"
			? (sample?.timestamp ?? 0) * 1_000
			: Math.max(
					0,
					...vehicles.map((vehicle) => Date.parse(vehicle.lastUpdated)),
				);
	const current = useRef({
		experiment,
		mode,
		runtimeId,
		connected,
		received,
		valueTime,
	});
	current.current = {
		experiment,
		mode,
		runtimeId,
		connected,
		received,
		valueTime,
	};
	const launchPending = useRef(false);
	const launchPeers = useRef(new Set<string>());
	const launchTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
	const root = useRef<HTMLDivElement>(null);
	const onScreen = useRef(true);
	const group = experiment?.group;

	useEffect(() => {
		tabId.current = crypto.randomUUID();
		joinedAt.current = Date.now();
		setExperiment(readExperiment(kind));
		return () => clearTimeout(launchTimer.current);
	}, [kind]);

	useEffect(() => {
		if (!group) return;
		if (typeof BroadcastChannel === "undefined") {
			setChannelAvailable(false);
			setError(
				"This browser cannot measure the tab comparison. The source code is available below.",
			);
			return;
		}
		const bus = new BroadcastChannel(channelName(kind, group));
		channel.current = bus;
		let allHiddenAt = 0;
		const announce = (snapshot?: Presence) => {
			const value = { ...current.current, ...snapshot };
			const tab: TabSnapshot = {
				type: "tab",
				id: tabId.current,
				joinedAt: joinedAt.current,
				epoch: value.experiment?.epoch ?? "initial",
				mode: value.mode,
				runtimeId: value.runtimeId,
				connected: value.connected,
				received: value.received,
				valueTime: value.valueTime,
				visible: document.visibilityState === "visible" && onScreen.current,
				at: Date.now(),
			};
			tabRecords.current.set(tab.id, tab);
			setTabs([...tabRecords.current.values()]);
			bus.postMessage(tab);
		};
		announceTab.current = announce;
		const update = () => {
			const time = Date.now();
			announce();
			for (const [id, tab] of tabRecords.current)
				if (time - tab.at > 10_000) tabRecords.current.delete(id);
			const participants = [...tabRecords.current.values()];
			setTabs(participants);
			setNetworks([...networkRecords.current.values()]);
			setNow(time);
			bus.postMessage({ type: "network-request" });
			if (participants.some((tab) => tab.visible)) {
				allHiddenAt = 0;
				setPaused(false);
			} else {
				allHiddenAt ||= time;
				if (time - allHiddenAt >= 120_000) setPaused(true);
			}
		};
		const message = (event: MessageEvent) => {
			const value = event.data;
			if (!value || typeof value !== "object") return;
			if (
				value.type === "tab" &&
				typeof value.id === "string" &&
				Number.isFinite(value.joinedAt) &&
				typeof value.at === "number"
			) {
				tabRecords.current.set(value.id, value);
				if (
					launchPending.current &&
					!launchPeers.current.has(value.id) &&
					value.epoch === current.current.experiment?.epoch
				) {
					launchPending.current = false;
					clearTimeout(launchTimer.current);
					setLaunching(false);
				}
				setTabs([...tabRecords.current.values()]);
			} else if (value.type === "leave") {
				tabRecords.current.delete(value.id);
				setTabs([...tabRecords.current.values()]);
			} else if (
				value.type === "network" &&
				typeof value.source === "string" &&
				Number.isFinite(value.active) &&
				Number.isFinite(value.requests)
			) {
				const previous = networkRecords.current.get(value.source);
				if (
					value.requests > (previous?.requests ?? 0) &&
					value.lastRequest > 0
				) {
					setReads((records) =>
						[
							...records,
							{
								id: `${value.source}:${value.requests}`,
								source: value.source,
								epoch: value.epoch,
								at: value.lastRequest,
							},
						].slice(-12),
					);
				}
				networkRecords.current.set(value.source, {
					...value,
					seen: Date.now(),
				});
				if (networkRecords.current.size > 128) {
					const oldest = networkRecords.current.keys().next().value;
					if (oldest) networkRecords.current.delete(oldest);
				}
				if (
					!previous ||
					value.requests !== previous.requests ||
					value.active !== previous.active ||
					value.completed !== previous.completed ||
					value.lastUpdate !== previous.lastUpdate
				)
					setNetworks([...networkRecords.current.values()]);
			} else if (
				value.type === "mode" &&
				(value.mode === "shared" || value.mode === "local") &&
				typeof value.epoch === "string"
			) {
				const latest = readMode(kind, group) ?? value;
				setExperiment((previous) =>
					previous &&
					(previous.mode !== latest.mode || previous.epoch !== latest.epoch)
						? { ...previous, mode: latest.mode, epoch: latest.epoch }
						: previous,
				);
			} else if (value.type === "hello") announce();
			else if (value.type === "control-request") {
				const saved = current.current.experiment;
				if (saved)
					bus.postMessage({
						type: "mode",
						mode: saved.mode,
						epoch: saved.epoch,
					});
			}
		};
		bus.addEventListener("message", message);
		bus.postMessage({ type: "hello" });
		update();
		const timer = window.setInterval(update, 1_000);
		const visibility = () => {
			announce();
			if (document.visibilityState === "visible") setPaused(false);
		};
		const leave = () => bus.postMessage({ type: "leave", id: tabId.current });
		const restore = (event: PageTransitionEvent) => {
			if (event.persisted) {
				announce();
				setExperiment(readExperiment(kind));
				bus.postMessage({ type: "control-request" });
			}
		};
		document.addEventListener("visibilitychange", visibility);
		window.addEventListener("pagehide", leave);
		window.addEventListener("pageshow", restore);
		const observer = new IntersectionObserver((entries) => {
			onScreen.current = entries[0]?.isIntersecting ?? false;
			visibility();
		});
		if (root.current) observer.observe(root.current);
		return () => {
			leave();
			observer.disconnect();
			clearInterval(timer);
			document.removeEventListener("visibilitychange", visibility);
			window.removeEventListener("pagehide", leave);
			window.removeEventListener("pageshow", restore);
			bus.close();
			channel.current = null;
			announceTab.current = null;
		};
	}, [kind, group]);

	useEffect(() => {
		announceTab.current?.({ mode, runtimeId, connected, received, valueTime });
	}, [mode, runtimeId, connected, received, valueTime]);

	useEffect(() => {
		if (!experiment || !channelAvailable || paused) {
			setConnected(false);
			setReceived(0);
			return;
		}
		let cancelled = false;
		let feed: ExampleFeed | undefined;
		setConnected(false);
		setReceived(0);
		setError(null);
		setMode("starting");
		const callbacks = {
			data(value: unknown) {
				if (cancelled) return;
				setError(null);
				if (kind === "orbit") {
					const next = value as OrbitSample;
					setSample(next);
					setHistory((previous) =>
						previous.at(-1)?.timestamp === next.timestamp
							? previous
							: [...previous, next].slice(-48),
					);
				} else setVehicles(value as readonly TransitVehicle[]);
			},
			received() {
				if (!cancelled) setReceived((value) => value + 1);
			},
			mode(value: string, id?: string) {
				if (!cancelled) {
					setMode(value);
					setRuntimeId(id);
				}
			},
			connection(value: boolean) {
				if (!cancelled) setConnected(value);
			},
			error(message: string) {
				if (!cancelled) setError(message);
			},
		};
		void (async () => {
			if (kind === "orbit") {
				const module = await import("./orbit-feed");
				if (!cancelled) feed = module.startOrbitFeed(experiment, callbacks);
			} else {
				const module = await import("./transit-feed");
				if (!cancelled) feed = module.startTransitFeed(experiment, callbacks);
			}
		})().catch((cause) =>
			callbacks.error(
				cause instanceof Error
					? cause.message
					: "Could not start this example.",
			),
		);
		const suspend = () => {
			cancelled = true;
			feed?.stop();
			setConnected(false);
		};
		window.addEventListener("pagehide", suspend);
		return () => {
			cancelled = true;
			feed?.stop();
			window.removeEventListener("pagehide", suspend);
		};
	}, [experiment, kind, paused, channelAvailable]);

	useEffect(() => {
		if (!experiment) return;
		const url = new URL(location.href);
		url.searchParams.set("mode", experiment.mode);
		historyReplace(url);
	}, [experiment]);

	const active = networks.reduce((total, source) => total + source.active, 0);
	const currentNetworks = networks.filter(
		(source) => source.epoch === experiment?.epoch,
	);
	const requests = currentNetworks.reduce(
		(total, source) => total + source.requests,
		0,
	);
	const unknown = networks.some(
		(source) => source.active > 0 && now - source.seen > 12_000,
	);
	const currentTabs = tabs
		.filter((tab) => tab.epoch === experiment?.epoch && tab.mode !== "disposed")
		.sort((a, b) => a.joinedAt - b.joinedAt || a.id.localeCompare(b.id));
	const participating = currentTabs.filter((tab) => tab.connected);
	const runtimes = new Set(participating.map((tab) => tab.runtimeId));
	const schedules = currentNetworks.filter(
		(source) => runtimes.has(source.source) && source.requests > 0,
	).length;
	const pendingSwitch =
		tabs.some((tab) => tab.epoch !== experiment?.epoch) ||
		networks.some(
			(source) => source.epoch !== experiment?.epoch && source.active > 0,
		);
	const stale =
		kind === "orbit"
			? !sample || now - sample.timestamp * 1_000 > 30_000
			: vehicles.length === 0 ||
				vehicles.every(
					(vehicle) => now - Date.parse(vehicle.lastUpdated) > 120_000,
				);
	const phase = error
		? "error"
		: paused
			? "paused"
			: pendingSwitch
				? "switching"
				: connected &&
						received > 0 &&
						!unknown &&
						participating.some((tab) => tab.id === tabId.current) &&
						(kind === "orbit" ? schedules > 0 : active > 0)
					? "live"
					: "starting";
	const allReceiving =
		participating.length >= 2 && participating.every((tab) => tab.received > 0);
	const shared = experiment?.mode !== "local";
	const fallback = shared && mode === "local";
	const proof =
		shared &&
		phase === "live" &&
		!stale &&
		allReceiving &&
		runtimes.size === 1 &&
		participating.every(
			(tab) => tab.mode === "shared" && Boolean(tab.runtimeId),
		) &&
		currentNetworks.some((source) => runtimes.has(source.source)) &&
		(kind !== "orbit" ||
			participating.every((tab) => tab.valueTime === valueTime)) &&
		!fallback &&
		(kind === "orbit" ? schedules === 1 : active === 1);
	const title =
		kind === "orbit" ? "Your window on orbit." : "A live window into Oslo.";
	const openTab = () => {
		if (!experiment || launchPending.current || currentTabs.length >= 3) return;
		launchPending.current = true;
		launchPeers.current = new Set(tabRecords.current.keys());
		setLaunching(true);
		launchTimer.current = setTimeout(() => {
			launchPending.current = false;
			setLaunching(false);
		}, 15_000);
		const url = new URL(location.href);
		url.searchParams.set("group", experiment.group);
		url.searchParams.set("mode", experiment.mode);
		window.open(url.href, "_blank", "noopener,noreferrer");
	};
	const changeMode = (nextMode: Experiment["mode"]) => {
		if (!experiment) return;
		const next: Experiment = {
			...experiment,
			mode: nextMode,
			epoch: crypto.randomUUID(),
		};
		saveMode(next);
		channel.current?.postMessage({
			type: "mode",
			mode: next.mode,
			epoch: next.epoch,
		});
		setExperiment(next);
	};
	return (
		<div
			ref={root}
			className={`not-content example-demo example-demo--${kind}`}
			data-phase={phase}
			data-proven={proof}
		>
			<div className="example-invitation">
				<div>
					<h2>{title}</h2>
					<p>
						{kind === "orbit"
							? "Follow the ISS. Open a second view to share the work."
							: "Pick a vehicle in each tab. Keep your own view, share the live feed."}
					</p>
				</div>
				<button
					type="button"
					className="example-primary"
					onClick={openTab}
					disabled={!experiment || launching || currentTabs.length >= 3}
				>
					{launching
						? "Opening another tab…"
						: tabs.length < 2
							? "Open a second tab"
							: "Open another tab"}
					<svg viewBox="0 0 24 24" aria-hidden="true">
						<path d="M5 19 19 5M5 5h14v14" />
					</svg>
				</button>
			</div>
			<div className="example-sharing">
				<div className="example-proof" aria-live="polite" aria-atomic="true">
					<div className="example-proof-numbers">
						<strong>
							<span data-testid="example-tabs">{participating.length}</span>{" "}
							{participating.length === 1 ? "tab" : "tabs"}
						</strong>
						<svg
							className="example-proof-join"
							viewBox="0 0 24 24"
							aria-hidden="true"
						>
							<path d="M4 12h16M8 8l-4 4 4 4m8-8 4 4-4 4" />
						</svg>
						<strong>
							<span data-testid="example-upstreams">
								{unknown ? "…" : kind === "transit" ? active : schedules}
							</span>{" "}
							{kind === "transit"
								? active === 1
									? "connection"
									: "connections"
								: schedules === 1
									? "polling feed"
									: "polling feeds"}
						</strong>
					</div>
					<p>
						{error
							? "The live source needs attention."
							: paused
								? "Paused while all views are away."
								: phase === "switching"
									? "Switching connections…"
									: fallback
										? "Sharing is unavailable here. This tab is running locally."
										: proof
											? kind === "orbit"
												? participating.length === 2
													? "One polling schedule is supplying both views."
													: "One polling schedule is supplying all three views."
												: participating.length === 2
													? "Both tabs are receiving one shared feed."
													: "All three tabs are receiving one shared feed."
											: phase === "live"
												? shared
													? "Ready. Open a second tab to see sharing."
													: "Each tab is running its own upstream work."
												: connected
													? "Connected. Waiting for a live update…"
													: "Connecting to the live source…"}
					</p>
				</div>
				<div className="example-controls">
					<span className="example-execution">
						<span
							className={`example-status-dot ${phase === "live" ? "is-live" : ""}`}
						/>
						{shared && !fallback ? "With Spinetab" : "One connection per tab"}
						<span
							className="example-test-value"
							data-testid="example-mode"
							aria-hidden="true"
						>
							{mode}
						</span>
					</span>
					<button
						type="button"
						onClick={() => changeMode(shared ? "local" : "shared")}
						disabled={!experiment || pendingSwitch}
					>
						{shared ? "Compare per-tab connections" : "Share connections"}
					</button>
				</div>
				<DeliveryDiagram
					kind={kind}
					tabs={currentTabs}
					ownId={tabId.current}
					shared={shared && !fallback}
					pending={phase === "starting" || phase === "switching"}
				/>
			</div>
			<div className="example-art">
				<Suspense
					fallback={
						<div className="example-art-loading">Preparing the live view…</div>
					}
				>
					{kind === "orbit" ? (
						<OrbitView sample={sample} history={history} stale={stale} />
					) : (
						<TransitView vehicles={vehicles} stale={stale} />
					)}
				</Suspense>
			</div>
			{error && (
				<div className="example-error" data-testid="example-error">
					<p>{error}</p>
					<button
						type="button"
						onClick={() => changeMode(experiment?.mode ?? "shared")}
					>
						Try again
					</button>
				</div>
			)}
			{kind === "orbit" && (
				<details className="example-reads">
					<summary>Inspect the actual requests</summary>
					<div>
						<span>Recent HTTP reads</span>
						<span>
							<span data-testid="example-requests">{requests}</span> in this
							mode
						</span>
					</div>
					<ol>
						{reads
							.filter((read) => read.epoch === experiment?.epoch)
							.slice(-5)
							.reverse()
							.map((read) => (
								<li key={read.id}>
									<time dateTime={new Date(read.at).toISOString()}>
										{clock(read.at)}
									</time>
									<span>
										{shared && !fallback
											? "Shared worker"
											: `Polling feed ${currentNetworks.findIndex((source) => source.source === read.source) + 1}`}
									</span>
									<span>Request started</span>
								</li>
							))}
					</ol>
				</details>
			)}
			<p className="example-footnote">
				{kind === "orbit"
					? "Requests are counted where they run. Background polling stays active during this comparison; all views pause after two minutes away."
					: "Connections are counted from real socket events. Each tab loads its starting fleet with an HTTP query; live updates share the WebSocket."}
			</p>
			<span
				className="example-test-value"
				data-testid="example-received"
				aria-hidden="true"
			>
				{received}
			</span>
			<span
				className="example-test-value"
				data-testid="example-stale"
				aria-hidden="true"
			>
				{String(stale)}
			</span>
			<span
				className="example-test-value"
				data-testid="example-phase"
				aria-hidden="true"
			>
				{phase}
			</span>
		</div>
	);
}

function historyReplace(url: URL) {
	window.history.replaceState(null, "", url);
}
function clock(time: number) {
	return new Date(time).toISOString().slice(11, 19);
}
