import { type AnyRuntimeAdapter, defineAdapter } from "spinetab/runtime";

/** Application-defined adapter: the smallest live runtime feature set. */
export function adapters(): AnyRuntimeAdapter[] {
	return [
		defineAdapter<
			Record<string, never>,
			Record<string, never>,
			number,
			{ reset: boolean },
			null
		>({
			kind: "clock",
			version: 1,
			connect() {
				return {
					subscribe(_spec, sink) {
						const timer = setInterval(() => sink.next(Date.now()), 1_000);
						return { unsubscribe: () => clearInterval(timer) };
					},
					command: async () => ({ status: "acknowledged", value: null }),
					dispose() {},
				};
			},
		}),
	];
}
