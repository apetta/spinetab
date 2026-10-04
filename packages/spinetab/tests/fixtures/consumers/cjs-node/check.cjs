"use strict";

/**
 * CommonJS consumer check. Prints one JSON report:
 * - every page entry loads through `require()` without ERR_REQUIRE_ESM or
 * ERR_REQUIRE_ASYNC_MODULE and exposes the same names as its ESM copy;
 * - every build entry loads through `require()` and `import()` with the same
 * names;
 * - runtime entries, `spinetab/worker`, the plugin-owned seams, deep
 * `dist`/`src` paths and
 * `package.json` are not exported;
 * - errors thrown by the CommonJS and ESM copies carry the same `code`, and
 * each copy's `isSpinetabError` recognises the other's errors (no
 * `instanceof` across copies).
 */
const PAGE = [
	".",
	"./wiring",
	"./websocket",
	"./sse",
	"./stream",
	"./polling",
	"./graphql-ws",
	"./graphql-sse",
	"./socket-io",
	"./apollo",
	"./tanstack-query",
	"./swr",
	"./trpc",
	"./ai-sdk",
	"./react",
	"./vue",
	"./svelte",
	"./solid",
];
const ESM_ONLY = [
	"./auto/wiring",
	"./auto/worker",
	"./worker-config",
	"./runtime",
	"./worker",
	"./websocket/runtime",
	"./sse/runtime",
	"./stream/runtime",
	"./polling/runtime",
	"./graphql-ws/runtime",
	"./graphql-sse/runtime",
	"./socket-io/runtime",
	"./trpc/runtime",
	"./ai-sdk/runtime",
];
// Build entries: dual ESM + CJS, loaded by bundler configs
// that Node or Next compile to CommonJS.
const BUILD = [
	"./vite",
	"./webpack",
	"./rspack",
	"./next",
	"./astro",
	"./nuxt",
	"./loader",
];
const DEEP = [
	"spinetab/dist/index.cjs",
	"spinetab/dist/index.js",
	"spinetab/src/index.ts",
	"spinetab/package.json",
];

const specifier = (subpath) =>
	subpath === "." ? "spinetab" : `spinetab/${subpath.slice(2)}`;

function capture(action) {
	try {
		action();
		return null;
	} catch (error) {
		return { name: error.name, code: error.code, message: error.message };
	}
}

async function main() {
	const report = {
		page: [],
		build: [],
		esmOnly: [],
		deep: [],
		codes: {},
		crossRecognition: {},
	};
	for (const subpath of PAGE) {
		const id = specifier(subpath);
		const entry = { id, loaded: false, error: null, cjs: [], esm: [] };
		try {
			entry.cjs = Object.keys(require(id)).sort();
			entry.loaded = true;
		} catch (error) {
			entry.error = { code: error.code, message: error.message };
		}
		try {
			entry.esm = Object.keys(await import(id))
				.filter((name) => name !== "default" && name !== "module.exports")
				.sort();
		} catch (error) {
			entry.esmError = { code: error.code, message: error.message };
		}
		report.page.push(entry);
	}
	// Also records what each copy's exports are, so the test can name the
	// factory per entry (`spinetab`, `withSpinetab`, the loader function).
	const functionsOf = (namespace) =>
		Object.keys(namespace)
			.filter((name) => typeof namespace[name] === "function")
			.sort();
	for (const subpath of BUILD) {
		const id = specifier(subpath);
		const entry = {
			id,
			loaded: false,
			error: null,
			cjs: [],
			esm: [],
			cjsType: null,
			cjsFunctions: [],
			esmDefaultType: null,
			esmFunctions: [],
		};
		try {
			const required = require(id);
			entry.cjs = Object.keys(required).sort();
			entry.cjsType = typeof required;
			entry.cjsFunctions = functionsOf(required);
			entry.loaded = true;
		} catch (error) {
			entry.error = { code: error.code, message: error.message };
		}
		try {
			const imported = await import(id);
			entry.esm = Object.keys(imported)
				.filter((name) => name !== "default" && name !== "module.exports")
				.sort();
			entry.esmDefaultType =
				imported.default === undefined ? null : typeof imported.default;
			entry.esmFunctions = functionsOf(imported).filter(
				(name) => name !== "default",
			);
		} catch (error) {
			entry.esmError = { code: error.code, message: error.message };
		}
		report.build.push(entry);
	}
	for (const subpath of ESM_ONLY) {
		const id = specifier(subpath);
		report.esmOnly.push({ id, require: capture(() => require(id)) });
	}
	for (const id of DEEP) {
		let dynamicImport = null;
		try {
			await import(id);
		} catch (error) {
			dynamicImport = { code: error.code };
		}
		report.deep.push({
			id,
			require: capture(() => require(id)),
			import: dynamicImport,
		});
	}

	const cjs = require("spinetab");
	const esm = await import("spinetab");
	const cjsSse = require("spinetab/sse");
	const esmSse = await import("spinetab/sse");
	const cases = {
		"invalid-endpoint": [
			() => cjs.resolveEndpoint(""),
			() => esm.resolveEndpoint(""),
		],
		"unsupported-option": [
			() => cjsSse.sse({ url: "/x", mode: "unknown" }),
			() => esmSse.sse({ url: "/x", mode: "unknown" }),
		],
		constructed: [
			() => {
				throw new cjs.SpinetabError("timeout", "cjs");
			},
			() => {
				throw new esm.SpinetabError("timeout", "esm");
			},
		],
	};
	for (const [name, [fromCjs, fromEsm]] of Object.entries(cases)) {
		report.codes[name] = { cjs: capture(fromCjs), esm: capture(fromEsm) };
	}
	let cjsError;
	let esmError;
	try {
		cjs.resolveEndpoint("");
	} catch (error) {
		cjsError = error;
	}
	try {
		esm.resolveEndpoint("");
	} catch (error) {
		esmError = error;
	}
	report.crossRecognition = {
		esmRecognisesCjs: esm.isSpinetabError(cjsError, "invalid-endpoint"),
		cjsRecognisesEsm: cjs.isSpinetabError(esmError, "invalid-endpoint"),
		sameClass: cjs.SpinetabError === esm.SpinetabError,
	};
	process.stdout.write(JSON.stringify(report));
}

main().catch((error) => {
	process.stderr.write(String(error?.stack ?? error));
	process.exitCode = 1;
});
