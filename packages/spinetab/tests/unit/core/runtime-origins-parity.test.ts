import { afterEach, describe, expect, it } from "vitest";
import { isSpinetabError } from "../../../src/core/errors.ts";
import { checkCredentialOrigin } from "../../../src/core/origins.ts";
import {
	createRuntime,
	type Runtime,
	type RuntimeOptions,
	setWorkerOriginForTests,
} from "../../../src/core/runtime.ts";
import { ManualClock, settle } from "./helpers/clock.ts";
import { RawPage } from "./helpers/page.ts";
import { createTestAdapter } from "./helpers/test-adapter.ts";

// Check runtime validation against an independent reference implementation.
// Both configuration and request validation must enforce the same origins.

/**
 * Reference origin validator. Keep this implementation independent of the
 * shared helper so the comparison catches changes to validation behaviour.
 * `forEach` deliberately skips sparse array holes, as the runtime does.
 */
function legacyResolve(
	list: unknown,
): { origins: string[] } | { message: string; path: string } {
	const isLoopbackHost = (host: string) =>
		host === "localhost" ||
		host.endsWith(".localhost") ||
		host === "[::1]" ||
		/^127\.\d+\.\d+\.\d+$/.test(host);
	class Rejected {
		constructor(
			readonly message: string,
			readonly path: string,
		) {}
	}
	function resolveCredentialOrigins(list: unknown): Set<string> {
		const origins = new Set<string>();
		if (list === undefined) return origins;
		if (!Array.isArray(list)) {
			throw new Rejected(
				"runtime.credentialOrigins must be an array of origins.",
				"runtime.credentialOrigins",
			);
		}
		list.forEach((entry: unknown, index) => {
			const path = `runtime.credentialOrigins[${index}]`;
			let url: URL | undefined;
			try {
				url = typeof entry === "string" ? new URL(entry) : undefined;
			} catch {
				url = undefined;
			}
			if (
				!url ||
				/[?#]/.test(entry as string) ||
				!(
					url.protocol === "https:" ||
					(url.protocol === "http:" && isLoopbackHost(url.hostname))
				) ||
				url.username ||
				url.password ||
				url.pathname !== "/"
			) {
				throw new Rejected(
					`${path} must be an exact https: origin such as "https://api.example.com" (http: only for loopback), without a path, query, fragment or userinfo.`,
					path,
				);
			}
			origins.add(url.origin);
		});
		return origins;
	}
	try {
		return { origins: [...resolveCredentialOrigins(list)] };
	} catch (error) {
		if (!(error instanceof Rejected)) throw error;
		return { message: error.message, path: error.path };
	}
}

/** A sparse array without a sparse literal: holes everywhere but `entries`. */
function sparse(length: number, entries: Record<number, unknown>): unknown[] {
	const list = new Array<unknown>(length);
	for (const [index, entry] of Object.entries(entries)) {
		list[Number(index)] = entry;
	}
	return list;
}

const ENTRIES: unknown[] = [
	"https://api.test",
	"https://api.test/",
	"HTTPS://API.Test:443",
	"https://api.test:8443",
	"https://bücher.example",
	" https://api.test ",
	"https:api.test",
	"http://localhost",
	"http://localhost:3000",
	"http://app.localhost:5173",
	"http://127.0.0.1:8080",
	"http://[::1]:4000",
	"https://localhost",
	"http://api.test",
	"http://localhost.evil.test",
	"http://127.0.0.1.evil.test",
	"http://0.0.0.0",
	"wss://api.test",
	"ws://localhost",
	"ftp://api.test",
	"file:///etc/passwd",
	"data:text/plain,x",
	"javascript:alert(1)",
	"blob:https://api.test/uuid",
	"https://user@api.test",
	"https://:secret@api.test",
	"http://user@localhost:3000",
	"https://api.test/path",
	"https://api.test//",
	"https://api.test?x=1",
	"https://api.test?",
	"https://api.test#",
	"https://api.test/#f",
	"https://user@api.test/p?q#f",
	"",
	" ",
	"api.test",
	"//api.test",
	"https://",
	"https://api test",
	"http://[::1",
	42,
	null,
	undefined,
	{},
	["https://api.test"],
	new URL("https://api.test"),
];

const LISTS: unknown[] = [
	undefined,
	null,
	"https://api.test",
	{ 0: "https://api.test", length: 1 },
	42,
	[],
	...ENTRIES.map((entry) => [entry]),
	["https://a.test", "https://b.test", "https://a.test/"],
	["https://a.test", "api.test", "https://b.test/path"],
	["https://a.test", "http://localhost:3000", "https://user@c.test"],
	["http://127.0.0.1", "wss://x.test"],
	// Holes are skipped, so the index reported is the first defined bad entry.
	sparse(2, { 1: "https://a.test" }),
	sparse(3, { 0: "https://a.test", 2: "https://b.test" }),
	sparse(3, { 2: "api.test" }),
	sparse(4, { 1: "https://a.test", 3: "https://b.test/path" }),
	sparse(2, {}),
];

const runtimes: Runtime[] = [];
afterEach(() => {
	for (const runtime of runtimes.splice(0)) runtime.dispose();
	setWorkerOriginForTests(undefined);
});

function build(credentialOrigins: unknown) {
	try {
		runtimes.push(
			createRuntime({
				adapters: [],
				credentialOrigins: credentialOrigins as string[],
			}),
		);
		return { ok: true as const };
	} catch (error) {
		return { ok: false as const, error };
	}
}

describe("parity: createRuntime validates credentialOrigins as before", () => {
	it("checkCredentialOrigin agrees with the legacy rule on every entry", () => {
		for (const entry of ENTRIES) {
			const legacy = legacyResolve([entry]);
			const check = checkCredentialOrigin(entry);
			const label = JSON.stringify(entry) ?? String(entry);
			if ("origins" in legacy) {
				expect(check, label).toEqual({ ok: true, origin: legacy.origins[0] });
			} else {
				expect(check.ok, label).toBe(false);
			}
		}
	});

	it("rejects and accepts the same lists with the same message and detail", async () => {
		// Every origin any accepted list admits, plus one no list names: an
		// accepted runtime must admit exactly the oracle's origins among them.
		const universe = [
			...new Set(
				LISTS.flatMap((list) => {
					const legacy = legacyResolve(list);
					return "origins" in legacy ? legacy.origins : [];
				}),
			),
			"https://control.test",
		].sort();
		for (const [index, list] of LISTS.entries()) {
			const legacy = legacyResolve(list);
			const label = `LISTS[${index}] ${JSON.stringify(list) ?? String(list)}`;
			if ("origins" in legacy) {
				const admitted = await admittedAmong(list, universe);
				expect(admitted, label).toEqual([...legacy.origins].sort());
				continue;
			}
			const actual = build(list);
			expect(actual.ok, label).toBe(false);
			if (actual.ok) continue;
			expect(isSpinetabError(actual.error, "unsupported-option"), label).toBe(
				true,
			);
			expect((actual.error as Error).message, label).toBe(legacy.message);
			expect((actual.error as { detail?: unknown }).detail, label).toEqual({
				path: legacy.path,
			});
		}
	});
});

/**
 * The origins of `universe` a runtime built with `credentialOrigins` admits
 * for `authHeaders: true`. The worker is not on loopback, so a loopback
 * origin is admitted only when it is listed.
 */
async function admittedAmong(
	credentialOrigins: unknown,
	universe: readonly string[],
): Promise<string[]> {
	setWorkerOriginForTests("https://app.test");
	const { clock, tab } = setup({
		credentialOrigins: credentialOrigins as string[],
	});
	const raw = await tab();
	for (const [index, origin] of universe.entries()) {
		raw.subscribe(String(index), {
			connection: { url: `${origin}/feed`, authHeaders: true },
		});
	}
	await settle(clock);
	const refused = new Set(
		raw
			.ofType("error")
			.filter((error) => error.code === "unsupported-option")
			.map((error) => error.c),
	);
	expect(raw.ofType("error")).toHaveLength(refused.size);
	return universe.filter((_, index) => !refused.has(String(index)));
}

function setup(options: Partial<RuntimeOptions> = {}) {
	const clock = new ManualClock();
	const test = createTestAdapter();
	const runtime = createRuntime({
		adapters: [test.adapter],
		clock,
		...options,
	});
	runtimes.push(runtime);
	const tab = async () => {
		const raw = new RawPage(runtime);
		raw.hello({ scope: "s", credentials: true, revision: 1 });
		await settle(clock);
		return raw;
	};
	return { clock, test, tab };
}

describe("in the running audience", () => {
	it("admits the normalised origin of an entry written in another form", async () => {
		setWorkerOriginForTests("https://app.test");
		const { clock, test, tab } = setup({
			credentialOrigins: ["HTTPS://API.test:443/"],
		});
		const raw = await tab();
		raw.subscribe("listed", {
			connection: { url: "wss://api.test/socket", authHeaders: true },
		});
		await settle(clock);
		expect(raw.ofType("error")).toHaveLength(0);
		expect(test.connections).toHaveLength(1);
	});

	it("an audience in hello is ignored and never widens", async () => {
		// The bridge validator ignores keys it does not know, so a page can put
		// one on hello; only the worker's own options may name an audience.
		setWorkerOriginForTests("https://app.test");
		const clock = new ManualClock();
		const test = createTestAdapter();
		const runtime = createRuntime({ adapters: [test.adapter], clock });
		runtimes.push(runtime);
		const raw = new RawPage(runtime);
		raw.hello({
			scope: "s",
			credentials: true,
			revision: 1,
			credentialOrigins: ["https://evil.test"],
			audience: ["https://evil.test"],
		});
		await settle(clock);
		expect(raw.ofType("welcome")).toHaveLength(1);
		raw.subscribe("r", {
			connection: { url: "https://evil.test/feed", authHeaders: true },
		});
		await settle(clock);
		expect(raw.ofType("error")).toMatchObject([
			{ c: "r", code: "unsupported-option" },
		]);
		expect(test.connections).toHaveLength(0);
	});

	it("the authHeaders sentence names the plugin options and the worker file", async () => {
		setWorkerOriginForTests("https://app.test");
		const { clock, tab } = setup();
		const raw = await tab();
		raw.subscribe("r", {
			connection: { url: "https://other.test/feed", authHeaders: true },
		});
		await settle(clock);
		expect(raw.ofType("error")).toMatchObject([
			{
				code: "unsupported-option",
				message:
					"request.connection.authHeaders: true sends provider credentials, but the URL is neither the worker's origin nor listed in credentialOrigins, or is not https:; add the origin to credentialOrigins in the Spinetab plugin options or your worker file, or remove authHeaders.",
			},
		]);
	});

	it("the credentials-audience sentence names the plugin options and the worker file", async () => {
		setWorkerOriginForTests("https://app.test");
		const { clock, test, tab } = setup();
		const raw = await tab();
		raw.subscribe("r", { connection: { url: "https://other.test/feed" } });
		await settle(clock);
		const ctx = test.connections[0]?.ctx;
		if (!ctx) throw new Error("no connection");
		const error = await ctx.credentials("connect").then(
			() => undefined,
			(caught: unknown) => caught,
		);
		expect(isSpinetabError(error, "credentials-audience")).toBe(true);
		expect((error as Error).message).toBe(
			"Provider credentials go only to the worker's own origin or an origin in credentialOrigins; add the origin to credentialOrigins in the Spinetab plugin options or your worker file, or declare anonymous: true.",
		);
		expect(raw.ofType("credentialsRequest")).toHaveLength(0);
	});
});
