import type {
	AdapterConnection,
	AdapterSubscription,
	ConnectionContext,
	RuntimeAdapter,
	SubscriptionSink,
} from "../../core/adapter.ts";
import { reportInterruption } from "../../core/continuity-phase.ts";
import { isSpinetabError, SpinetabError } from "../../core/errors.ts";
import { stableStringify, uniqueKey } from "../../core/identity.ts";
import { mergeHeaders } from "../shared/http.ts";
import {
	createHttpStream,
	type HttpStream,
	type HttpStreamSession,
} from "../shared/http-stream.ts";
import { assertRecord, optionError } from "../shared/options.ts";
import {
	lineFramer,
	ndjsonParser,
	type Parser,
	type ParserContext,
	type ParserFailure,
	type ParserInstance,
} from "./framer.ts";
import {
	canonicalStreamConnection,
	DEFAULT_STREAM_PARSER,
	type StreamConnectionSpec,
	type StreamSubscriptionSpec,
	validateStreamConnection,
	validateStreamSubscription,
} from "./spec.ts";

export {
	type LineFramerOptions,
	lineFramer,
	type NdjsonParserOptions,
	ndjsonParser,
	type Parser,
	type ParserContext,
	type ParserFailure,
	type ParserInstance,
} from "./framer.ts";
export type { StreamConnectionSpec, StreamSubscriptionSpec };

export interface StreamAdapterOptions {
	/**
	 * Named parser factories referenced by `stream({ parser })`. The built-in
	 * `ndjson` (`ndjsonParser()`, the default) and `lines` (`lineFramer()`)
	 * are always registered; a parser given here under either name wins.
	 */
	parsers?: Record<string, Parser<unknown>>;
}

/** Non-repeatable streams are unique and end interrupted on loss; only repeatable streams restart. */
export function streamAdapter(
	options: StreamAdapterOptions = {},
): RuntimeAdapter<StreamConnectionSpec, StreamSubscriptionSpec, unknown> {
	assertRecord(options, "streamAdapter");
	for (const key of Object.keys(options)) {
		if (key !== "parsers") {
			throw optionError(`streamAdapter.${key}`, "is not a supported option.");
		}
	}
	const custom: unknown = options.parsers ?? {};
	assertRecord(custom, "streamAdapter.parsers");
	// Built-ins first so an explicit registration under the same name wins.
	const parsers: Record<string, Parser<unknown>> = {
		ndjson: ndjsonParser(),
		lines: lineFramer(),
	};
	for (const [name, parser] of Object.entries(custom)) {
		if (typeof parser !== "function") {
			throw optionError(
				`streamAdapter.parsers.${name}`,
				"must be a parser factory.",
			);
		}
		parsers[name] = parser as Parser<unknown>;
	}
	return {
		kind: "stream",
		version: 1,
		validateConnection(spec: unknown): asserts spec is StreamConnectionSpec {
			validateStreamConnection(spec, { requireAbsolute: true });
			if (!Object.hasOwn(parsers, spec.parser ?? DEFAULT_STREAM_PARSER)) {
				throw optionError(
					"connection.parser",
					"is not registered in streamAdapter({ parsers }).",
				);
			}
		},
		validateSubscription(
			spec: unknown,
		): asserts spec is StreamSubscriptionSpec {
			validateStreamSubscription(spec);
		},
		connectionKey(spec) {
			// Only explicitly repeatable reads share upstream work.
			// An omitted parser keys as "ndjson".
			return spec.repeatable === true
				? stableStringify(canonicalStreamConnection(spec))
				: uniqueKey();
		},
		connect(spec, ctx) {
			return new StreamConnection(
				spec,
				ctx,
				parsers[spec.parser ?? DEFAULT_STREAM_PARSER] as Parser<unknown>,
			);
		},
	};
}

interface Sub {
	sink: SubscriptionSink<unknown>;
}

