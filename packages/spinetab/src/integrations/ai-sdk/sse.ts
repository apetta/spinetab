import { SpinetabError } from "../../core/errors.ts";

/**
 * Minimal Server-Sent Events `data` parser for the AI SDK UI message stream
 * protocol (`data: <json>\n\n`, terminated by `data: [DONE]`). Follows the
 * HTML event-stream algorithm for what this protocol uses: streaming UTF-8
 * decoding, CR, LF and CRLF line endings (including a CR/LF pair split across
 * chunks), a leading BOM, comment lines, multi-line `data` joined with LF and
 * dispatch on a blank line. Other fields (`event`, `id`, `retry`) are ignored,
 * as the AI SDK's own parser ignores them for this protocol. An incomplete
 * event at the end of the stream is discarded.
 *
 * `maxFrameBytes` bounds the current line (complete or partial) plus the
 * event's pending data, in UTF-8 bytes of the decoded text. Complete and
 * partial lines use the same measure, so for byte input the outcome does not
 * depend on how the network splits chunks.
 */
export interface SseDataParser {
	push(chunk: Uint8Array | string): string[];
	end(): string[];
}

export function createSseDataParser(maxFrameBytes: number): SseDataParser {
	const decoder = new TextDecoder("utf-8");
	let buffer = "";
	let bufferBytes = 0;
	let data: string[] = [];
	let dataBytes = 0;
	let sawAnyText = false;
	let pendingCr = false;

	const consume = (text: string, out: string[]) => {
		if (!sawAnyText && text.length > 0) {
			sawAnyText = true;
			if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
		}
		if (pendingCr && text.startsWith("\n")) text = text.slice(1);
		pendingCr = false;
		// The retained buffer never holds a line terminator, so only new text is
		// scanned and counted.
		const scanFrom = buffer.length;
		buffer += text;
		let start = 0;
		for (let index = scanFrom; index < buffer.length; index += 1) {
			const code = buffer.charCodeAt(index);
			if (code !== 10 && code !== 13) continue;
			if (utf8Length(buffer, start, index) + dataBytes > maxFrameBytes) {
				throw frameTooLarge(maxFrameBytes);
			}
			line(buffer.slice(start, index), out);
			if (code === 13) {
				if (index + 1 === buffer.length) pendingCr = true;
				else if (buffer.charCodeAt(index + 1) === 10) index += 1;
			}
			start = index + 1;
		}
		if (start === 0) {
			// Recount from the last retained unit so a surrogate pair split across
			// string pushes is counted as four bytes, not six.
			const from = Math.max(0, scanFrom - 1);
			bufferBytes +=
				utf8Length(buffer, from) - utf8Length(buffer, from, scanFrom);
		} else {
			buffer = buffer.slice(start);
			bufferBytes = utf8Length(buffer);
		}
		if (bufferBytes + dataBytes > maxFrameBytes) {
			throw frameTooLarge(maxFrameBytes);
		}
	};

	const line = (text: string, out: string[]) => {
		if (text === "") {
			if (data.length > 0) out.push(data.join("\n"));
			data = [];
			dataBytes = 0;
			return;
		}
		if (text.charCodeAt(0) === 58) return; // ":" comment
		const colon = text.indexOf(":");
		const field = colon === -1 ? text : text.slice(0, colon);
		if (field !== "data") return;
		let value = colon === -1 ? "" : text.slice(colon + 1);
		if (value.startsWith(" ")) value = value.slice(1);
		data.push(value);
		dataBytes += utf8Length(value) + 1; // + the LF that joins data lines
		if (dataBytes > maxFrameBytes) throw frameTooLarge(maxFrameBytes);
	};

	return {
		push(chunk) {
			const out: string[] = [];
			consume(
				typeof chunk === "string"
					? chunk
					: decoder.decode(chunk, { stream: true }),
				out,
			);
			return out;
		},
		end() {
			const out: string[] = [];
			consume(decoder.decode(), out);
			buffer = "";
			bufferBytes = 0;
			data = [];
			dataBytes = 0;
			return out;
		},
	};
}

/**
 * UTF-8 encoded length of `text[start, end)` without allocating. Lone
 * surrogates count as three bytes, matching the U+FFFD `TextEncoder` writes.
 * Copied from the transports slice so this entry stays free of transport code.
 */
function utf8Length(text: string, start = 0, end = text.length): number {
	let bytes = 0;
	for (let index = start; index < end; index += 1) {
		const unit = text.charCodeAt(index);
		if (unit < 0x80) bytes += 1;
		else if (unit < 0x800) bytes += 2;
		else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < end) {
			const next = text.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				bytes += 4;
				index += 1;
			} else {
				bytes += 3;
			}
		} else bytes += 3;
	}
	return bytes;
}

function frameTooLarge(limit: number): SpinetabError {
	return new SpinetabError(
		"frame-too-large",
		`An AI UI message stream event exceeded the ${limit}-byte frame limit.`,
		{ detail: { limit } },
	);
}
