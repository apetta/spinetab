import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Static server for size scenarios. Logs every request
 * with its `Sec-Fetch-Dest`, same-origin `Referer` path and response bytes
 * so chunks can be classified by realm (realm.ts) and checked for off-list
 * requests. Standalone: `node size/static-server.ts <dir> [port]`.
 */

export interface LoggedRequest {
	path: string;
	dest: string | null;
	/** Same-origin `Referer` path (a worker's `importScripts` names the worker), else null. */
	referrer?: string | null;
	status: number;
	bytes: number;
}

const TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json",
	".map": "application/json",
	".svg": "image/svg+xml",
	".txt": "text/plain; charset=utf-8",
	".ico": "image/x-icon",
};

/** Path of a same-origin `Referer`; null when absent or cross-origin. */
export function sameOriginPath(
	referer: string | undefined,
	host: string | undefined,
): string | null {
	if (!referer || !host) return null;
	try {
		const url = new URL(referer);
		return url.host === host ? url.pathname : null;
	} catch {
		return null;
	}
}

export interface StaticServer {
	readonly origin: string;
	readonly log: LoggedRequest[];
	reset(): void;
	close(): Promise<void>;
}

export interface ServeOptions {
	/**
	 * Refuse matching requests with a logged 404 (the size harness's
	 * `--control block-worker` negative control; never used for measurement).
	 */
	refuse?: (request: { path: string; dest: string | null }) => boolean;
}

export async function serveStatic(
	root: string,
	port = 0,
	options: ServeOptions = {},
): Promise<StaticServer> {
	const log: LoggedRequest[] = [];
	const base = normalize(root);
	const server: Server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const dest = req.headers["sec-fetch-dest"];
		const referrer = sameOriginPath(req.headers.referer, req.headers.host);
		const record = (status: number, bytes: number) =>
			log.push({
				path: url.pathname,
				dest: typeof dest === "string" ? dest : null,
				referrer,
				status,
				bytes,
			});
		if (
			options.refuse?.({
				path: url.pathname,
				dest: typeof dest === "string" ? dest : null,
			})
		) {
			record(404, 0);
			res.writeHead(404, { "content-type": "text/plain" }).end("refused");
			return;
		}
		let file = normalize(join(base, decodeURIComponent(url.pathname)));
		if (!file.startsWith(base)) {
			record(403, 0);
			res.writeHead(403).end();
			return;
		}
		if (existsSync(file) && statSync(file).isDirectory())
			file = join(file, "index.html");
		if (!existsSync(file) && existsSync(`${file}.html`)) file = `${file}.html`;
		if (!existsSync(file)) {
			record(404, 0);
			res.writeHead(404, { "content-type": "text/plain" }).end("not found");
			return;
		}
		const body = readFileSync(file);
		record(200, body.byteLength);
		res.writeHead(200, {
			"content-type": TYPES[extname(file)] ?? "application/octet-stream",
			"cache-control": "no-store",
		});
		res.end(body);
	});
	// Upgrade attempts (scenario endpoints) have no server: refuse them.
	server.on("upgrade", (req, socket) => {
		log.push({
			path: req.url ?? "",
			dest: "websocket",
			referrer: null,
			status: 404,
			bytes: 0,
		});
		socket.destroy();
	});
	await new Promise<void>((resolve) =>
		server.listen(port, "127.0.0.1", resolve),
	);
	const address = server.address();
	const actual = typeof address === "object" && address ? address.port : port;
	return {
		origin: `http://127.0.0.1:${actual}`,
		log,
		reset: () => {
			log.length = 0;
		},
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

const isMain =
	process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
	const [dir, port] = process.argv.slice(2);
	if (!dir) throw new Error("usage: node size/static-server.ts <dir> [port]");
	const running = await serveStatic(dir, Number(port ?? 0));
	console.log(`serving ${dir} on ${running.origin}`);
	const stop = () => {
		void running.close();
	};
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
}
