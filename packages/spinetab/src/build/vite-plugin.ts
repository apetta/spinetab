import { join, resolve } from "node:path";
import { applyDevName, runtimeSpecifiers } from "./generate.ts";
import { buildMessage, SpinetabBuildError } from "./messages.ts";
import { validateOptions } from "./options.ts";
import { findPackageDir, inNodeModules, relativePosix } from "./paths.ts";
import {
	type AdapterSet,
	adapterEntryOf,
	type BuildPlan,
	checkGraph,
	devNameFor,
	isConventionalWorkerPath,
	isDefaultWiringPath,
	recordImport,
	resolveAdapterSet,
	resolvePlan,
} from "./plan.ts";
import type { SpinetabPluginOptions } from "./types.ts";

export interface ViteResolvedConfigLike {
	logger: { warn(message: string): void };
	server?: { middlewareMode?: boolean | object };
}

interface OutputChunkLike {
	type: string;
	fileName: string;
	facadeModuleId?: string | null;
	isEntry?: boolean;
}

type OutputBundleLike = Record<string, OutputChunkLike>;

interface DevEnvironmentLike {
	moduleGraph: {
		getModuleById(id: string): unknown;
		invalidateModule(
			module: never,
			seen?: Set<never>,
			timestamp?: number,
			isHmr?: boolean,
		): void;
	};
	hot: { send(payload: { type: "full-reload" }): void };
}

export interface ViteDevServerLike {
	watcher: {
		on(event: "all", listener: (event: string, file: string) => void): unknown;
	};
	environments: Record<string, DevEnvironmentLike>;
	config: ViteResolvedConfigLike;
	restart(forceOptimize?: boolean): Promise<void>;
}

interface BuildContextLike {
	getModuleIds(): IterableIterator<string>;
	// An Error, not a string: Rolldown folds the stack of a string report
	// (this plugin's frames, absolute paths) into the message.
	error(error: Error): never;
}

/** The worker-bundle half: the same resolver inside `worker.plugins`. */
export interface SpinetabViteWorkerPlugin {
	name: string;
	enforce: "pre";
	resolveId(id: string, importer?: string): string | undefined;
	load(id: string): string | undefined;
	generateBundle?(options: unknown, bundle: OutputBundleLike): void;
}

export interface SpinetabVitePlugin {
	name: "spinetab";
	enforce: "pre";
	applyToEnvironment(environment: { config: { consumer: string } }): boolean;
	config(
		user: { root?: string; build?: { outDir?: string } },
		env: { command: string },
	): {
		optimizeDeps: { exclude: string[]; include: string[] };
		worker: { plugins: () => SpinetabViteWorkerPlugin[] };
	};
	configResolved(config: ViteResolvedConfigLike): void;
	resolveId(id: string, importer?: string): string | undefined;
	load(id: string): string | undefined;
	transform(code: string, id: string): string | undefined;
	buildEnd(this: BuildContextLike, error?: Error): void;
	configureServer(server: ViteDevServerLike): void;
	generateBundle?(options: unknown, bundle: OutputBundleLike): void;
}

export interface VitePluginContext {
	/** Absolute project root (Astro passes `config.root`). */
	root?: string;
	/** Development (Astro passes `command === "dev"`). */
	dev?: boolean;
	/** Framework resource-hint integration, populated from actual emitted entries. */
	resources?: { worker: Set<string>; local: Set<string> };
}

interface State {
	root: string;
	dev: boolean;
	plan: BuildPlan;
	set: AdapterSet | undefined;
	autoWiring: string;
	stub: string;
	autoWorker: string;
	includes: readonly string[];
	excludes: readonly string[];
	imported: Map<string, Set<string>>;
}

