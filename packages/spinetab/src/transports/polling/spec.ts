import { type HttpReadSpec, normaliseHttpRead } from "../../core/http.ts";
import {
	isPlainObject,
	refuseCredentialCarriers,
	unsupported,
} from "../../core/validate.ts";
import { refuseQueryCarriers } from "../shared/options.ts";

/**
 * The canonical polling connection: a repeatable HTTP read plus the
 * credential-header policy. `authHeaders` stays absent when unset, so unset,
 * `true` and `false` are three identities; it is never filled in.
 */
export type PollingConnection = HttpReadSpec & { authHeaders?: boolean };

/**
 * Shared by the page builder and the runtime adapter (version skew). Static
 * headers and URL query names that carry credentials are refused.
 */
export function normalisePollingRead(
	input: unknown,
	path: string,
	adapter: string,
): PollingConnection {
	const hasFlag = isPlainObject(input) && Object.hasOwn(input, "authHeaders");
	const { authHeaders, ...read } = hasFlag ? input : { authHeaders: undefined };
	const spec = normaliseHttpRead(hasFlag ? read : input, path, adapter);
	refuseCredentialCarriers(spec.headers, `${path}.headers`, adapter);
	refuseQueryCarriers(spec.url, `${path}.url`, adapter);
	if (authHeaders === undefined) return spec;
	if (typeof authHeaders !== "boolean") {
		throw unsupported(`${path}.authHeaders`, "must be a boolean.", adapter);
	}
	return { ...spec, authHeaders };
}
