import { existsSync, readFileSync, statSync } from "node:fs";
import {
	createServer,
	request as httpRequest,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { connect, type Socket } from "node:net";
import { basename, extname, join, normalize, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Front server for packed-consumer cells. Node built-ins
 * only. It serves a static build (or passes through to a dev/`next start`
 * upstream), proxies `<mount>fx/*` to the fixture server so every endpoint is
 * same-origin, sets the cell's CSP on document and worker responses, and logs
 * each request with its `Sec-Fetch-Dest`, status, CSP and body bytes.
 *
 * node front.ts --port 4610 --static dist [--mount /app/] [--spa]
 * [--csp <policy>] [--worker-csp <policy>] [--worker-file <name>]
 * [--fixture http://127.0.0.1:4500] [--drop <file>] [--mime <file>=<type>]
 * [--static-overlay <dir>] [--route /api/chat=<module>]
 * node front.ts --port 4611 --upstream http://127.0.0.1:4711
 *
 * `GET /__front/log`, `POST /__front/reset` and `POST /__front/drop` (JSON
 * `{ files: [], restore?: true }`) are test controls. Upstream mode never injects CSP: the
 * framework sets its own.
 *
 * A `--mime` override also sends `X-Content-Type-Options: nosniff`, so the
 * wrong type is authoritative in every engine: WebKit 26.6 runs a module
 * SharedWorker served as `text/plain` unless `nosniff` is present
 * in browser failure checks. Static responses
 * log the `content-type` and `x-content-type-options` actually sent.
 */

export interface FrontOptions {
	port: number;
	host?: string;
	static?: string;
	/** Second deployment: served at `<mount>v2/` and as fallback for assets. */
	overlay?: string;
	mount?: string;
	spa?: boolean;
	upstream?: string;
	csp?: string;
	workerCsp?: string;
	/** Worker script names, when `Sec-Fetch-Dest` is not sent. */
	workerFiles?: string[];
	fixture?: string;
	drop?: string[];
	/** Content type overrides by file name; each also sends `nosniff`. */
	mime?: Record<string, string>;
	/** Route path (relative to the mount, leading slash) → handler module. */
	routes?: Record<string, string>;
}

export interface LoggedRequest {
	method: string;
	path: string;
	dest: string | null;
	/**
	 * Same-origin `Referer` path, else null. A worker's `importScripts`
	 * (Turbopack's worker bootstrap) sends destination `script` with the
	 * worker's URL as referrer, which tells worker scripts from page ones.
	 */
	referrer?: string | null;
	status: number;
	csp: string | null;
	bytes: number;
	at: number;
	/** `content-type` sent with a static file, else null. */
	contentType: string | null;
	/** `x-content-type-options` sent with a static file, else null. */
	contentTypeOptions: string | null;
}

export interface FrontLog {
	requests: LoggedRequest[];
	proxied: Record<string, number>;
	misrouted: string[];
}

export interface Front {
	readonly origin: string;
	readonly port: number;
	log(): FrontLog;
	reset(): void;
	/** Answer 404 for these files (or serve them again with `restore`). */
	drop(files: string[], restore?: boolean): void;
	close(): Promise<void>;
}

const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".cjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json",
	".map": "application/json",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".txt": "text/plain; charset=utf-8",
	".woff2": "font/woff2",
	".wasm": "application/wasm",
};

type RouteHandler = (request: Request) => Response | Promise<Response>;
type RouteModule = Partial<Record<string, RouteHandler>> & {
	default?: RouteHandler;
};

export async function startFront(options: FrontOptions): Promise<Front> {
	const host = options.host ?? "127.0.0.1";
	const mount = normaliseMount(options.mount ?? "/");
	const fixture = new URL(options.fixture ?? "http://127.0.0.1:4500");
	const upstream = options.upstream ? new URL(options.upstream) : undefined;
	const staticRoot = options.static ? resolve(options.static) : undefined;
	const overlayRoot = options.overlay ? resolve(options.overlay) : undefined;
	if (!staticRoot && !upstream) {
		throw new Error("front: pass --static <dir> or --upstream <origin>");
	}
	const drops = new Set(options.drop ?? []);
	const workerFiles = new Set(options.workerFiles ?? []);
	const routeModules = new Map<string, Promise<RouteModule>>();
	const sockets = new Set<Socket>();
	let log: FrontLog = { requests: [], proxied: {}, misrouted: [] };
	let port = options.port;

	const track = (socket: Socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	};

	const record = (req: IncomingMessage, path: string): LoggedRequest => {
		const entry: LoggedRequest = {
			method: req.method ?? "GET",
			path,
			dest: headerValue(req.headers["sec-fetch-dest"]),
			referrer: sameOriginPath(req),
			status: 0,
			csp: null,
			bytes: 0,
			at: Date.now(),
			contentType: null,
			contentTypeOptions: null,
		};
		log.requests.push(entry);
		return entry;
	};

	const server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", `http://${host}`);
		const path = `${url.pathname}${url.search}`;
		if (url.pathname === "/__front/log") {
			return json(res, 200, log);
		}
		if (url.pathname === "/__front/reset" && req.method === "POST") {
			log = { requests: [], proxied: {}, misrouted: [] };
			return json(res, 200, { ok: true });
		}
		if (url.pathname === "/__front/drop" && req.method === "POST") {
			void readBody(req).then((body) => {
				const request = JSON.parse(body || "{}") as {
					files?: string[];
					restore?: boolean;
				};
				for (const file of request.files ?? []) {
					if (request.restore) drops.delete(file);
					else drops.add(file);
				}
				json(res, 200, { drop: [...drops] });
			});
			return;
		}
		const entry = record(req, path);
		countBytes(res, entry);
		res.once("finish", () => {
			entry.status = res.statusCode;
		});
		res.once("close", () => {
			if (entry.status === 0) entry.status = res.statusCode;
		});

		const fxPrefix = `${mount}fx/`;
		if (url.pathname.startsWith(fxPrefix)) {
			log.proxied[path] = (log.proxied[path] ?? 0) + 1;
			const target = `/${url.pathname.slice(fxPrefix.length)}${url.search}`;
			return proxyHttp(req, res, fixture, target, fixture.host, track);
		}
		if (url.pathname.includes("/fx/")) {
			log.misrouted.push(path);
			return json(res, 404, { error: "misrouted", path });
		}
		if (!url.pathname.startsWith(mount) && staticRoot) {
			return json(res, 404, { error: "outside-mount", path });
		}
		const relativePath = `/${url.pathname.slice(mount.length)}`;
		const routeModule = options.routes?.[relativePath];
		if (routeModule) {
			return void serveRoute(req, res, url, routeModule, routeModules, () =>
				applyCsp(res, entry, false),
			).catch((error: unknown) => {
				if (!res.headersSent) json(res, 500, { error: String(error) });
				else res.destroy();
			});
		}
		if (upstream) {
			return proxyHttp(
				req,
				res,
				upstream,
				path,
				req.headers.host ?? upstream.host,
				track,
			);
		}
		const file = decodeURIComponent(url.pathname.slice(mount.length));
		const name = basename(file);
		if (drops.has(file) || drops.has(name)) {
			return json(res, 404, { error: "dropped", path });
		}
		const found = locate(file, staticRoot as string, overlayRoot, options.spa);
		if (!found) return json(res, 404, { error: "not-found", path });
		const isWorker =
			entry.dest === "sharedworker" ||
			entry.dest === "worker" ||
			workerFiles.has(basename(found));
		applyCsp(res, entry, isWorker);
		const override = options.mime?.[basename(found)] ?? options.mime?.[file];
		const headers: Record<string, string> = {
			"content-type":
				override ?? CONTENT_TYPES[extname(found)] ?? "application/octet-stream",
			"cache-control": "no-store",
		};
		if (override !== undefined) headers["x-content-type-options"] = "nosniff";
		entry.contentType = headers["content-type"] ?? null;
		entry.contentTypeOptions = headers["x-content-type-options"] ?? null;
		res.writeHead(200, headers);
		res.end(req.method === "HEAD" ? undefined : readFileSync(found));
	});

	function applyCsp(
		res: ServerResponse,
		entry: LoggedRequest,
		isWorker: boolean,
	): void {
		if (upstream) return;
		const policy = isWorker ? (options.workerCsp ?? options.csp) : options.csp;
		if (!policy) return;
		res.setHeader("content-security-policy", policy);
		entry.csp = policy;
	}

	server.on("connection", track);
	server.on("upgrade", (req, rawSocket, head: Buffer) => {
		// Upgrades on an HTTP server always arrive on a net.Socket.
		const socket = rawSocket as Socket;
		track(socket);
		const url = new URL(req.url ?? "/", `http://${host}`);
		const path = `${url.pathname}${url.search}`;
		const fxPrefix = `${mount}fx/`;
		let target: URL;
		let targetPath: string;
		let hostHeader: string;
		if (url.pathname.startsWith(fxPrefix)) {
			log.proxied[path] = (log.proxied[path] ?? 0) + 1;
			target = fixture;
			targetPath = `/${url.pathname.slice(fxPrefix.length)}${url.search}`;
			hostHeader = fixture.host;
		} else if (url.pathname.includes("/fx/")) {
			log.misrouted.push(path);
			socket.destroy();
			return;
		} else if (upstream) {
			target = upstream;
			targetPath = path;
			hostHeader = req.headers.host ?? upstream.host;
		} else {
			socket.destroy();
			return;
		}
		log.requests.push({
			method: "UPGRADE",
			path,
			dest: headerValue(req.headers["sec-fetch-dest"]),
			referrer: sameOriginPath(req),
			status: 101,
			csp: null,
			bytes: 0,
			at: Date.now(),
			contentType: null,
			contentTypeOptions: null,
		});
		const peer = connect(Number(target.port || 80), target.hostname, () => {
			const lines = [`${req.method ?? "GET"} ${targetPath} HTTP/1.1`];
			for (let index = 0; index < req.rawHeaders.length; index += 2) {
				const name = req.rawHeaders[index] as string;
				const value = req.rawHeaders[index + 1] as string;
				lines.push(
					`${name}: ${name.toLowerCase() === "host" ? hostHeader : value}`,
				);
			}
			peer.write(`${lines.join("\r\n")}\r\n\r\n`);
			if (head.length > 0) peer.write(head);
			peer.pipe(socket);
			socket.pipe(peer);
		});
		track(peer);
		const destroyBoth = () => {
			peer.destroy();
			socket.destroy();
		};
		peer.once("error", destroyBoth);
		socket.once("error", destroyBoth);
		peer.once("close", () => socket.destroy());
		socket.once("close", () => peer.destroy());
	});

	await new Promise<void>((resolveListen, reject) => {
		server.once("error", reject);
		server.listen(options.port, host, () => resolveListen());
	});
	const address = server.address();
	if (address && typeof address === "object") port = address.port;

	let closing: Promise<void> | undefined;
	return {
		get origin() {
			return `http://${host}:${port}`;
		},
		get port() {
			return port;
		},
		log: () => structuredClone(log),
		reset: () => {
			log = { requests: [], proxied: {}, misrouted: [] };
		},
		drop: (files, restore = false) => {
			for (const file of files) {
				if (restore) drops.delete(file);
				else drops.add(file);
			}
		},
		close: () => {
			closing ??= new Promise<void>((resolveClose) => {
				// Stop accepting, then destroy tracked HTTP and upgraded sockets:
				// `closeAllConnections()` never reaches upgraded sockets.
				server.close(() => resolveClose());
				server.closeAllConnections();
				for (const socket of sockets) socket.destroy();
				sockets.clear();
			});
			return closing;
		},
	};
}

