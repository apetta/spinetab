/**
 * UTF-8 encoded length of a string without allocating. Lone surrogates count
 * as three bytes, matching the U+FFFD replacement `TextEncoder` writes.
 */
export function utf8Length(text: string, start = 0, end = text.length): number {
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

/** Fast upper bound first, exact encoding only near the limit. */
export function exceedsUtf8(text: string, limit: number): boolean {
	if (text.length > limit) return true;
	if (text.length * 3 <= limit) return false;
	return utf8Length(text) > limit;
}
