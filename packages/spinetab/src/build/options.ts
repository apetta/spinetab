// Validation errors name the option path without echoing its value.

import {
	checkCredentialOrigin,
	normaliseCredentialOrigins,
} from "../core/origins.ts";
import {
	compareText,
	isAdapterName,
	type SpinetabAdapterName,
} from "./adapters.ts";
import { SpinetabBuildError } from "./messages.ts";
import { isAnyAbsolute } from "./paths.ts";
import type { SpinetabNextOptions } from "./types.ts";

export interface ValidOptions {
	worker: string | undefined;
	/** `withSpinetab` only: the absolute Next project directory. */
	dir: string | undefined;
	/** `undefined` means infer; an empty array is an explicit empty set. */
	adapters: readonly SpinetabAdapterName[] | undefined;
	credentialOrigins: readonly string[];
	/** Whether `credentialOrigins` was passed at all (for the L2 conflict). */
	hasCredentialOrigins: boolean;
}

const OPTION_KEYS: ReadonlySet<string> = new Set([
	"worker",
	"adapters",
	"credentialOrigins",
]);
const NEXT_OPTION_KEYS: ReadonlySet<string> = new Set([...OPTION_KEYS, "dir"]);

/**
 * `surface` is `next` for `withSpinetab`, the only plugin with `dir`. Every
 * failure is a `SpinetabBuildError` with a fixed sentence and no stack
 * frames.
 */
export function validateOptions(
	input: unknown,
	surface: "plugin" | "next" = "plugin",
): ValidOptions {
	const options = (input ?? {}) as SpinetabNextOptions;
	if (typeof options !== "object" || Array.isArray(options)) {
		throw new SpinetabBuildError({ code: "invalid-options" });
	}
	// Checked first, so a typo such as `adapter:` is reported as such rather
	// than as a missing set. The key is user text and is never echoed.
	const keys = surface === "next" ? NEXT_OPTION_KEYS : OPTION_KEYS;
	if (Object.keys(options).some((key) => !keys.has(key))) {
		throw new SpinetabBuildError({ code: "unknown-option" });
	}
	const { worker, adapters, credentialOrigins, dir } = options;
	if (worker !== undefined && (typeof worker !== "string" || worker === "")) {
		throw new SpinetabBuildError({ code: "invalid-worker-option" });
	}
	if (dir !== undefined && (typeof dir !== "string" || !isAnyAbsolute(dir))) {
		throw new SpinetabBuildError({ code: "invalid-dir-option" });
	}
	let list: SpinetabAdapterName[] | undefined;
	if (adapters !== undefined) {
		if (!Array.isArray(adapters) || !adapters.every(isAdapterName)) {
			throw new SpinetabBuildError({ code: "unknown-adapter" });
		}
		list = [...new Set<SpinetabAdapterName>(adapters)].sort(compareText);
	}
	let origins: readonly string[] = [];
	if (credentialOrigins !== undefined) {
		if (!Array.isArray(credentialOrigins)) {
			throw new SpinetabBuildError({
				code: "invalid-credential-origin",
				index: 0,
			});
		}
		credentialOrigins.forEach((entry: unknown, index) => {
			if (!checkCredentialOrigin(entry).ok) {
				throw new SpinetabBuildError({
					code: "invalid-credential-origin",
					index,
				});
			}
		});
		origins = normaliseCredentialOrigins(credentialOrigins);
	}
	if (
		worker !== undefined &&
		(adapters !== undefined || credentialOrigins !== undefined)
	) {
		throw new SpinetabBuildError({ code: "worker-file-with-options" });
	}
	return {
		worker,
		dir,
		adapters: list,
		credentialOrigins: origins,
		hasCredentialOrigins: credentialOrigins !== undefined,
	};
}