class StreamConnection
	implements AdapterConnection<StreamSubscriptionSpec, unknown>
{
	private readonly subs = new Set<Sub>();
	/** Subscriptions live when the response ended; owed the outcome once live again. */
	private readonly lost = new Set<Sub>();
	/** Subscriptions already told of the current loss; cleared once live again. */
	private readonly cut = new Set<Sub>();
	private readonly driver: HttpStream;
	private disposed = false;

	private readonly spec: StreamConnectionSpec;
	private readonly ctx: ConnectionContext;
	private readonly parser: Parser<unknown>;

	constructor(
		spec: StreamConnectionSpec,
		ctx: ConnectionContext,
		parser: Parser<unknown>,
	) {
		this.spec = spec;
		this.ctx = ctx;
		this.parser = parser;
		this.driver = createHttpStream({
			ctx,
			repeatable: spec.repeatable === true,
			authHeaders: spec.authHeaders,
			expectInboundWithinMs: spec.heartbeat?.expectInboundWithinMs,
			endOfBody: "complete",
			request: () => ({
				url: spec.url,
				init: (credentials) => {
					const init: RequestInit = {
						method: spec.method ?? "GET",
						headers: mergeHeaders(spec.headers, credentials),
						credentials: spec.credentials ?? "same-origin",
						cache: "no-store",
					};
					if (spec.body !== undefined) init.body = spec.body;
					return init;
				},
			}),
			accept: (response) => (response.status === 204 ? "complete" : "ok"),
			open: () => this.openSession(),
			// No replay contract: continuity is unknown from the moment the loss
			// is detected (the early notice) and again at reconnect (the outcome,
			// before `connected`), so a consumer that reconciled during the
			// outage reconciles again.
			established: (restart) => {
				const lost = [...this.lost];
				this.lost.clear();
				this.cut.clear();
				for (const sub of lost) {
					if (this.subs.has(sub)) sub.sink.continuity(restart ?? "reconnected");
				}
			},
			lost: () => {
				for (const sub of this.subs) this.lost.add(sub);
			},
			interrupted: (restart) => {
				for (const sub of [...this.lost]) {
					if (this.cut.has(sub) || !this.subs.has(sub)) continue;
					this.cut.add(sub);
					reportInterruption(sub.sink, restart);
				}
			},
			terminal: (error) => this.settle((sink) => sink.error(error)),
			complete: () => this.settle((sink) => sink.complete()),
		});
	}

	subscribe(
		_spec: StreamSubscriptionSpec,
		sink: SubscriptionSink<unknown>,
	): AdapterSubscription {
		const sub: Sub = { sink };
		this.subs.add(sub);
		if (this.subs.size === 1) this.driver.start();
		let active = true;
		return {
			unsubscribe: () => {
				if (!active) return;
				active = false;
				this.subs.delete(sub);
				this.lost.delete(sub);
				this.cut.delete(sub);
				// The last consumer's departure aborts the request.
				if (this.subs.size === 0) this.driver.stop();
			},
		};
	}

	probe(): void {
		this.driver.probe();
	}

	retry(): void {
		this.driver.retry();
	}

	rotate(): void {
		this.driver.rotate();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.driver.dispose();
		this.subs.clear();
		this.lost.clear();
		this.cut.clear();
	}

	private settle(action: (sink: SubscriptionSink<unknown>) => void): void {
		const subs = [...this.subs];
		this.subs.clear();
		this.lost.clear();
		this.cut.clear();
		for (const sub of subs) action(sub.sink);
	}

	private openSession(): HttpStreamSession {
		const limit = this.ctx.limits.maxFrameBytes;
		const skip = this.spec.malformed === "skip";
		const context: ParserContext = {
			maxFrameBytes: limit,
			malformed: (reason) => {
				if (!skip) throw new SpinetabError("malformed-frame", reason);
				this.recordMalformed(reason);
			},
		};
		const parser: ParserInstance<unknown> = this.parser(context);
		const decoder =
			parser.input === "bytes" ? undefined : new TextDecoder("utf-8");
		let sinceFrame = 0;

		const deliver = (frames: unknown[]) => {
			for (const frame of frames) {
				if (parser.heartbeat?.(frame)) continue;
				for (const sub of [...this.subs]) {
					if (this.subs.has(sub)) sub.sink.next(frame);
				}
			}
		};

		const run = (step: () => unknown[], bytes: number) => {
			let frames: unknown[];
			try {
				frames = step();
			} catch (error) {
				// Frames completed before the failure keep their order.
				const partial = (error as ParserFailure | null)?.partial;
				if (Array.isArray(partial)) deliver(partial);
				if (
					isSpinetabError(error, "frame-too-large") ||
					isSpinetabError(error, "malformed-frame")
				) {
					throw error;
				}
				if (!skip) {
					throw new SpinetabError(
						"malformed-frame",
						"The parser threw while framing the response.",
					);
				}
				this.recordMalformed("parser threw");
				frames = [];
			}
			// Frames completed in this step precede a bound failure.
			deliver(frames);
			if (parser.pendingBytes) {
				if (parser.pendingBytes() > limit) throw tooLarge(limit);
			} else {
				sinceFrame = frames.length > 0 ? 0 : sinceFrame + bytes;
				if (sinceFrame > limit) throw tooLarge(limit);
			}
		};

		return {
			push: (chunk) => {
				if (decoder) {
					const text = decoder.decode(chunk, { stream: true });
					run(() => parser.push(text), chunk.byteLength);
				} else {
					run(() => parser.push(chunk), chunk.byteLength);
				}
			},
			end: () => {
				if (decoder) {
					const rest = decoder.decode();
					if (rest !== "") run(() => parser.push(rest), 0);
				}
				run(() => parser.end(), 0);
			},
		};
	}

	private recordMalformed(reason: string): void {
		this.ctx.diagnostic({ type: "malformed-frame", detail: { reason } });
		for (const sub of this.subs) sub.sink.continuity("decode-error");
	}
}

function tooLarge(limit: number): SpinetabError {
	return new SpinetabError(
		"frame-too-large",
		`A frame exceeded ${limit} bytes before completing.`,
		{ detail: { limit } },
	);
}
