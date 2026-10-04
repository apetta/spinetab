import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { WebSocket, WebSocketServer } from "ws";

export interface FixtureVehicle {
	vehicleId: string;
	lastUpdated: string;
	location: { latitude: number; longitude: number };
	line: { publicCode: string };
	bearing: number;
	speed: number;
	delay: number | null;
	destinationName: string | null;
	monitoredCall: { vehicleAtStop: boolean | null } | null;
}

export interface FixtureOrbitSample {
	latitude: number;
	longitude: number;
	altitude: number;
	velocity: number;
	timestamp: number;
}

type Operation = { socket: WebSocket; id: string; query: boolean };

export async function createExampleServer() {
	const counters = {
		orbitRequests: 0,
		orbitTimes: [] as number[],
		orbitSamples: [] as FixtureOrbitSample[],
		snapshots: 0,
		snapshotActiveSubscriptions: [] as number[],
		connections: 0,
		activeConnections: 0,
		activeSubscriptions: 0,
		completes: 0,
		inits: [] as unknown[],
		queries: [] as string[],
	};
	const operations = new Set<Operation>();
	let orbitFailure = 0;
	let orbitSample: FixtureOrbitSample | null = null;
	let reverseSnapshots = false;
	let ackDelay = 0;
	let stale = false;
	let paused = false;
	let sequence = 0;
	let fleet = initialFleet();
	const json = (response: ServerResponse, status: number, body: unknown) => {
		response.writeHead(status, {
			"Content-Type": "application/json",
			"Cache-Control": "no-store",
			"Access-Control-Allow-Origin": "*",
			"Access-Control-Allow-Headers": "content-type, et-client-name",
			"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
			...(status === 429 ? { "Retry-After": "1" } : {}),
		});
		response.end(JSON.stringify(body));
	};
	const server = createServer((request, response) => {
		const path = new URL(request.url ?? "/", "http://fixture.local").pathname;
		if (request.method === "OPTIONS") return json(response, 204, null);
		if (path === "/iss") {
			counters.orbitRequests += 1;
			counters.orbitTimes.push(Date.now());
			if (orbitFailure) {
				return json(response, orbitFailure, { error: "Fixture unavailable" });
			}
			const sample = orbitSample ?? {
				latitude: 30 + counters.orbitRequests / 100,
				longitude: -10 + counters.orbitRequests / 100,
				altitude: 420,
				velocity: 27600,
				timestamp: Math.floor(Date.now() / 1000) - (stale ? 600 : 0),
			};
			counters.orbitSamples.push(structuredClone(sample));
			return json(response, 200, {
				name: "iss",
				id: 25544,
				...sample,
				visibility: "daylight",
				units: "kilometers",
			});
		}
		if (path === "/graphql" && request.method === "POST") {
			counters.snapshots += 1;
			counters.snapshotActiveSubscriptions.push(counters.activeSubscriptions);
			request.resume();
			const vehicles = [...fleet.values()];
			return json(response, 200, {
				data: { vehicles: reverseSnapshots ? vehicles.reverse() : vehicles },
			});
		}
		json(response, 404, { error: "Unknown fixture endpoint" });
	});
	const sockets = new WebSocketServer({
		server,
		path: "/graphql",
		handleProtocols: (protocols) =>
			protocols.has("graphql-transport-ws") ? "graphql-transport-ws" : false,
	});
	const send = (operation: Operation, vehicles: FixtureVehicle[]) => {
		if (operation.socket.readyState !== WebSocket.OPEN) return;
		operation.socket.send(
			JSON.stringify({
				id: operation.id,
				type: "next",
				payload: { data: { vehicles } },
			}),
		);
	};
	sockets.on("connection", (socket) => {
		counters.connections += 1;
		counters.activeConnections += 1;
		let initialised = false;
		let ackTimer: ReturnType<typeof setTimeout> | undefined;
		const finish = (id?: string) => {
			for (const operation of operations) {
				if (operation.socket !== socket || (id && operation.id !== id))
					continue;
				operations.delete(operation);
				if (!operation.query) counters.activeSubscriptions -= 1;
			}
		};
		socket.on("close", () => {
			clearTimeout(ackTimer);
			counters.activeConnections -= 1;
			finish();
		});
		socket.on("message", (raw) => {
			let message: {
				type: string;
				id?: string;
				payload?: { query?: string };
			};
			try {
				message = JSON.parse(raw.toString());
			} catch {
				socket.close(4400, "Invalid JSON");
				return;
			}
			if (message.type === "connection_init") {
				if (initialised) return socket.close(4429, "Already initialised");
				initialised = true;
				counters.inits.push(message.payload);
				const acknowledge = () => {
					if (socket.readyState === WebSocket.OPEN) {
						socket.send(JSON.stringify({ type: "connection_ack" }));
					}
				};
				if (ackDelay > 0) ackTimer = setTimeout(acknowledge, ackDelay);
				else acknowledge();
			} else if (message.type === "ping") {
				socket.send(JSON.stringify({ type: "pong", payload: message.payload }));
			} else if (message.type === "complete") {
				counters.completes += 1;
				finish(message.id);
			} else if (message.type === "subscribe" && message.id) {
				if (!initialised) return socket.close(4401, "Not initialised");
				if (
					[...operations].some(
						(op) => op.socket === socket && op.id === message.id,
					)
				) {
					return socket.close(4409, "Duplicate operation");
				}
				const query = message.payload?.query ?? "";
				counters.queries.push(query);
				const operation = {
					socket,
					id: message.id,
					query: !/\bsubscription\b/.test(query),
				};
				operations.add(operation);
				if (!operation.query) counters.activeSubscriptions += 1;
				send(operation, [...fleet.values()]);
				if (operation.query) {
					socket.send(JSON.stringify({ id: message.id, type: "complete" }));
					operations.delete(operation);
				}
			}
		});
	});
	const interval = setInterval(() => {
		if (paused) return;
		sequence += 1;
		const vehicle = fleet.get("oslo-31");
		if (!vehicle) return;
		const changed = {
			...vehicle,
			lastUpdated: new Date(Date.now() - (stale ? 600_000 : 0)).toISOString(),
			location: { latitude: 59.92 + sequence / 100_000, longitude: 10.75 },
		};
		fleet.set(changed.vehicleId, changed);
		for (const operation of operations) {
			if (!operation.query) send(operation, [changed]);
		}
	}, 350);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("Missing fixture port");
	const origin = `http://127.0.0.1:${address.port}`;
	return {
		counters,
		vehicles() {
			return structuredClone([...fleet.values()]);
		},
		orbitEndpoint: `${origin}/iss`,
		transitEndpoint: `${origin.replace("http:", "ws:")}/graphql`,
		setOrbitFailure(status: number) {
			orbitFailure = status;
		},
		setOrbitSample(value: FixtureOrbitSample | null) {
			orbitSample = value ? structuredClone(value) : null;
		},
		setReverseSnapshots(value: boolean) {
			reverseSnapshots = value;
		},
		setAckDelay(milliseconds: number) {
			ackDelay = milliseconds;
		},
		setPaused(value: boolean) {
			paused = value;
		},
		setStale(value: boolean) {
			stale = value;
			if (value) {
				fleet = new Map(
					[...fleet].map(([id, vehicle]) => [
						id,
						{
							...vehicle,
							lastUpdated: new Date(Date.now() - 600_000).toISOString(),
						},
					]),
				);
			}
		},
		emit(vehicles: FixtureVehicle[]) {
			for (const vehicle of vehicles) {
				const previous = fleet.get(vehicle.vehicleId);
				if (
					!previous ||
					fixtureTimestamp(vehicle.lastUpdated) >=
						fixtureTimestamp(previous.lastUpdated)
				) {
					fleet.set(vehicle.vehicleId, vehicle);
				}
			}
			for (const operation of operations) send(operation, vehicles);
		},
		malformed() {
			for (const operation of operations) {
				operation.socket.send(
					JSON.stringify({
						id: operation.id,
						type: "next",
						payload: {
							data: { vehicles: [{ vehicleId: "bad", location: null }] },
						},
					}),
				);
			}
		},
		disconnect() {
			for (const socket of sockets.clients) socket.terminate();
		},
		async close() {
			clearInterval(interval);
			const httpClosed = new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
			server.closeAllConnections();
			for (const socket of sockets.clients) socket.terminate();
			await Promise.all([
				httpClosed,
				new Promise<void>((resolve) => sockets.close(() => resolve())),
			]);
		},
	};
}

function fixtureTimestamp(value: string): string {
	const fraction = /\.(\d+)Z$/.exec(value)?.[1] ?? "";
	return `${value.slice(0, 19)}.${fraction.padEnd(9, "0")}Z`;
}

function initialFleet(): Map<string, FixtureVehicle> {
	return new Map(
		["31", "54"].map((line, index) => {
			const vehicle: FixtureVehicle = {
				vehicleId: `oslo-${line}`,
				lastUpdated: new Date().toISOString(),
				location: { latitude: 59.92 + index / 100, longitude: 10.75 },
				line: { publicCode: line },
				bearing: 45,
				speed: 8,
				delay: 0,
				destinationName: index === 0 ? "Snarøya" : "Kjelsås",
				monitoredCall: null,
			};
			return [vehicle.vehicleId, vehicle];
		}),
	);
}

export type ExampleServer = Awaited<ReturnType<typeof createExampleServer>>;
