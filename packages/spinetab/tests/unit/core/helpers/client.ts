import { vi } from "vitest";
import { createClientWithEnv } from "../../../../src/core/client.ts";
import { createRuntime, type Runtime } from "../../../../src/core/runtime.ts";
import type {
	ClientStatus,
	SpinetabClient,
	SpinetabOptions,
	SubscriptionRequest,
	SubscriptionStatus,
} from "../../../../src/core/types.ts";
import { ManualClock } from "./clock.ts";
import { createTestEnv } from "./env.ts";
import { createTestAdapter } from "./test-adapter.ts";
import { FakeWorkerHost } from "./worker.ts";

export interface Harness {
	clock: ManualClock;
	host: FakeWorkerHost;
	kit: ReturnType<typeof createTestEnv>;
	client: SpinetabClient;
	history: ClientStatus[];
	local: {
		factory: ReturnType<typeof vi.fn>;
		runtime?: Runtime;
		test: ReturnType<typeof createTestAdapter>;
	};
	dispose(): void;
}

const created: Harness[] = [];

export function makeClient(
	options: Partial<SpinetabOptions> = {},
	settings: {
		env?: Parameters<typeof createTestEnv>[1];
		noLocal?: boolean;
		localFails?: boolean;
		hostLimits?: ConstructorParameters<typeof FakeWorkerHost>[1];
		host?: FakeWorkerHost;
		clock?: ManualClock;
	} = {},
): Harness {
	const clock = settings.clock ?? new ManualClock();
	const host = settings.host ?? new FakeWorkerHost(clock, settings.hostLimits);
	const kit = createTestEnv(clock, settings.env);
	const localTest = createTestAdapter();
	const local: Harness["local"] = { factory: vi.fn(), test: localTest };
	local.factory.mockImplementation(async () => {
		if (settings.localFails)
			throw new TypeError("Failed to fetch dynamically imported module");
		return {
			default: () => {
				local.runtime = createRuntime({ adapters: [localTest.adapter], clock });
				return local.runtime;
			},
		};
	});
	const client = createClientWithEnv(
		{
			worker: host.factory,
			...(settings.noLocal
				? {}
				: { local: local.factory as unknown as SpinetabOptions["local"] }),
			...options,
		},
		kit.env,
	);
	const history: ClientStatus[] = [client.status.get()];
	client.status.subscribe((status) => history.push(status));
	const harness: Harness = {
		clock,
		host,
		kit,
		client,
		history,
		local,
		dispose() {
			client.dispose();
			host.dispose();
			local.runtime?.dispose();
		},
	};
	created.push(harness);
	return harness;
}

export function disposeAll(): void {
	for (const harness of created.splice(0)) harness.dispose();
}

export const feed = (
	subscription: Record<string, unknown> = {},
	extra: Partial<SubscriptionRequest> = {},
): SubscriptionRequest<unknown> => ({
	adapter: "test",
	connection: { url: "https://api.test/feed" },
	subscription,
	...extra,
});

export function observe() {
	const log = {
		events: [] as unknown[],
		metas: [] as Array<{ seq: number; eventId?: string }>,
		errors: [] as Array<{ code: string; message: string }>,
		completed: 0,
		statuses: [] as SubscriptionStatus[],
	};
	const observer = {
		next: (event: unknown, meta: { seq: number; eventId?: string }) => {
			log.events.push(event);
			log.metas.push(meta);
		},
		error: (error: { code: string; message: string }) => log.errors.push(error),
		complete: () => {
			log.completed += 1;
		},
		status: (status: SubscriptionStatus) => log.statuses.push(status),
	};
	return { log, observer };
}

export const modes = (history: ClientStatus[]) =>
	history
		.map((status) => status.mode)
		.filter((mode, index, list) => index === 0 || list[index - 1] !== mode);
