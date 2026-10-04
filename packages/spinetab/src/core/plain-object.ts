/**
 * Plain-object check shared by the page client, the runtime and adapters.
 * Kept apart from the option guards in `validate.ts` so the core runtime does
 * not import them.
 */
export function isPlainObject(
	value: unknown,
): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}
