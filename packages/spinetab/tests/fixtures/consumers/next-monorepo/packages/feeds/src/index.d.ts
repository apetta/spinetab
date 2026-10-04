// Declarations for the untyped workspace package, so the strict app type-check
// knows `ticks`. Type-only imports: the plugin's scanner skips them, so the
// one `spinetab/sse` value import stays in index.js.
import type { SubscriptionRequest } from "spinetab";
import type { SseConnectionSpec, SseSubscriptionSpec } from "spinetab/sse";

export interface Tick {
	n: number;
}

export declare function ticks(
	path: string,
	run: string,
): SubscriptionRequest<Tick, SseConnectionSpec, SseSubscriptionSpec>;
