/**
 * Import-time spies: constructors and calls of network, worker,
 * timer, listener, storage, messaging and logging APIs, plus a diff of the
 * global object's own names and symbols. Evaluated before any Spinetab entry.
 */
export const calls = {};
const count = (label) => {
	calls[label] = (calls[label] ?? 0) + 1;
};

function wrap(owner, name, label) {
	const original = owner?.[name];
	if (typeof original !== "function") return;
	owner[name] = new Proxy(original, {
		apply(target, self, args) {
			count(label);
			return Reflect.apply(target, self, args);
		},
		construct(target, args, newTarget) {
			count(label);
			return Reflect.construct(target, args, newTarget);
		},
	});
}

function watchAccess(owner, name, label) {
	if (!owner || !(name in owner)) return;
	const value = owner[name];
	Object.defineProperty(owner, name, {
		configurable: true,
		get() {
			count(label);
			return value;
		},
		set() {
			count(label);
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
	"queueMicrotask",
	"requestAnimationFrame",
	"importScripts",
	"postMessage",
]) {
	wrap(globalThis, name, name);
}
wrap(globalThis, "addEventListener", "globalThis.addEventListener");
if (typeof document !== "undefined") {
	wrap(document, "addEventListener", "document.addEventListener");
	const cookie = Object.getOwnPropertyDescriptor(Document.prototype, "cookie");
	Object.defineProperty(document, "cookie", {
		configurable: true,
		get() {
			count("document.cookie");
			return cookie?.get?.call(document) ?? "";
		},
		set(value) {
			count("document.cookie");
			cookie?.set?.call(document, value);
		},
	});
}
for (const name of [
	"localStorage",
	"sessionStorage",
	"indexedDB",
	"cookieStore",
]) {
	watchAccess(globalThis, name, name);
}
for (const method of ["log", "info", "warn", "error", "debug"]) {
	wrap(console, method, `console.${method}`);
}

const namesBefore = new Set(Object.getOwnPropertyNames(globalThis));
const symbolsBefore = new Set(Object.getOwnPropertySymbols(globalThis));

/** Calls and global changes since the spies were installed, then reset. */
export function snapshot() {
	const added = Object.getOwnPropertyNames(globalThis).filter(
		(name) => !namesBefore.has(name),
	);
	const addedSymbols = Object.getOwnPropertySymbols(globalThis)
		.filter((symbol) => !symbolsBefore.has(symbol))
		.map((symbol) => String(symbol));
	const result = { calls: { ...calls }, added, addedSymbols };
	for (const key of Object.keys(calls)) delete calls[key];
	for (const name of added) namesBefore.add(name);
	for (const symbol of Object.getOwnPropertySymbols(globalThis)) {
		symbolsBefore.add(symbol);
	}
	return result;
}
