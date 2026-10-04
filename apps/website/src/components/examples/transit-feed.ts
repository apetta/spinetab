import {
	ApolloClient,
	gql,
	HttpLink,
	InMemoryCache,
	type TypedDocumentNode,
} from "@apollo/client";
import { createSpinetab } from "spinetab";
import { spinetabSplit } from "spinetab/apollo";
import { graphqlWs } from "spinetab/graphql-ws";
import type { StartFeed } from "./feed";
import { workerName } from "./protocol";
import type { TransitVehicle } from "./TransitView";

const fields = `vehicleId lastUpdated location { latitude longitude } line { publicCode lineName } bearing destinationName delay monitoredCall { vehicleAtStop }`;
const filter = `mode:BUS, boundingBox:{minLat:59.8,maxLat:60.15,minLon:10.45,maxLon:11.05}, maxDataAge:"PT2M"`;
export const FLEET: TypedDocumentNode<FleetData> = gql(
	`query Fleet { vehicles(${filter}) { ${fields} } }`,
);
const UPDATES = gql(
	`subscription FleetUpdates { vehicles(${filter}) { ${fields} } }`,
);
interface FleetData {
	vehicles: TransitVehicle[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareReportTimes(left: string, right: string): number {
	const milliseconds = Date.parse(left) - Date.parse(right);
	if (milliseconds !== 0) return milliseconds;
	const remainder = (value: string) => {
		const fraction = value.match(/T\d{2}:\d{2}:\d{2}\.(\d+)/)?.[1] ?? "";
		return Number(fraction.slice(3, 9).padEnd(6, "0"));
	};
	return remainder(left) - remainder(right);
}

function validateFleet(data: unknown): asserts data is FleetData {
	if (!isRecord(data) || !Array.isArray(data.vehicles)) {
		throw new Error("The vehicle feed returned an invalid update.");
	}
	for (const vehicle of data.vehicles) {
		if (
			!isRecord(vehicle) ||
			typeof vehicle.vehicleId !== "string" ||
			vehicle.vehicleId.trim().length === 0 ||
			typeof vehicle.lastUpdated !== "string" ||
			!Number.isFinite(Date.parse(vehicle.lastUpdated))
		) {
			throw new Error("The vehicle feed returned an invalid vehicle.");
		}
		const location = vehicle.location;
		if (
			location !== null &&
			(!isRecord(location) ||
				typeof location.latitude !== "number" ||
				!Number.isFinite(location.latitude) ||
				Math.abs(location.latitude) > 90 ||
				typeof location.longitude !== "number" ||
				!Number.isFinite(location.longitude) ||
				Math.abs(location.longitude) > 180)
		) {
			throw new Error("The vehicle feed returned an invalid position.");
		}
		const line = vehicle.line;
		if (
			line !== null &&
			(!isRecord(line) ||
				(line.publicCode !== undefined &&
					line.publicCode !== null &&
					typeof line.publicCode !== "string") ||
				(line.lineName !== undefined &&
					line.lineName !== null &&
					typeof line.lineName !== "string"))
		) {
			throw new Error("The vehicle feed returned an invalid line.");
		}
		if (
			vehicle.destinationName != null &&
			typeof vehicle.destinationName !== "string"
		)
			throw new Error("The vehicle feed returned an invalid destination.");
		const call = vehicle.monitoredCall;
		if (
			call != null &&
			(!isRecord(call) ||
				(call.vehicleAtStop != null && typeof call.vehicleAtStop !== "boolean"))
		)
			throw new Error("The vehicle feed returned an invalid stop status.");
		for (const field of ["bearing", "speed", "delay"] as const) {
			const value = vehicle[field];
			if (
				value !== undefined &&
				value !== null &&
				(typeof value !== "number" || !Number.isFinite(value))
			) {
				throw new Error("The vehicle feed returned an invalid vehicle.");
			}
		}
	}
}

export const startTransitFeed: StartFeed<readonly TransitVehicle[]> = (
	experiment,
	callbacks,
) => {
	let stopped = false;
	let connected = false;
	let continuous = false;
	let snapshotStarted = false;
	let snapshotReady = false;
	const controller = new AbortController();
	const publishConnection = () =>
		callbacks.connection(connected && continuous && snapshotReady);
	const client = createSpinetab({
		anonymous: true,
		onCallbackError: (error) => {
			if (!stopped)
				callbacks.error(
					error instanceof Error
						? error.message
						: "Could not recover the vehicle feed.",
				);
		},
		sharing: experiment.mode === "shared" ? "prefer" : "off",
		worker: () =>
			new SharedWorker(new URL("./transit.worker.ts", import.meta.url), {
				type: "module",
				name: workerName(experiment),
			}),
		local: async () => {
			const runtime = await import("./transit.worker");
			return {
				default: () =>
					runtime.createTransitRuntime(experiment.group, experiment.epoch),
			};
		},
	});
	const offMode = client.status.subscribe((status) =>
		callbacks.mode(status.mode, status.runtimeId),
	);
	const endpoint = graphqlWs(experiment.transitEndpoint, {
		anonymous: true,
		connectionParams: {
			headers: { "Et-Client-Name": "spinetab-docs-examples" },
		},
		lazyCloseTimeoutMs: 0,
	});
	const cache = new InMemoryCache();
	const fleet = new Map<string, TransitVehicle>();
	const merge = (data: unknown, source: "snapshot" | "update" = "update") => {
		if (stopped) return;
		validateFleet(data);
		for (const vehicle of data.vehicles) {
			const previous = fleet.get(vehicle.vehicleId);
			const order = previous
				? compareReportTimes(vehicle.lastUpdated, previous.lastUpdated)
				: 1;
			if (order > 0 || (source === "update" && order === 0)) {
				fleet.set(vehicle.vehicleId, vehicle);
			}
		}
		const oldest = Date.now() - 120_000;
		for (const [id, vehicle] of fleet)
			if (Date.parse(vehicle.lastUpdated) < oldest) fleet.delete(id);
		const vehicles = [...fleet.values()]
			.sort((left, right) => {
				const age = compareReportTimes(right.lastUpdated, left.lastUpdated);
				if (age !== 0) return age;
				return left.vehicleId < right.vehicleId
					? -1
					: left.vehicleId > right.vehicleId
						? 1
						: 0;
			})
			.slice(0, 80);
		fleet.clear();
		for (const vehicle of vehicles) fleet.set(vehicle.vehicleId, vehicle);
		cache.writeQuery({ query: FLEET, data: { vehicles } });
	};
	const offCache = cache.watch<FleetData>({
		query: FLEET,
		optimistic: false,
		callback: (diff) => {
			if (diff.result?.vehicles)
				callbacks.data(diff.result.vehicles as TransitVehicle[]);
		},
	});
	const http = new HttpLink({
		uri: experiment.snapshotEndpoint,
		headers: { "ET-Client-Name": "spinetab-docs-examples" },
		credentials: "omit",
	});
	let apollo: ApolloClient;
	const refresh = async (signal?: AbortSignal) => {
		const result = await apollo.query({
			query: FLEET,
			fetchPolicy: "no-cache",
			errorPolicy: "none",
			context: { queryDeduplication: false, fetchOptions: { signal } },
		});
		if (!signal?.aborted && !stopped) {
			merge(result.data, "snapshot");
			snapshotReady = true;
			publishConnection();
		}
	};
	apollo = new ApolloClient({
		cache,
		link: spinetabSplit(client, endpoint, http, {
			reconcile: ({ signal }) => {
				snapshotStarted = true;
				snapshotReady = false;
				publishConnection();
				controller.abort();
				return refresh(signal);
			},
			onStatus: (status) => {
				if (stopped) return;
				connected = status.connection.state === "connected";
				continuous = status.continuity.state === "continuous";
				publishConnection();
				if (connected && !snapshotStarted) {
					queueMicrotask(() => {
						if (stopped || !connected || snapshotStarted) return;
						snapshotStarted = true;
						void refresh(controller.signal).catch((error) => {
							if (!stopped && !controller.signal.aborted)
								callbacks.error(
									error instanceof Error
										? error.message
										: "Could not load the fleet.",
								);
						});
					});
				}
				if (status.connection.state === "failed")
					callbacks.error(
						"The vehicle feed could not connect. Try again shortly.",
					);
			},
		}),
	});
	const subscription = apollo
		.subscribe<FleetData>({
			query: UPDATES,
			fetchPolicy: "no-cache",
			errorPolicy: "none",
		})
		.subscribe({
			next(result) {
				if (stopped) return;
				try {
					merge(result.data);
					callbacks.received();
				} catch (error) {
					callbacks.error(
						error instanceof Error
							? error.message
							: "The vehicle feed returned an invalid update.",
					);
				}
			},
			error: (error) => {
				if (!stopped) callbacks.error(error.message);
			},
		});
	return {
		stop() {
			if (stopped) return;
			stopped = true;
			controller.abort();
			subscription.unsubscribe();
			offCache();
			offMode();
			apollo.stop();
			client.dispose();
		},
	};
};
