import fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Node-realm import probe:
 *
 * node tests/package/import-probe.ts <import|require> <specifier> [peer,…] [marker]
 *
 * Loads the listed peers first (their own module effects are not Spinetab's),
 * installs spies on network, worker, timer, listener, storage, messaging and
 * logging globals, on every `fs` write (sync, callback and promise forms) and
 * on `process.env` reads, snapshots the global object's own keys, loads the
 * entry, and prints the calls made from Spinetab's `dist/` code and the
 * global changes as JSON. `marker` replaces the `dist/` directory that
 * attributes a call (the control fixture only). Run from the package root so
 * the specifier self-references the built exports.
 */
const [
	mode = "import",
	specifier = "spinetab",
	peerList = "",
	markerArgument = "",
] = process.argv.slice(2);
const require = createRequire(import.meta.url);
const load = (id: string): Promise<unknown> =>
	mode === "require" ? Promise.resolve(require(id)) : import(id);

for (const peer of peerList.split(",").filter(Boolean)) await load(peer);

/**
 * Both spellings of a path as stack frames print it: CommonJS frames carry
 * the raw path, ESM frames the percent-encoded `file:` URL. A checkout path
 * with a space or a non-ASCII character differs between the two, and a
 * marker in only one form would attribute nothing and pass vacuously.
 */
const spellings = (path: string) => [path, pathToFileURL(path).href];
const onPath = (frame: string, forms: readonly string[]) =>
	forms.some((form) => frame.includes(form));

// Attribute a call to Spinetab only when its own emitted code is on the
// stack, so Node's loader internals (process.nextTick, microtasks) and peer
// code are never counted. Both markers end in a separator (kept by
// `pathToFileURL`), so `dist/` never matches a sibling such as `dist-old/`.
const distMarkers = spellings(
	markerArgument || fileURLToPath(new URL("../../dist/", import.meta.url)),
);
Error.stackTraceLimit = 100;
const calls: Record<string, number> = {};
const count = (label: string) => {
	if (!onPath(new Error().stack ?? "", distMarkers)) return;
	calls[label] = (calls[label] ?? 0) + 1;
};
/**
 * Stricter attribution for `fs` and `process.env`: the direct caller (the
 * first frame outside this probe) must be dist code. Node's own loader reads
 * the environment and the compile cache while a dist `require()` is on the
 * stack; those reads are not Spinetab's.
 */
const probePaths = spellings(fileURLToPath(import.meta.url));
const countDirect = (label: string) => {
	const frames = (new Error().stack ?? "").split("\n").slice(1);
	const caller = frames.find((frame) => !onPath(frame, probePaths));
	if (!caller || !onPath(caller, distMarkers)) return;
	calls[label] = (calls[label] ?? 0) + 1;
};
const scope = globalThis as unknown as Record<string, unknown>;

function wrapFunction(
	owner: Record<string, unknown>,
	name: string,
	label: string,
	counter: (label: string) => void = count,
) {
	const descriptor = Object.getOwnPropertyDescriptor(owner, name);
	if (!descriptor || typeof descriptor.value !== "function") return;
	const original = descriptor.value as (...args: unknown[]) => unknown;
	Object.defineProperty(owner, name, {
		...descriptor,
		value: new Proxy(original, {
			apply(target, self, args) {
				counter(label);
				return Reflect.apply(target, self, args);
			},
			construct(target, args, newTarget) {
				counter(label);
				return Reflect.construct(
					target as unknown as new (
						...a: unknown[]
					) => object,
					args,
					newTarget,
				);
			},
		}),
	});
}

/** Count reads and writes of a global without reading it now (Node 24 warns on `localStorage`). */
function watchGlobal(name: string) {
	const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
	if (!descriptor?.configurable) return;
	Object.defineProperty(globalThis, name, {
		configurable: true,
		enumerable: descriptor.enumerable ?? false,
		get() {
			count(name);
			return descriptor.get
				? descriptor.get.call(globalThis)
				: descriptor.value;
		},
		set(value: unknown) {
			count(name);
			if (descriptor.set) descriptor.set.call(globalThis, value);
		},
	});
}

for (const name of [
	"WebSocket",
	"EventSource",
	"fetch",
	"SharedWorker",
	"Worker",
	"BroadcastChannel",
	"setTimeout",
	"setInterval",
	"setImmediate",
	"queueMicrotask",
	"addEventListener",
	"postMessage",
]) {
	wrapFunction(scope, name, name);
}
for (const name of [
	"localStorage",
	"sessionStorage",
	"indexedDB",
	"document",
	"navigator",
]) {
	watchGlobal(name);
}
wrapFunction(
	process as unknown as Record<string, unknown>,
	"nextTick",
	"process.nextTick",
);
for (const method of ["log", "info", "warn", "error", "debug"]) {
	wrapFunction(
		console as unknown as Record<string, unknown>,
		method,
		`console.${method}`,
	);
}

// File writes at import (security build realm rule: no disk writes).
// Patching the CommonJS objects and syncing reaches `import { x } from
// "node:fs"` bindings too.
const FS_WRITES = [
	"appendFile",
	"chmod",
	"chown",
	"copyFile",
	"cp",
	"createWriteStream",
	"link",
	"mkdir",
	"mkdtemp",
	"open",
	"rename",
	"rm",
	"rmdir",
	"symlink",
	"truncate",
	"unlink",
	"utimes",
	"write",
	"writeFile",
	"writev",
];
const fsObject = fs as unknown as Record<string, unknown>;
for (const name of FS_WRITES) {
	wrapFunction(fsObject, name, `fs.${name}`, countDirect);
	wrapFunction(fsObject, `${name}Sync`, `fs.${name}Sync`, countDirect);
}
const promises = fs.promises as unknown as Record<string, unknown>;
for (const name of FS_WRITES) {
	wrapFunction(promises, name, `fs.promises.${name}`, countDirect);
}
syncBuiltinESMExports();

// Environment reads at import (nothing from the
// environment reaches the plugin's output or its import).
process.env = new Proxy(process.env, {
	get(target, key, receiver) {
		if (typeof key === "string") countDirect("process.env");
		return Reflect.get(target, key, receiver);
	},
	has(target, key) {
		countDirect("process.env");
		return Reflect.has(target, key);
	},
	ownKeys(target) {
		countDirect("process.env");
		return Reflect.ownKeys(target);
	},
	getOwnPropertyDescriptor(target, key) {
		countDirect("process.env");
		return Reflect.getOwnPropertyDescriptor(target, key);
	},
});

const namesBefore = new Set(Object.getOwnPropertyNames(globalThis));
const symbolsBefore = new Set(Object.getOwnPropertySymbols(globalThis));
let error: { code?: string; message: string } | null = null;
let exportsCount = 0;
try {
	const loaded = await load(specifier);
	// A default-only CommonJS module is `module.exports = fn` (the loader,
	// `Object.keys` of a function is empty, but it is one export.
	exportsCount =
		typeof loaded === "function" ? 1 : Object.keys(loaded as object).length;
} catch (caught) {
	const failure = caught as NodeJS.ErrnoException;
	error = { code: failure.code, message: failure.message };
}
const added = Object.getOwnPropertyNames(globalThis).filter(
	(name) => !namesBefore.has(name),
);
const addedSymbols = Object.getOwnPropertySymbols(globalThis)
	.filter((symbol) => !symbolsBefore.has(symbol))
	.map(String);
process.stdout.write(
	JSON.stringify({
		mode,
		specifier,
		calls,
		added,
		addedSymbols,
		error,
		exportsCount,
	}),
);
