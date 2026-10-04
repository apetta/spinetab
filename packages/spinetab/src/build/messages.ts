// Build messages may name an option or project-relative path, never an option value or absolute path.

import { CREDENTIAL_ORIGIN_SENTENCE } from "../core/origins.ts";

export type BuildMessageCode =
	| "worker-file-conflict"
	| "worker-file-missing"
	| "worker-file-no-default"
	| "worker-file-with-options"
	| "unknown-adapter"
	| "invalid-credential-origin"
	| "missing-peer"
	| "adapter-not-generated"
	| "wiring-not-applied"
	| "worker-parser-disabled"
	| "no-adapters"
	| "restart-required"
	| "adapter-restart-required"
	| "worker-file-not-wired"
	| "unknown-option"
	| "scan-fallback"
	| "invalid-options"
	| "invalid-worker-option"
	| "invalid-dir-option"
	| "project-directory-unknown"
	| "package-not-installed";

const SENTENCES: Record<
	Exclude<
		BuildMessageCode,
		"invalid-credential-origin" | "missing-peer" | "adapter-not-generated"
	>,
	string
> = {
	"worker-file-conflict":
		"found two spinetab.worker files; keep one, or name it with the worker option.",
	"worker-file-missing": "the file named by the worker option does not exist.",
	"worker-file-no-default":
		"the worker file must export default defineWorker(…).",
	"worker-file-with-options":
		"adapters and credentialOrigins configure the generated worker; with a worker file, set them in defineWorker instead.",
	"unknown-adapter":
		"adapters accepts polling, sse, stream, websocket, graphql-ws, graphql-sse, socket-io, trpc-ws, trpc-sse and ai-sdk.",
	"wiring-not-applied":
		"the spinetab plugin is installed but its wiring was not applied; make sure no alias or other plugin resolves spinetab first.",
	"worker-parser-disabled":
		"the bundler's worker parsing is disabled, so the SharedWorker cannot be emitted; enable module.parser.javascript.worker.",
	"no-adapters":
		"no spinetab source imports were found, so the worker has no adapters; import a source such as spinetab/polling, set the adapters option, or remove the plugin.",
	// Vite dev server: the level is decided once per run, so a
	// conventional file appearing or disappearing needs a restart.
	"restart-required":
		"a spinetab.worker file was added or removed; restart the dev server to switch between the generated worker and your worker file.",
	"adapter-restart-required":
		"a newly imported adapter needs dependency preparation; restart your framework's dev server.",
	"worker-file-not-wired":
		"a spinetab.worker file exists but was not wired; run next from the project directory or set the dir option.",
	// TypeScript rejects an extra key, but a JavaScript config with a typo
	// (`adapter:`) would otherwise be silently inert.
	"unknown-option":
		"the spinetab plugin accepts worker, adapters and credentialOrigins; withSpinetab also accepts dir.",
	// Option shapes a JavaScript config can get wrong; the value is
	// never echoed (a path may name the machine).
	"invalid-options": "the spinetab plugin options must be an object.",
	"invalid-worker-option":
		"the worker option must be a file path relative to the project root.",
	"invalid-dir-option":
		"the dir option must be the absolute path of the directory that holds next.config.",
	// `next dev <dir>` evaluates next.config in a child that has neither
	// the directory argument nor that directory as its cwd; planning against
	// the invocation directory would scan or wire the wrong tree.
	// Also for an ambiguous pair, both holding one.
	"project-directory-unknown":
		"neither or both of the current directory and the directory given to next hold a next.config file; run next from the project directory or set the dir option.",
	// Node's lookup from the project root found no spinetab package
	// (Yarn Plug'n'Play, custom module directories); the searched directories
	// are never named.
	"package-not-installed":
		"the spinetab package is not installed in this project.",
	// Inference fails open for a region it cannot close; a warning in
	// development and production alike, never an error.
	"scan-fallback":
		"a source file could not be read to its end, so every spinetab entry it names counts as imported; check it for an unclosed comment, template, bracket or JSX element, or set the adapters option.",
};

const FILE_CODES: ReadonlySet<BuildMessageCode> = new Set([
	"worker-file-conflict",
	"worker-file-missing",
	"worker-file-no-default",
	"restart-required",
	"adapter-restart-required",
	"worker-file-not-wired",
	"scan-fallback",
]);

export type BuildMessageInput =
	| {
			code: Exclude<
				BuildMessageCode,
				"invalid-credential-origin" | "missing-peer" | "adapter-not-generated"
			>;
			/** Project-relative POSIX path(s); only for the file codes. */
			files?: readonly string[];
	  }
	| { code: "invalid-credential-origin"; index: number }
	| { code: "missing-peer"; kind: string; peer: string }
	| { code: "adapter-not-generated"; entry: string };

export function buildMessage(input: BuildMessageInput): string {
	switch (input.code) {
		case "invalid-credential-origin":
			return `[spinetab] ${input.code}: credentialOrigins[${input.index}] ${CREDENTIAL_ORIGIN_SENTENCE}`;
		case "missing-peer":
			return `[spinetab] ${input.code}: the ${input.kind} adapter needs the ${input.peer} package; install it.`;
		case "adapter-not-generated":
			return `[spinetab] ${input.code}: the app imports spinetab/${input.entry} but the generated worker lacks its adapter; set the adapters option, or add a worker file.`;
		default: {
			const head = `[spinetab] ${input.code}: ${SENTENCES[input.code]}`;
			const files = FILE_CODES.has(input.code) ? (input.files ?? []) : [];
			return files.length === 0 ? head : `${head}\n  ${files.join(", ")}`;
		}
	}
}

export class SpinetabBuildError extends Error {
	readonly code: BuildMessageCode;

	/**
	 * webpack and Rspack print the message alone for such errors. A getter,
	 * so Node's inspection of a thrown error (Vite, Next) does not list it.
	 */
	get hideStack(): true {
		return true;
	}

	constructor(input: BuildMessageInput) {
		super(buildMessage(input));
		this.name = "SpinetabBuildError";
		this.code = input.code;
		// Bundlers print the stack (Vite and Next for a thrown config
		// error, Rolldown folds it into `this.error`, webpack keeps it as
		// details), and V8 frames name the absolute paths of the project and
		// the installed package. The message is the whole report.
		this.stack = `${this.name}: ${this.message}`;
	}
}
