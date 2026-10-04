import { QueryClient } from "@tanstack/query-core";
import { createSpinetab } from "spinetab";
import { pollEvery, polling } from "spinetab/polling";
import { bindQuery } from "spinetab/tanstack-query";
import type { StartFeed } from "./feed";
import type { OrbitSample } from "./OrbitView";
import { workerName } from "./protocol";

function isSample(value: unknown): value is OrbitSample {
	if (!value || typeof value !== "object") return false;
	const sample = value as OrbitSample;
	return (
		[
			sample.latitude,
			sample.longitude,
			sample.altitude,
			sample.velocity,
			sample.timestamp,
		].every(Number.isFinite) &&
		Math.abs(sample.latitude) <= 90 &&
		Math.abs(sample.longitude) <= 180 &&
		sample.timestamp > 0 &&
		Number.isFinite(new Date(sample.timestamp * 1000).getTime())
	);
}

export const startOrbitFeed: StartFeed<OrbitSample> = (
	experiment,
	callbacks,
) => {
	let stopped = false;
	const client = createSpinetab({
		anonymous: true,
		onCallbackError: (error) =>
			callbacks.error(
				error instanceof Error
					? error.message
					: "The position feed returned an invalid update.",
			),
		sharing: experiment.mode === "shared" ? "prefer" : "off",
		worker: () =>
			new SharedWorker(new URL("./orbit.worker.ts", import.meta.url), {
				type: "module",
				name: workerName(experiment),
			}),
		local: async () => {
			const runtime = await import("./orbit.worker");
			return {
				default: () =>
					runtime.createOrbitRuntime(experiment.group, experiment.epoch),
			};
		},
	});
	const cache = new QueryClient();
	const queryKey = ["iss"];
	const offMode = client.status.subscribe((status) =>
		callbacks.mode(status.mode, status.runtimeId),
	);
	const offCache = cache.getQueryCache().subscribe(() => {
		const value = cache.getQueryData<OrbitSample>(queryKey);
		if (value) callbacks.data(value);
	});
	let connectionError: string | undefined;
	const binding = bindQuery(
		client,
		polling<unknown>(experiment.orbitEndpoint, {
			credentials: "omit",
			timeoutMs: 12_000,
		}),
		{
			queryClient: cache,
			queryKey,
			map(value) {
				if (!isSample(value))
					throw new Error("The position feed returned an invalid sample.");
				return value;
			},
			reconcile: "latest",
			...pollEvery(experiment.intervalMs, {
				whileHidden: true,
				onJoin: "await",
			}),
			onEvent: () => callbacks.received(),
			onStatus: (status) => {
				const connection = status.connection;
				callbacks.connection(connection.state === "connected");
				if (connection.state === "reconnecting") {
					connectionError =
						connection.code === 429
							? "The position provider is limiting requests. Waiting before trying again."
							: "The position feed is temporarily unavailable. Retrying automatically.";
				} else if (connection.state === "retry-exhausted") {
					connectionError =
						"Automatic retries have stopped. Reload this page to try again.";
				} else if (connection.state === "auth-blocked") {
					connectionError =
						"The position provider refused this request. Reload this page to try again.";
				} else if (connection.state === "failed") {
					connectionError =
						"The position feed could not be read. Reload this page to try again.";
				} else {
					connectionError = undefined;
				}
				if (connectionError) callbacks.error(connectionError);
			},
			onError: (error) => callbacks.error(connectionError ?? error.message),
		},
	);
	return {
		stop() {
			if (stopped) return;
			stopped = true;
			binding.unsubscribe();
			offMode();
			offCache();
			client.dispose();
			cache.clear();
		},
	};
};
