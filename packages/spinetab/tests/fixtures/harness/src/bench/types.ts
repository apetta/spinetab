import type { BusyResult, RealmOp } from "./channel";
import type { HandleCounts } from "./instrument";

/**
 * `window.bench` contract shared by the bench pages and the Playwright
 * performance suite (type-only; nothing here is bundled).
 */

export type Variant = "graphql-ws" | "ws";
export type PageKind = "spinetab" | "independent" | "noop" | "empty";

export interface StartOptions {
	variant: Variant;
	/** Spinetab only; default the package default ("prefer"). */
	sharing?: "prefer" | "require" | "off";
	/** Spinetab only: opt-in diagnostics collected by the page. */
	diagnostics?: boolean;
	/** Native variant: first-message auth token (protocol `bench-auth`). */
	secret?: string;
	/** graphql-ws sensitivity row; default the package default. */
	pongTimeoutMs?: number;
	/** Wrap the worker port so `holdAcks()` can stall acknowledgements. */
	ackControl?: boolean;
	/** Record each topic's last delivered event size and body prefix (limits, privacy). */
	inspect?: boolean;
}

export interface Inspection {
	/** Serialised bytes of the last delivered event per topic (0 when none). */
	sizes: number[];
	/** First 32 body characters of the last delivered event per topic. */
	prefixes: string[];
}

export interface PageInfo {
	kind: PageKind;
	pageId: string;
	variant?: Variant;
	mode?: string;
	reason?: string;
	runtimeId?: string;
	health?: string;
	generation?: number;
	visibility: DocumentVisibilityState;
	/** Smallest non-zero `performance.now()` step measured in this page (ms). */
	resolution: number;
	timeOrigin: number;
}

export interface TopicSummary {
	topics: number[];
	counts: number[];
	firstSeq: number[];
	lastSeq: number[];
	/** Events skipped between consecutive delivered seqs. */
	gapEvents: number[];
	duplicates: number[];
	continuity: Array<{ state: string; reason?: string; missed?: number } | null>;
	connection: Array<string | null>;
	errors: Array<string | null>;
	/** Statuses that reported continuity other than `continuous`. */
	lossReports: number[];
	total: number;
	lastAt: number;
}

/** Raw ping-pong samples: [t0 local send, remote stamp, t1 local receive]. */
export type ClockSamples = Array<[number, number, number]>;

export interface LatencySample {
	/** Worker receipt → page callback (calibrated), ms. */
	cross: number[];
	/** Fixture emit → page callback (calibrated), ms. */
	e2e: number[];
	paired: number;
	unpaired: number;
	hidden: number;
}

export interface CommandResult {
	status: string;
	code?: string;
	at: number;
}

export interface RealmReply<T> {
	realm: string;
	runtimeId: string;
	value: T;
}

export interface StatsSample {
	at: number;
	value: unknown;
}

export interface BenchApi {
	ready: boolean;
	start(options: StartOptions): Promise<PageInfo>;
	info(): PageInfo;
	subscribe(topics: number[], connectionQuery?: string): number;
	unsubscribe(topics?: number[]): number;
	markReconciled(topics?: number[]): number;
	summary(topics?: number[]): TopicSummary;
	/** Watch for the first callback per topic at or after `at` (default now); returns `at`. */
	arm(at?: number): number;
	firstAfter(topics: number[]): { first: number; all: number; missing: number };
	lastEventAt(): number;
	commands(count: number, payload?: string): void;
	commandResults(): Array<CommandResult | null>;
	checkHealth(
		reason: string,
	): Promise<{ at: number; done: number; health: string }>;
	/** Dispatch a synthetic `online` event; returns the dispatch time. */
	online(): number;
	busy(ms: number): BusyResult;
	holdAcks(hold: boolean): number;
	diagnostics(): unknown[];
	statusHistory(): unknown[];
	handles(): HandleCounts;
	calibrate(samples?: number, spacingMs?: number): Promise<ClockSamples>;
	calibrateServer(samples?: number, spacingMs?: number): Promise<ClockSamples>;
	latency(
		from: number,
		to: number,
		crossOffset: number | null,
		serverOffset: number | null,
		includeHidden?: boolean,
	): Promise<LatencySample>;
	realm<T>(op: RealmOp, args?: Record<string, number>): Promise<RealmReply<T>>;
	sampleStats(action: "start" | "stop", intervalMs?: number): StatsSample[];
	inspect(): Inspection;
	pageErrors(): string[];
	dispose(): void;
}

export type BenchWindow = { bench: BenchApi };
