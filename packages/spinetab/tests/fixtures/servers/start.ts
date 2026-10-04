import { readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { extname, join, normalize } from "node:path";
import type { Duplex } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { register as registerAi } from "./ai.ts";
import {
	type Fault,
	type FixtureApp,
	type HttpHandler,
	readJson,
	sendJson,
	type UpgradeHandler,
} from "./app.ts";
import { register as registerBench } from "./bench.ts";
import { register as registerGraphqlSse } from "./graphql-sse.ts";
import { register as registerGraphqlWs } from "./graphql-ws.ts";
import { register as registerPolling } from "./polling.ts";
import { register as registerSocketIo } from "./socket-io.ts";
import { register as registerSse } from "./sse.ts";
import { register as registerStream } from "./stream.ts";
import { register as registerTrpc } from "./trpc.ts";
import { register as registerWs } from "./ws.ts";

const harnessDir = fileURLToPath(new URL("../harness/dist/", import.meta.url));
const contentTypes: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json",
	".map": "application/json",
	".svg": "image/svg+xml",
};

export interface RunningFixtures {
	apps: FixtureApp[];
	close(): Promise<void>;
}

/**
 * Start one fixture instance per requested port. Port 0 asks the OS for a free
 * port (used by Vitest so parallel runs never collide); Playwright uses 4500/4501.
 */
export async function startFixtures(
	ports: number[] = [4500, 4501],
): Promise<RunningFixtures> {
	const apps: FixtureApp[] = [];
	for (const port of ports) apps.push(await startOne(port, ports));
	return {
		apps,
		close: async () => {
			await Promise.all(apps.map((app) => app.close()));
		},
	};
}

/** How long protocol close hooks may take before owned sockets are destroyed. */
const CLOSE_HOOK_DEADLINE_MS = 1_000;

