import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type {
	SharedWorkerLike,
	SpinetabClient,
	SpinetabOptions,
	SpinetabWiring,
} from "../../../src/core/types.ts";

// Supplying either explicit runtime factory disables plugin wiring entirely.

const seam = vi.hoisted(() => ({ wiring: undefined as unknown }));
vi.mock("spinetab/wiring", () => ({
	get wiring() {
		return seam.wiring;
	},
}));

const core = vi.hoisted(() => ({ calls: [] as unknown[] }));
vi.mock("../../../src/core/client.ts", async (importOriginal) => {
	const original =
		await importOriginal<typeof import("../../../src/core/client.ts")>();
	return {
		...original,
		createSpinetab: (options?: SpinetabOptions) => {
			core.calls.push(options);
			return original.createSpinetab(options);
		},
	};
});

const { createSpinetab } = await import("../../../src/index.ts");

const plugin: SpinetabWiring = {
	worker: () => ({}) as SharedWorkerLike,
	local: async () => ({ default: () => ({}) as never }),
};
const own = {
	worker: () => ({}) as SharedWorkerLike,
	local: async () => ({ default: () => ({}) as never }),
};

const clients: SpinetabClient[] = [];
function create(...args: [SpinetabOptions?]): unknown {
	core.calls.length = 0;
	clients.push(createSpinetab(...args));
	expect(core.calls).toHaveLength(1);
	return core.calls[0];
}

afterEach(() => {
	seam.wiring = undefined;
	for (const client of clients.splice(0)) client.dispose();
});

describe("root wiring without a plugin", () => {
	it("passes the options through unchanged", () => {
		const options = { scope: "u1" };
		expect(create(options)).toBe(options);
		expect(create()).toEqual({});
	});
});

describe("root wiring with a plugin", () => {
	it("supplies both factories when neither is passed, keeping every other option", () => {
		seam.wiring = plugin;
		const onCallbackError = () => {};
		expect(
			create({ sharing: "require", scope: "u1", onCallbackError }),
		).toEqual({
			sharing: "require",
			scope: "u1",
			onCallbackError,
			worker: plugin.worker,
			local: plugin.local,
		});
		expect(create()).toEqual({ worker: plugin.worker, local: plugin.local });
	});

	it("treats keys explicitly set to undefined as not passed", () => {
		seam.wiring = plugin;
		expect(create({ worker: undefined, local: undefined })).toEqual({
			worker: plugin.worker,
			local: plugin.local,
		});
	});

	it.each([
		["worker only", { worker: own.worker }],
		["local only", { local: own.local }],
		["both", { worker: own.worker, local: own.local }],
		["local with worker undefined", { worker: undefined, local: own.local }],
	])("ignores the wiring entirely when the page passes %s", (_, options) => {
		seam.wiring = plugin;
		expect(create(options)).toBe(options);
	});

	it("forwards only worker and local from the wiring (security)", () => {
		seam.wiring = {
			...plugin,
			sharing: "off",
			credentialOrigins: ["https://evil.example"],
		};
		const passed = create({ scope: "u1" });
		expect(passed).toEqual({
			scope: "u1",
			worker: plugin.worker,
			local: plugin.local,
		});
	});

	it("leaves a non-object argument for the core to reject", () => {
		seam.wiring = plugin;
		core.calls.length = 0;
		expect(() => createSpinetab(null as never)).toThrow(
			expect.objectContaining({ code: "unsupported-option" }),
		);
		expect(core.calls).toEqual([null]);
	});
});

describe("root createSpinetab types", () => {
	it("type-checks with no argument and returns a client", () => {
		expectTypeOf(createSpinetab).toBeCallableWith();
		expectTypeOf(createSpinetab).parameters.toEqualTypeOf<
			[options?: SpinetabOptions]
		>();
		expectTypeOf(createSpinetab).returns.toEqualTypeOf<SpinetabClient>();
	});

	it("SpinetabOptions gains no audience field (security)", () => {
		expectTypeOf<keyof SpinetabOptions>().toEqualTypeOf<
			| "worker"
			| "local"
			| "sharing"
			| "scope"
			| "credentialRevision"
			| "anonymous"
			| "credentials"
			| "limits"
			| "handshakeTimeoutMs"
			| "probeTimeoutMs"
			| "heartbeatMs"
			| "leaseMs"
			| "baseUrl"
			| "diagnostics"
			| "onCallbackError"
		>();
		const check = () =>
			createSpinetab({
				// @ts-expect-error: credential audiences are worker-side only.
				credentialOrigins: ["https://api.example.com"],
			});
		expect(typeof check).toBe("function");
	});

	it("SpinetabWiring holds exactly the two required factories", () => {
		expectTypeOf<keyof SpinetabWiring>().toEqualTypeOf<"worker" | "local">();
		expectTypeOf<SpinetabWiring["worker"]>().toEqualTypeOf<
			NonNullable<SpinetabOptions["worker"]>
		>();
		expectTypeOf<SpinetabWiring["local"]>().toEqualTypeOf<
			NonNullable<SpinetabOptions["local"]>
		>();
	});
});
