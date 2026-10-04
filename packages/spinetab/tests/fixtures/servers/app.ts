import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

/**
 * Minimal fixture application shared by every protocol module. Modules register
 * HTTP routes and WebSocket upgrade paths, keep their own counters under a
 * namespace and read faults set through `/__fixture/fault`.
 */
export type HttpHandler = (
	req: IncomingMessage,
	res: ServerResponse,
	url: URL,
) => void | Promise<void>;
export type UpgradeHandler = (
	req: IncomingMessage,
	socket: Duplex,
	head: Buffer,
	url: URL,
) => void;

export interface Fault {
	target: string;
	action: string;
	value?: unknown;
}

export interface FixtureApp {
	readonly port: number;
	readonly origin: string;
	readonly server: Server;
	/** Register a route. Prefix match on `pathname`; first match wins. */
	http(method: string | "*", pathPrefix: string, handler: HttpHandler): void;
	/** Register a WebSocket upgrade handler for an exact pathname. */
	upgrade(pathname: string, handler: UpgradeHandler): void;
	/** Mutable counters namespace; modules create their own key. */
	counters: Record<string, Record<string, unknown>>;
	/** Current fault for a target/action, or undefined. */
	fault(target: string, action: string): Fault | undefined;
	/** Remove and return a fault for a target/action (one-shot faults). */
	takeFault(target: string, action: string): Fault | undefined;
	/** Called on `/__fixture/reset`; modules clear counters and faults here. */
	onReset(callback: () => void): void;
	/**
	 * Called once when the fixture shuts down, before owned sockets are
	 * destroyed. Modules close their WebSocket servers, Socket.IO instances and
	 * timers here. Hooks are awaited with a bounded deadline.
	 */
	onClose(callback: () => void | Promise<void>): void;
	/** Stop accepting, run close hooks, destroy owned sockets and close. Idempotent. */
	close(): Promise<void>;
	/** Accept a bearer token for the scope encoded in `valid-<scope>-<n>`. */
	authorise(
		header: string | undefined,
	): { ok: true; scope: string } | { ok: false; status: 401 };
}

export function readJson(req: IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			const text = Buffer.concat(chunks).toString("utf8");
			if (!text) return resolve(undefined);
			try {
				resolve(JSON.parse(text));
			} catch (error) {
				reject(error);
			}
		});
		req.on("error", reject);
	});
}

export function sendJson(res: ServerResponse, status: number, body: unknown) {
	res.writeHead(status, {
		"content-type": "application/json",
		"cache-control": "no-store",
	});
	res.end(JSON.stringify(body));
}

export const sleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));
