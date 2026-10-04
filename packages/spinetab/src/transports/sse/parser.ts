import { SpinetabError } from "../../core/errors.ts";
import { utf8Length } from "../shared/utf8.ts";

/**
 * Incremental `text/event-stream` parser following the HTML "interpreting an
 * event stream" algorithm:
 * https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation
 *
 * - UTF-8 is decoded in streaming mode; one leading BOM per stream is removed.
 * - CRLF, LF and lone CR end lines, including a CR and LF split across chunks.
 * - Comment lines are ignored; a line without a colon is a field with an empty value.
 * - `id` containing U+0000 is ignored; an empty `id` resets the cursor.
 * - The last event ID is committed at dispatch, including for blocks without data.
 * - `retry` accepts ASCII digits only.
 * - An incomplete final event is discarded at end of stream.
 *
 * Retained bytes are bounded: the unterminated line, the event data,
 * the event type and the last event ID buffer, which is copied into every later
 * event. A completed line is charged at its full length before it is
 * interpreted, so the outcome never depends on chunk boundaries. Crossing the
 * bound throws `frame-too-large`; its `partial` carries the events dispatched
 * earlier in the same call, in order, so every chunking yields the same events
 * before the failure.
 */
export interface ServerSentEvent {
	/** Event type; `message` when the stream set none. */
	type: string;
	data: string;
	/** Last event ID at dispatch; empty when none or reset. */
	lastEventId: string;
}

export interface ServerSentEventParser {
	/** Throws `frame-too-large` past the bound, with `partial` as described above. */
	push(chunk: Uint8Array | string): ServerSentEvent[];
	/** End of body: flush the decoder and discard any incomplete event. */
	end(): ServerSentEvent[];
	/** Retained UTF-8 bytes: unterminated line, event data, event type and ID buffer. */
	pendingBytes(): number;
	/** Committed cursor (last event ID string of the source). */
	readonly lastEventId: string;
	/** Latest valid `retry:` value in milliseconds, if any. */
	readonly retry: number | undefined;
}

export interface ServerSentEventParserOptions {
	/** Cursor carried from a previous response (the event source's last event ID). */
	lastEventId?: string;
	/** Bound on retained bytes (see `pendingBytes`); default unbounded. */
	maxPendingBytes?: number;
}

export function parseServerSentEvents(
	options: ServerSentEventParserOptions = {},
): ServerSentEventParser {
	const maxPendingBytes = options.maxPendingBytes ?? Number.POSITIVE_INFINITY;
	let decoder: TextDecoder | undefined;
	let started = false;
	let skipLeadingLineFeed = false;
	let line = "";
	let lineBytes = 0;
	let data = "";
	let dataBytes = 0;
	let hasData = false;
	let eventType = "";
	let eventTypeBytes = 0;
	let idBuffer = options.lastEventId ?? "";
	let idBufferBytes = utf8Length(idBuffer);
	let lastEventId = idBuffer;
	let retry: number | undefined;

	const retainedBytes = () =>
		lineBytes + dataBytes + eventTypeBytes + idBufferBytes;

	const processLine = (text: string, out: ServerSentEvent[]) => {
		if (text === "") {
			lastEventId = idBuffer;
			if (hasData) {
				out.push({
					type: eventType === "" ? "message" : eventType,
					data: data.endsWith("\n") ? data.slice(0, -1) : data,
					lastEventId,
				});
			}
			data = "";
			dataBytes = 0;
			hasData = false;
			eventType = "";
			eventTypeBytes = 0;
			return;
		}
		if (text.charCodeAt(0) === 0x3a) return;
		const colon = text.indexOf(":");
		let field: string;
		let value: string;
		if (colon === -1) {
			field = text;
			value = "";
		} else {
			field = text.slice(0, colon);
			value = text.slice(
				text.charCodeAt(colon + 1) === 0x20 ? colon + 2 : colon + 1,
			);
		}
		switch (field) {
			case "event":
				eventType = value;
				eventTypeBytes = utf8Length(value);
				break;
			case "data":
				data += `${value}\n`;
				dataBytes += utf8Length(value) + 1;
				hasData = true;
				break;
			case "id":
				if (!value.includes("\u0000")) {
					idBuffer = value;
					idBufferBytes = utf8Length(value);
				}
				break;
			case "retry":
				if (/^[0-9]+$/.test(value)) retry = Number(value);
				break;
			default:
				break;
		}
	};

	/** `out` holds the events dispatched earlier in this call. */
	const checkBound = (out: ServerSentEvent[]) => {
		if (retainedBytes() > maxPendingBytes) {
			const error = new SpinetabError(
				"frame-too-large",
				`Server-sent event exceeded ${maxPendingBytes} bytes before completing.`,
				{ detail: { limit: maxPendingBytes } },
			);
			throw out.length > 0 ? Object.assign(error, { partial: out }) : error;
		}
	};

	const feed = (text: string): ServerSentEvent[] => {
		const out: ServerSentEvent[] = [];
		let input = text;
		if (!started && input.length > 0) {
			started = true;
			if (input.charCodeAt(0) === 0xfeff) input = input.slice(1);
		}
		let index = 0;
		if (skipLeadingLineFeed && input.length > 0) {
			skipLeadingLineFeed = false;
			if (input.charCodeAt(0) === 0x0a) index = 1;
		}
		let lineStart = index;
		for (; index < input.length; index += 1) {
			const unit = input.charCodeAt(index);
			if (unit !== 0x0a && unit !== 0x0d) continue;
			const complete = line + input.slice(lineStart, index);
			// Charge the whole line with the retained buffers before interpreting
			// it: the same total a byte-at-a-time delivery reaches just before the
			// terminator. Interpreting a line never raises the total above this.
			lineBytes += utf8Length(input, lineStart, index);
			checkBound(out);
			line = "";
			lineBytes = 0;
			processLine(complete, out);
			if (unit === 0x0d) {
				if (index + 1 < input.length) {
					if (input.charCodeAt(index + 1) === 0x0a) index += 1;
				} else {
					skipLeadingLineFeed = true;
				}
			}
			lineStart = index + 1;
		}
		if (lineStart < input.length) {
			line += input.slice(lineStart);
			lineBytes += utf8Length(input, lineStart, input.length);
			checkBound(out);
		}
		return out;
	};

	return {
		push(chunk) {
			if (typeof chunk === "string") return feed(chunk);
			// TextDecoder removes one leading BOM per stream by default.
			decoder ??= new TextDecoder("utf-8");
			started = true;
			return feed(decoder.decode(chunk, { stream: true }));
		},
		end() {
			const out = decoder ? feed(decoder.decode()) : [];
			line = "";
			lineBytes = 0;
			data = "";
			dataBytes = 0;
			hasData = false;
			eventType = "";
			eventTypeBytes = 0;
			return out;
		},
		pendingBytes: retainedBytes,
		get lastEventId() {
			return lastEventId;
		},
		get retry() {
			return retry;
		},
	};
}