function normaliseMount(mount: string): string {
	let value = mount.startsWith("/") ? mount : `/${mount}`;
	if (!value.endsWith("/")) value = `${value}/`;
	return value;
}

/** Path (no query) of a same-origin `Referer`; null when absent or cross-origin. */
export function sameOriginPath(req: IncomingMessage): string | null {
	const referer = headerValue(req.headers.referer);
	const host = headerValue(req.headers.host);
	if (!referer || !host) return null;
	try {
		const url = new URL(referer);
		return url.host === host ? url.pathname : null;
	} catch {
		return null;
	}
}

function headerValue(value: string | string[] | undefined): string | null {
	if (value === undefined) return null;
	return Array.isArray(value) ? (value[0] ?? null) : value;
}

function json(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, {
		"content-type": "application/json",
		"cache-control": "no-store",
	});
	res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolveBody, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.once("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
		req.once("error", reject);
	});
}

/** Count response body bytes as they are written. */
function countBytes(res: ServerResponse, entry: LoggedRequest): void {
	const size = (chunk: unknown) =>
		typeof chunk === "string"
			? Buffer.byteLength(chunk)
			: chunk instanceof Uint8Array
				? chunk.byteLength
				: 0;
	const write = res.write;
	const end = res.end;
	res.write = function (
		this: ServerResponse,
		chunk: unknown,
		...rest: unknown[]
	) {
		entry.bytes += size(chunk);
		return (write as (...args: unknown[]) => boolean).call(
			this,
			chunk,
			...rest,
		);
	} as typeof res.write;
	res.end = function (
		this: ServerResponse,
		chunk?: unknown,
		...rest: unknown[]
	) {
		if (typeof chunk !== "function") entry.bytes += size(chunk);
		return (end as (...args: unknown[]) => ServerResponse).call(
			this,
			chunk,
			...rest,
		);
	} as typeof res.end;
}

