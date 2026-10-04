/** Estimate whole backing buffers and own properties; reject unestimable values rather than charging zero. */
const CONTAINER_OVERHEAD = 16;
const SHORT_STRING_LIMIT = 1024;
let encoder: TextEncoder | undefined;

// Native clone serialises internal slots, not shadowed public properties or
// application iterators. Capture the matching readers once, without cloning
// every delivery just to measure it.
const arrayBufferLength = Object.getOwnPropertyDescriptor(
	ArrayBuffer.prototype,
	"byteLength",
)?.get;
const sharedBufferLength =
	typeof SharedArrayBuffer === "undefined"
		? undefined
		: Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, "byteLength")
				?.get;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(
	Object.getPrototypeOf(Uint8Array.prototype),
	"buffer",
)?.get;
const dataViewBuffer = Object.getOwnPropertyDescriptor(
	DataView.prototype,
	"buffer",
)?.get;
const blobSize =
	typeof Blob === "undefined"
		? undefined
		: Object.getOwnPropertyDescriptor(Blob.prototype, "size")?.get;
const blobType =
	typeof Blob === "undefined"
		? undefined
		: Object.getOwnPropertyDescriptor(Blob.prototype, "type")?.get;
const fileName =
	typeof File === "undefined"
		? undefined
		: Object.getOwnPropertyDescriptor(File.prototype, "name")?.get;
const regexpSource = Object.getOwnPropertyDescriptor(
	RegExp.prototype,
	"source",
)?.get;
const mapEntries = Map.prototype.entries;
const setValues = Set.prototype.values;
const errorStackGetter = propertyDescriptor(new Error(), "stack")?.get;

export function estimateBytes(value: unknown): number | undefined {
	try {
		return estimate(value, new Set());
	} catch {
		// Brand checks and hostile proxies can throw. Unsupported values must
		// stop delivery, rather than escape an adapter callback.
		return undefined;
	}
}

function estimate(value: unknown, seen: Set<object>): number | undefined {
	switch (typeof value) {
		case "string":
			return stringBytes(value);
		case "number":
			return 8;
		case "boolean":
			return 1;
		case "bigint":
			return 8 + Math.ceil(value.toString(16).length / 2);
		case "undefined":
			return 1;
		case "object":
			break;
		default:
			return undefined;
	}
	if (value === null) return 1;
	if (seen.has(value)) return CONTAINER_OVERHEAD;
	if (value instanceof ArrayBuffer) return bufferBytes(value);
	if (ArrayBuffer.isView(value)) {
		let buffer: ArrayBufferLike;
		try {
			buffer = typedArrayBuffer?.call(value);
		} catch {
			buffer = dataViewBuffer?.call(value);
		}
		return bufferBytes(buffer);
	}
	if (typeof Blob !== "undefined" && value instanceof Blob) {
		const size = blobSize?.call(value);
		const type = blobType?.call(value);
		if (typeof size !== "number" || typeof type !== "string") return undefined;
		let total = size + stringBytes(type) + CONTAINER_OVERHEAD;
		if (typeof File !== "undefined" && value instanceof File) {
			total += stringBytes(fileName?.call(value)) + 8;
		}
		return total;
	}
	if (value instanceof Date) return 8;
	if (value instanceof RegExp) {
		return stringBytes(regexpSource?.call(value)) + 8;
	}
	if (value instanceof Error) {
		for (const key of ["name", "message", "cause"]) {
			const descriptor = propertyDescriptor(value, key);
			if (descriptor !== undefined && !("value" in descriptor))
				return undefined;
		}
		const stackDescriptor = propertyDescriptor(value, "stack");
		if (
			stackDescriptor !== undefined &&
			!("value" in stackDescriptor) &&
			(stackDescriptor.get === undefined ||
				stackDescriptor.get !== errorStackGetter)
		) {
			return undefined;
		}
		const name = value.name;
		const message = value.message;
		if (typeof name !== "string" || typeof message !== "string")
			return undefined;
		seen.add(value);
		let total = stringBytes(name) + stringBytes(message) + CONTAINER_OVERHEAD;
		const stack = value.stack;
		// Firefox clones its internal stack even when a data property shadows
		// it. Other engines copy the public value. Charge the larger estimate.
		const internalStack =
			stackDescriptor?.get === errorStackGetter
				? stack
				: errorStackGetter?.call(value);
		total += Math.max(
			typeof stack === "string" ? stringBytes(stack) : 0,
			typeof internalStack === "string" ? stringBytes(internalStack) : 0,
		);
		if ("cause" in value) {
			const causeValue = value.cause;
			if (causeValue !== undefined) {
				const cause = estimate(causeValue, seen);
				if (cause === undefined) return undefined;
				total += cause;
			}
		}
		return total;
	}
	seen.add(value);
	if (Array.isArray(value)) {
		let total = CONTAINER_OVERHEAD;
		// Structured clone copies own non-index properties of arrays too, so every
		// own enumerable key is charged, not only the index entries.
		for (const key of Object.keys(value)) {
			if (hasAccessor(value, key)) return undefined;
			const item = (value as unknown as Record<string, unknown>)[key];
			if (!isIndexKey(key)) total += stringBytes(key);
			if (item === undefined) {
				total += 1;
				continue;
			}
			const size = estimate(item, seen);
			if (size === undefined) return undefined;
			total += size;
		}
		return total;
	}
	if (value instanceof Map) {
		let total = CONTAINER_OVERHEAD;
		for (const [key, item] of mapEntries.call(value)) {
			const keySize = estimate(key, seen);
			const itemSize = estimate(item, seen);
			if (keySize === undefined || itemSize === undefined) return undefined;
			total += keySize + itemSize;
		}
		return total;
	}
	if (value instanceof Set) {
		let total = CONTAINER_OVERHEAD;
		for (const item of setValues.call(value)) {
			const size = estimate(item, seen);
			if (size === undefined) return undefined;
			total += size;
		}
		return total;
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return undefined;
	let total = CONTAINER_OVERHEAD;
	for (const key of Object.keys(value as Record<string, unknown>)) {
		if (hasAccessor(value, key)) return undefined;
		const item = (value as Record<string, unknown>)[key];
		// The key is cloned even when the value is undefined.
		total += stringBytes(key);
		if (item === undefined) {
			total += 1;
			continue;
		}
		const size = estimate(item, seen);
		if (size === undefined) return undefined;
		total += size;
	}
	return total;
}

function bufferBytes(value: ArrayBufferLike): number | undefined {
	try {
		return arrayBufferLength?.call(value);
	} catch {
		return sharedBufferLength?.call(value);
	}
}

function propertyDescriptor(
	target: object,
	key: string,
): PropertyDescriptor | undefined {
	for (
		let current: object | null = target;
		current !== null;
		current = Object.getPrototypeOf(current)
	) {
		const descriptor = Object.getOwnPropertyDescriptor(current, key);
		if (descriptor !== undefined) return descriptor;
	}
	return undefined;
}

function hasAccessor(target: object, key: string): boolean {
	const descriptor = Object.getOwnPropertyDescriptor(target, key);
	return descriptor !== undefined && !("value" in descriptor);
}

function isIndexKey(key: string): boolean {
	const index = Number(key);
	return Number.isInteger(index) && index >= 0 && String(index) === key;
}

export function stringBytes(text: string): number {
	if (text.length <= SHORT_STRING_LIMIT) {
		// Conservative upper bound: every UTF-16 code unit encodes to at most
		// three UTF-8 bytes (surrogate pairs use four bytes for two units).
		return text.length * 3;
	}
	encoder ??= new TextEncoder();
	return encoder.encode(text).length;
}
