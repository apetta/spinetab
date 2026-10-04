import { pollingAdapter as polling } from "spinetab/polling/runtime";

const MIB = 1024 * 1024;

/**
 * Polling adapter for the harness. The extra decoders ignore the fetched body
 * and return values whose structured-clone cost or cloneability differs from
 * their JSON form, so browser tests prove the real bridge's accounting, not only the estimator.
 */
export const pollingAdapter = polling({
	decoders: {
		"backing-buffer": () => new Uint8Array(new ArrayBuffer(MIB), 0, 8),
		"undefined-key": () => ({ ["k".repeat(MIB)]: undefined }),
		"error-cause": () => new Error("small", { cause: new Uint8Array(MIB) }),
		"array-metadata": () => Object.assign([], { metadata: "m".repeat(MIB) }),
		function: () => ({ ok: true, callback() {} }),
		proxy: () => ({ value: new Proxy({ a: 1 }, {}) }),
		"small-view": () => new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
	},
});