/** Stream a request to `target` and its response back, without buffering. */
function proxyHttp(
	req: IncomingMessage,
	res: ServerResponse,
	target: URL,
	path: string,
	hostHeader: string,
	track: (socket: Socket) => void,
): void {
	const outgoing = httpRequest({
		host: target.hostname,
		port: Number(target.port || 80),
		method: req.method,
		path,
		headers: { ...req.headers, host: hostHeader },
		agent: false,
	});
	outgoing.once("socket", (socket) => track(socket));
	outgoing.once("response", (incoming) => {
		res.writeHead(incoming.statusCode ?? 502, incoming.headers);
		res.flushHeaders();
		incoming.pipe(res);
		incoming.once("error", () => res.destroy());
	});
	outgoing.once("error", (error) => {
		if (!res.headersSent) json(res, 502, { error: String(error) });
		else res.destroy();
	});
	// A client that goes away must release the upstream stream too, so fixture
	// counters see the disconnect.
	res.once("close", () => {
		if (!res.writableFinished) outgoing.destroy();
	});
	req.pipe(outgoing);
}

async function serveRoute(
	req: IncomingMessage,
	res: ServerResponse,
	url: URL,
	modulePath: string,
	cache: Map<string, Promise<RouteModule>>,
	beforeHead: () => void,
): Promise<void> {
	let loaded = cache.get(modulePath);
	if (!loaded) {
		loaded = import(
			pathToFileURL(resolve(modulePath)).href
		) as Promise<RouteModule>;
		cache.set(modulePath, loaded);
	}
	const module = await loaded;
	const method = req.method ?? "GET";
	const handler = module[method] ?? module.default;
	if (!handler) return json(res, 405, { error: "method-not-allowed" });
	const headers = new Headers();
	for (const [name, value] of Object.entries(req.headers)) {
		if (typeof value === "string") headers.set(name, value);
		else if (Array.isArray(value)) headers.set(name, value.join(", "));
	}
	const controller = new AbortController();
	res.once("close", () => controller.abort());
	const request = new Request(url.href, {
		method,
		headers,
		signal: controller.signal,
		...(method === "GET" || method === "HEAD"
			? {}
			: {
					body: Readable.toWeb(req) as ReadableStream<Uint8Array>,
					duplex: "half",
				}),
	} as RequestInit);
	const response = await handler(request);
	beforeHead();
	const outgoing: Record<string, string> = { "cache-control": "no-store" };
	response.headers.forEach((value, name) => {
		outgoing[name] = value;
	});
	res.writeHead(response.status, outgoing);
	res.flushHeaders();
	if (!response.body) {
		res.end();
		return;
	}
	const body = Readable.fromWeb(
		response.body as import("node:stream/web").ReadableStream<Uint8Array>,
	);
	body.once("error", () => res.destroy());
	body.pipe(res);
}

