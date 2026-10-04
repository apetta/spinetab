// Structural types let build entries type-check without installing their bundler peers.

import type { SpinetabAdapterName } from "./adapters.ts";

export type { SpinetabAdapterName } from "./adapters.ts";

export interface SpinetabPluginOptions {
	/** Your worker file, relative to the project root. Default: `spinetab.worker.{ts,mts,js,mjs}` in `src/`, `app/` or the root when present; otherwise the plugin generates the worker. */
	worker?: string;
	/** Adapters for the generated worker. Default: inferred from your `spinetab/<source>` imports. */
	adapters?: readonly SpinetabAdapterName[];
	/** Exact `https:` origins, besides the page's own, that may receive provider credentials. Generated worker only; a worker file sets it in `defineWorker`. */
	credentialOrigins?: readonly string[];
}

/** `withSpinetab(config, options)`: the plugin options plus `dir` (Next only). */
export interface SpinetabNextOptions extends SpinetabPluginOptions {
	/** The Next project directory, the one holding next.config, as an absolute path (for example `__dirname`). Needed only when `next` runs from another directory, such as `next dev apps/web` from a monorepo root. Default: the invocation directory when it holds next.config, else the `next <command> <dir>` directory when that holds one. */
	dir?: string;
}

/** Options the shared `spinetab/loader` receives (JSON, part of cache keys). */
export interface SpinetabLoaderOptions {
	role: "worker" | "wiring";
	/** Explicit adapter set, or `null` to scan `roots` on every run. */
	adapters: string[] | null;
	credentialOrigins: string[];
	/** Absolute scan roots; the first is the project root. Never emitted. */
	roots: string[];
	/** Absolute directories inference never walks: the bundler's output. */
	excludes?: string[];
	dev: boolean;
	/** Generator version: a cache key only, never output. */
	version: string;
	/** L2 only: the absolute worker file, hashed for the development name. */
	worker?: string | null;
}
