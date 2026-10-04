import type { Runtime } from "spinetab/runtime";
import {
	busy,
	type ChannelMessage,
	type RealmTarget,
	type RingCopy,
	timerResolution,
} from "./channel";
import { CHANNEL } from "./event";
import { handleCounts, untracked } from "./instrument";
import { arm, receiptAt, receiptSeq, resetTimed, timedState } from "./timed";

/**
 * Bench responder in the runtime realm. Answers calibration pings and
 * measurement requests over the bench BroadcastChannel. Its own channel and
 * listener are created untracked so they never count as runtime handles.
 */
export function serveRealm(
	realm: string,
	target: RealmTarget,
	runtime: Runtime,
): void {
	untracked(() => {
		const channel = new BroadcastChannel(CHANNEL);
		const reply = (message: ChannelMessage) => channel.postMessage(message);
		channel.addEventListener("message", (event) => {
			const message = event.data as ChannelMessage;
			if (message.kind === "ping" && message.target === target) {
				reply({
					kind: "pong",
					id: message.id,
					at: performance.timeOrigin + performance.now(),
					realm,
				});
				return;
			}
			if (message.kind !== "req" || message.target !== target) return;
			let value: unknown;
			try {
				value = untracked(() => answer(message.op, message.args ?? {}));
			} catch (error) {
				reply({
					kind: "res",
					id: message.id,
					realm,
					runtimeId: runtime.id,
					ok: false,
					error: error instanceof Error ? error.message : String(error),
				});
				return;
			}
			reply({
				kind: "res",
				id: message.id,
				realm,
				runtimeId: runtime.id,
				ok: true,
				value,
			});
		});
	});

	function answer(op: string, args: Record<string, number>): unknown {
		switch (op) {
			case "stats":
				return runtime.stats();
			case "handles":
				return handleCounts();
			case "ring": {
				const copy: RingCopy = {
					at: receiptAt.slice(),
					seq: receiptSeq.slice(),
				};
				return copy;
			}
			case "timed":
				return timedState();
			case "arm":
				arm(args.at ?? Number.POSITIVE_INFINITY);
				return true;
			case "busy":
				return busy(args.ms ?? 0);
			case "resolution":
				return timerResolution();
			case "reset":
				resetTimed();
				return true;
			default:
				throw new Error(`unknown op ${op}`);
		}
	}
}