/** Primary build first, then the overlay deployment; `v2/` maps to the overlay. */
function locate(
	file: string,
	root: string,
	overlay: string | undefined,
	spa: boolean | undefined,
): string | undefined {
	const candidates: Array<[string, string]> = [];
	if (overlay && (file === "v2" || file.startsWith("v2/"))) {
		candidates.push([overlay, file.slice(3)]);
	} else {
		candidates.push([root, file]);
		if (overlay) candidates.push([overlay, file]);
	}
	for (const [base, relativeFile] of candidates) {
		const target = normalize(join(base, relativeFile));
		if (!target.startsWith(base)) continue;
		if (existsSync(target)) {
			const stats = statSync(target);
			if (stats.isFile()) return target;
			const index = join(target, "index.html");
			if (stats.isDirectory() && existsSync(index)) return index;
		}
	}
	if (spa && extname(file) === "") {
		const index = join(candidates[0]?.[0] ?? root, "index.html");
		if (existsSync(index)) return index;
	}
	return undefined;
}

export function parseFrontArgs(argv: readonly string[]): FrontOptions {
	const options: FrontOptions = { port: 0 };
	const list = (key: "drop" | "workerFiles", value: string) => {
		options[key] = [...(options[key] ?? []), value];
	};
	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index];
		const value = argv[index + 1];
		const take = () => {
			if (value === undefined) throw new Error(`${flag} needs a value`);
			index += 1;
			return value;
		};
		switch (flag) {
			case "--port":
				options.port = Number(take());
				break;
			case "--host":
				options.host = take();
				break;
			case "--static":
				options.static = take();
				break;
			case "--static-overlay":
				options.overlay = take();
				break;
			case "--mount":
				options.mount = take();
				break;
			case "--spa":
				options.spa = true;
				break;
			case "--upstream":
				options.upstream = take();
				break;
			case "--csp":
				options.csp = take();
				break;
			case "--worker-csp":
				options.workerCsp = take();
				break;
			case "--worker-file":
				list("workerFiles", take());
				break;
			case "--fixture":
				options.fixture = take();
				break;
			case "--drop":
				list("drop", take());
				break;
			case "--mime": {
				const [file, type] = splitPair(take(), flag);
				options.mime = { ...options.mime, [file]: type };
				break;
			}
			case "--route": {
				const [route, module] = splitPair(take(), flag);
				options.routes = { ...options.routes, [route]: module };
				break;
			}
			default:
				throw new Error(`Unknown front option ${flag}`);
		}
	}
	return options;
}

function splitPair(value: string, flag: string | undefined): [string, string] {
	const at = value.indexOf("=");
	if (at <= 0) throw new Error(`${flag} expects <key>=<value>`);
	return [value.slice(0, at), value.slice(at + 1)];
}

const isMain =
	process.argv[1] !== undefined &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
	const front = await startFront(parseFrontArgs(process.argv.slice(2)));
	console.log(`front listening on ${front.origin}`);
	const stop = () => {
		void front.close().then(() => {
			process.exitCode = 0;
		});
	};
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
}
