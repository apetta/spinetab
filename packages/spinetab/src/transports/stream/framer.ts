import { SpinetabError } from "../../core/errors.ts";
import type { Json } from "../../core/types.ts";
import { utf8Length } from "../shared/utf8.ts";

/**
 * Worker-defined response parsers for `spinetab/stream`.
 *
 * A `Parser` is a factory; the adapter creates one instance per response,
 * feeds it in order and calls `end()` exactly once on clean completion. On
 * abort or error the instance is discarded without `end()`. Chunks are not
 * messages: output depends only on the byte sequence, never on how it was
 * split.
 */
export interface ParserContext {
	/** Bound on bytes held since the last completed frame (the core `maxFrameBytes`). */
	readonly maxFrameBytes: number;
	/**
	 * Report a malformed frame without its payload. Under the `error` policy
	 * this throws and fails the response; under `skip` it records a gap and
	 * returns so the parser can continue.
	 */
	malformed(reason: string): void;
}

/**
 * An error thrown from `push`/`end` may carry the frames completed before the
 * failure in `partial`; the adapter delivers them, in order, before failing.
 */
export interface ParserFailure<E = unknown> {
	partial?: E[];
}

export interface ParserInstance<E> {
	push(chunk: Uint8Array | string): E[];
	end(): E[];
	/** Bytes held since the last completed frame; checked after every push. */
	pendingBytes?(): number;
	/** "text" (default): receive strings from a per-response streaming UTF-8 decoder. */
	readonly input?: "text" | "bytes";
	/** Frames classified as heartbeats reset liveness and are not delivered. */
	heartbeat?(frame: E): boolean;
}

export type Parser<E = unknown> = (context: ParserContext) => ParserInstance<E>;

const UNBOUNDED_CONTEXT: ParserContext = {
	maxFrameBytes: Number.POSITIVE_INFINITY,
	malformed(reason) {
		throw new SpinetabError("malformed-frame", reason);
	},
};

export interface LineFramerOptions {
	/** Skip empty lines (after CR stripping). Default false. */
	skipEmpty?: boolean;
	/** Per-line bound; the lower of this and the context's `maxFrameBytes` applies. */
	maxLineBytes?: number;
}

/**
 * LF-delimited lines with one trailing CR stripped. A non-empty final line
 * without a newline is emitted at clean end. Lines longer than the bound
 * throw `frame-too-large` before they are delivered.
 */
export function lineFramer(options: LineFramerOptions = {}): Parser<string> {
	return (context = UNBOUNDED_CONTEXT) =>
		createLines(context, options, (line) => [line]);
}

export interface NdjsonParserOptions {
	/** Skip blank lines (default true, as the NDJSON recipe documents). */
	skipEmpty?: boolean;
	maxLineBytes?: number;
	/** Values classified as heartbeats are not delivered. */
	heartbeat?: (value: Json) => boolean;
}

/**
 * NDJSON recipe: one JSON value per LF-terminated line; blank lines
 * skipped by default; invalid JSON is reported as `malformed-frame` without
 * its content.
 */
export function ndjsonParser(options: NdjsonParserOptions = {}): Parser<Json> {
	const skipEmpty = options.skipEmpty ?? true;
	return (context = UNBOUNDED_CONTEXT) => {
		const instance = createLines<Json>(
			context,
			{ maxLineBytes: options.maxLineBytes },
			(line, lineNumber) => {
				if (line.trim() === "") {
					if (!skipEmpty) context.malformed(`Line ${lineNumber} is blank.`);
					return [];
				}
				try {
					return [JSON.parse(line) as Json];
				} catch {
					context.malformed(`Line ${lineNumber} is not valid JSON.`);
					return [];
				}
			},
		);
		if (options.heartbeat) {
			const heartbeat = options.heartbeat;
			return { ...instance, heartbeat: (value) => heartbeat(value) };
		}
		return instance;
	};
}

function createLines<E>(
	context: ParserContext,
	options: LineFramerOptions,
	emit: (line: string, lineNumber: number) => E[],
): ParserInstance<E> {
	const limit = Math.min(
		options.maxLineBytes ?? Number.POSITIVE_INFINITY,
		context.maxFrameBytes,
	);
	const skipEmpty = options.skipEmpty === true;
	let decoder: TextDecoder | undefined;
	let buffer = "";
	let bufferBytes = 0;
	let lineNumber = 0;

	const tooLarge = () =>
		new SpinetabError(
			"frame-too-large",
			`A line exceeded ${limit} bytes before completing.`,
			{ detail: { limit } },
		);

	const complete = (raw: string, out: E[]) => {
		lineNumber += 1;
		const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
		if (skipEmpty && line === "") return;
		for (const frame of emit(line, lineNumber)) out.push(frame);
	};

	const feed = (text: string): E[] => {
		const out: E[] = [];
		let start = 0;
		let newline = text.indexOf("\n");
		while (newline !== -1) {
			const segmentBytes = utf8Length(text, start, newline);
			if (bufferBytes + segmentBytes > limit)
				throw withPartial(tooLarge(), out);
			const line = buffer + text.slice(start, newline);
			buffer = "";
			bufferBytes = 0;
			try {
				complete(line, out);
			} catch (error) {
				throw withPartial(error, out);
			}
			start = newline + 1;
			newline = text.indexOf("\n", start);
		}
		if (start < text.length) {
			bufferBytes += utf8Length(text, start, text.length);
			// Lines completed in this push precede the failure.
			if (bufferBytes > limit) throw withPartial(tooLarge(), out);
			buffer += text.slice(start);
		}
		return out;
	};

	return {
		push(chunk) {
			if (typeof chunk === "string") return feed(chunk);
			decoder ??= new TextDecoder("utf-8");
			return feed(decoder.decode(chunk, { stream: true }));
		},
		end() {
			const out = decoder ? feed(decoder.decode()) : [];
			const rest = buffer;
			buffer = "";
			bufferBytes = 0;
			if (rest !== "" && rest !== "\r") {
				try {
					complete(rest, out);
				} catch (error) {
					throw withPartial(error, out);
				}
			}
			return out;
		},
		pendingBytes: () => bufferBytes,
	};
}

function withPartial<E>(error: unknown, frames: E[]): unknown {
	if (typeof error === "object" && error !== null && frames.length > 0) {
		(error as ParserFailure<E>).partial = frames;
	}
	return error;
}