async function startOne(
	requestedPort: number,
	_allPorts: number[],
): Promise<FixtureApp> {
	let port = requestedPort;
	const routes: Array<{
		method: string;
		prefix: string;
		handler: HttpHandler;
	}> = [];
	const upgrades = new Map<string, UpgradeHandler>();
	const faults = new Map<string, Fault>();
	const resets: Array<() => void> = [];
	const closers: Array<() => void | Promise<void>> = [];
	// Node's closeAllConnections() does not touch sockets handed over by an
	// `upgrade`, so owned HTTP and upgraded sockets are tracked and destroyed on
	// close.
	const httpSockets = new Set<Socket>();
	const upgradedSockets = new Set<Duplex>();
	let closing: Promise<void> | undefined;
	const counters: FixtureApp["counters"] = {};
	// Strict same-origin policy for the harness. connect-src lists every fixture
	// origin so cross-origin isolation tests can reach the second instance.
	let csp = "";
	const setCsp = (ports: number[]) => {
		const sources = ports
			.flatMap((p) => [`http://127.0.0.1:${p}`, `ws://127.0.0.1:${p}`])
			.join(" ");
		csp = `default-src 'self'; script-src 'self'; worker-src 'self'; connect-src 'self' ${sources}; style-src 'self' 'unsafe-inline'`;
	};

	const server = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
		try {
			if (url.pathname === "/__fixture/counters") {
				return sendJson(res, 200, counters);
			}
			if (url.pathname === "/__fixture/reset" && req.method === "POST") {
				faults.clear();
				for (const reset of resets) reset();
				return sendJson(res, 200, { ok: true });
			}
			if (url.pathname === "/__fixture/fault" && req.method === "POST") {
				const body = (await readJson(req)) as Fault | Fault[] | undefined;
				const list = Array.isArray(body) ? body : body ? [body] : [];
				for (const fault of list) {
					const key = `${fault.target}:${fault.action}`;
					if (fault.value === false || fault.value === null) faults.delete(key);
					else faults.set(key, fault);
				}
				return sendJson(res, 200, { faults: [...faults.values()] });
			}
			if (url.pathname.startsWith("/harness")) {
				return serveHarness(url.pathname, res, csp);
			}
			for (const route of routes) {
				if (
					(route.method === "*" || route.method === req.method) &&
					url.pathname.startsWith(route.prefix)
				) {
					await route.handler(req, res, url);
					return;
				}
			}
			sendJson(res, 404, { error: "not-found", path: url.pathname });
		} catch (error) {
			if (!res.headersSent) {
				sendJson(res, 500, { error: String(error) });
			} else {
				res.end();
			}
		}
	});

	server.on("connection", (socket) => {
		httpSockets.add(socket);
		socket.once("close", () => httpSockets.delete(socket));
	});

	server.on("upgrade", (req, socket, head) => {
		httpSockets.delete(socket as Socket);
		upgradedSockets.add(socket);
		socket.once("close", () => upgradedSockets.delete(socket));
		const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
		const handler = upgrades.get(url.pathname);
		if (handler) handler(req, socket, head, url);
		else if (!url.pathname.startsWith("/socket.io")) socket.destroy();
	});

	const close = (): Promise<void> => {
		closing ??= (async () => {
			// Stop accepting first, then let protocol modules close their servers
			// and timers, then destroy whatever is still open so `server.close`
			// can complete deterministically.
			const closed = new Promise<void>((resolve) => {
				server.close(() => resolve());
			});
			await Promise.race([
				Promise.allSettled(closers.map(async (hook) => hook())),
				delay(CLOSE_HOOK_DEADLINE_MS),
			]);
			server.closeAllConnections?.();
			for (const socket of upgradedSockets) socket.destroy();
			for (const socket of httpSockets) socket.destroy();
			upgradedSockets.clear();
			httpSockets.clear();
			await closed;
			knownPorts.delete(port);
			const index = knownApps.findIndex((entry) => entry.port === port);
			if (index >= 0) knownApps.splice(index, 1);
		})();
		return closing;
	};

	const app: FixtureApp = {
		get port() {
			return port;
		},
		get origin() {
			return `http://127.0.0.1:${port}`;
		},
		server,
		http: (method, prefix, handler) => {
			routes.push({ method, prefix, handler });
		},
		upgrade: (pathname, handler) => {
			upgrades.set(pathname, handler);
		},
		counters,
		fault: (target, action) => faults.get(`${target}:${action}`),
		takeFault: (target, action) => {
			const key = `${target}:${action}`;
			const fault = faults.get(key);
			faults.delete(key);
			return fault;
		},
		onReset: (callback) => {
			resets.push(callback);
		},
		onClose: (callback) => {
			closers.push(callback);
		},
		close,
		authorise: (header) => {
			if (faults.has("auth:accept-all")) return { ok: true, scope: "any" };
			const token = header?.startsWith("Bearer ") ? header.slice(7) : "";
			const match = /^valid-([^-]+)-\d+$/.exec(token);
			if (!match) return { ok: false, status: 401 };
			const scope = match[1] as string;
			const rejected = faults.get("auth:reject-scope");
			if (rejected && rejected.value === scope)
				return { ok: false, status: 401 };
			return { ok: true, scope };
		},
	};

	registerWs(app);
	registerSse(app);
	registerStream(app);
	registerPolling(app);
	registerGraphqlWs(app);
	registerGraphqlSse(app);
	registerSocketIo(app);
	registerTrpc(app);
	registerAi(app);
	registerBench(app);

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(requestedPort, "127.0.0.1", () => resolve());
	});
	const address = server.address();
	if (address && typeof address === "object") port = address.port;
	setCsp([port]);
	knownPorts.add(port);
	for (const other of knownApps) other.updateCsp([...knownPorts]);
	knownApps.push({ port, updateCsp: (ports) => setCsp(ports) });
	return app;
}

// Instances started in one process advertise each other's origins in the CSP.
const knownPorts = new Set<number>();
const knownApps: Array<{ port: number; updateCsp: (ports: number[]) => void }> =
	[];

function serveHarness(
	pathname: string,
	res: import("node:http").ServerResponse,
	csp: string,
) {
	const relative = pathname.replace(/^\/harness\/?/, "") || "index.html";
	const file = normalize(join(harnessDir, relative));
	if (!file.startsWith(harnessDir)) {
		return sendJson(res, 403, { error: "forbidden" });
	}
	try {
		const target = statSync(file).isDirectory()
			? join(file, "index.html")
			: file;
		res.writeHead(200, {
			"content-type":
				contentTypes[extname(target)] ?? "application/octet-stream",
			"content-security-policy": csp,
			"cache-control": "no-store",
		});
		res.end(readFileSync(target));
	} catch {
		sendJson(res, 404, { error: "harness-not-built", file: relative });
	}
}

const isMain =
	process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
	const ports = process.argv
		.slice(2)
		.map(Number)
		.filter((n) => Number.isInteger(n) && n >= 0);
	const running = await startFixtures(ports.length ? ports : undefined);
	console.log(
		`spinetab fixtures listening on ${running.apps.map((a) => a.origin).join(", ")}`,
	);
	const stop = () => running.close().then(() => process.exit(0));
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
}