export function createVitePlugin(
	options?: SpinetabPluginOptions,
	context: VitePluginContext = {},
): SpinetabVitePlugin {
	let state: State | undefined;
	const pending: string[] = [];

	const redirect = (id: string, importer?: string): string | undefined => {
		if (!state) return undefined;
		if (id === "spinetab/wiring") return state.autoWiring;
		if (id === "spinetab/worker-config") {
			return state.plan.level === "L2" ? state.plan.workerFile : state.stub;
		}
		const entry = adapterEntryOf(id);
		if (entry && importer && !inNodeModules(importer)) {
			recordImport(state.imported, entry, cleanId(importer));
		}
		return undefined;
	};
	// The query is stripped and ignored; content depends on the plan only.
	const generated = (id: string): string | undefined => {
		if (state?.plan.level !== "L3") return undefined;
		return cleanId(id) === state.stub ? state.set?.text : undefined;
	};
	const workerHalf = (): SpinetabViteWorkerPlugin => ({
		name: "spinetab:worker",
		enforce: "pre",
		resolveId: (id, importer) => redirect(id, importer),
		load: (id) => generated(id),
		...(context.resources
			? {
					generateBundle(_options: unknown, bundle: OutputBundleLike) {
						for (const chunk of Object.values(bundle)) {
							if (
								chunk.type === "chunk" &&
								chunk.isEntry &&
								chunk.facadeModuleId &&
								cleanId(chunk.facadeModuleId) === state?.autoWorker
							) {
								context.resources?.worker.add(chunk.fileName);
							}
						}
					},
				}
			: {}),
	});

	return {
		name: "spinetab",
		enforce: "pre",
		applyToEnvironment: (environment) =>
			environment.config.consumer === "client",
		config(user, env) {
			context.resources?.worker.clear();
			context.resources?.local.clear();
			const root = resolve(context.root ?? user.root ?? process.cwd());
			const dev = context.dev ?? env.command === "serve";
			const plan = resolvePlan(root, validateOptions(options));
			const excludes = [resolve(root, user.build?.outDir ?? "dist")];
			const set =
				plan.level === "L3"
					? resolveAdapterSet(plan, { dev, excludes })
					: undefined;
			pending.push(...(set?.warnings ?? []));
			const packageDir = findPackageDir(root);
			const includes = set ? runtimeSpecifiers(set.kinds) : [];
			state = {
				root,
				dev,
				plan,
				set,
				autoWiring: join(packageDir, "dist", "auto", "wiring.js"),
				autoWorker: join(packageDir, "dist", "auto", "worker.js"),
				stub: join(packageDir, "dist", "worker-config.js"),
				includes,
				excludes,
				imported: new Map(),
			};
			return {
				optimizeDeps: {
					exclude: ["spinetab/wiring"],
					include: ["spinetab/worker", ...includes],
				},
				worker: { plugins: () => [workerHalf()] },
			};
		},
		configResolved(config) {
			for (const message of pending.splice(0)) config.logger.warn(message);
		},
		resolveId: (id, importer) => redirect(id, importer),
		load: (id) => generated(id),
		transform(code, id) {
			if (!state?.dev || cleanId(id) !== state.autoWiring) return undefined;
			return applyDevName(code, devNameFor(state.plan, state.set));
		},
		buildEnd(error) {
			if (error || !state || state.dev) return;
			for (const id of this.getModuleIds()) {
				if (isDefaultWiringPath(cleanId(id))) {
					this.error(new SpinetabBuildError({ code: "wiring-not-applied" }));
				}
			}
			if (state.set) {
				const failure = checkGraph(state.set, state.imported);
				if (failure) this.error(failure);
			}
		},
		configureServer(server) {
			server.watcher.on("all", (event, file) => {
				if (!state) return;
				onWatch(server, state, event, resolve(file));
			});
		},
		...(context.resources
			? {
					generateBundle(_options: unknown, bundle: OutputBundleLike) {
						for (const chunk of Object.values(bundle)) {
							if (
								chunk.type === "chunk" &&
								chunk.facadeModuleId &&
								cleanId(chunk.facadeModuleId) === state?.autoWorker
							) {
								context.resources?.local.add(chunk.fileName);
							}
						}
					},
				}
			: {}),
	};
}

function onWatch(
	server: ViteDevServerLike,
	state: State,
	event: string,
	file: string,
): void {
	if (event !== "add" && event !== "change" && event !== "unlink") return;
	if (
		(event === "add" || event === "unlink") &&
		isConventionalWorkerPath(state.root, file)
	) {
		server.config.logger.warn(
			buildMessage({
				code: "restart-required",
				files: [relativePosix(state.root, file)],
			}),
		);
		return;
	}
	if (state.plan.level === "L2") {
		if (file === state.plan.workerFile) reload(server, state);
		return;
	}
	if (state.plan.adapters !== null || !state.set || inNodeModules(file)) return;
	if (!state.plan.roots.some((root) => file.startsWith(root))) return;
	let next: AdapterSet;
	try {
		next = resolveAdapterSet(state.plan, {
			dev: true,
			excludes: state.excludes,
		});
	} catch (error) {
		server.config.logger.warn(
			error instanceof SpinetabBuildError ? error.message : String(error),
		);
		return;
	}
	if (next.text === state.set.text) return;
	const needed = runtimeSpecifiers(next.kinds);
	if (needed.some((specifier) => !state.includes.includes(specifier))) {
		if (server.config.server?.middlewareMode) {
			// Frameworks own the middleware server's restart. Vite's bare
			// restart can orphan its optimiser under Nuxt.
			server.config.logger.warn(
				buildMessage({
					code: "adapter-restart-required",
					files: [relativePosix(state.root, file)],
				}),
			);
			return;
		}
		state.set = next;
		// A runtime entry the optimiser has not bundled: restart so `config()`
		// re-runs with the new include list instead of mixing pre-bundles.
		void server.restart();
		return;
	}
	state.set = next;
	reload(server, state);
}

/** Invalidate the seams in every environment and reload every tab. */
function reload(server: ViteDevServerLike, state: State): void {
	for (const environment of Object.values(server.environments)) {
		const graph = environment.moduleGraph;
		for (const id of [state.stub, state.autoWiring]) {
			const module = graph.getModuleById(id);
			if (module) {
				graph.invalidateModule(module as never, new Set(), Date.now(), true);
			}
		}
	}
	// Every open tab listens on the client environment's channel.
	const client =
		server.environments.client ?? Object.values(server.environments)[0];
	client?.hot.send({ type: "full-reload" });
}

function cleanId(id: string): string {
	const query = id.indexOf("?");
	return query === -1 ? id : id.slice(0, query);
}
