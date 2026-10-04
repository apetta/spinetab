import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("emitted ESM/CommonJS recovery interoperability", () => {
	for (const client of ["esm", "cjs"]) {
		for (const helper of ["esm", "cjs"]) {
			it(`${client} client with ${helper} helper routes failed refreshes to its callback handler`, () => {
				const result = JSON.parse(
					execFileSync(
						process.execPath,
						[
							fileURLToPath(
								new URL("./mixed-recovery-probe.ts", import.meta.url),
							),
							client,
							helper,
							"failure",
						],
						{ encoding: "utf8", timeout: 15_000 },
					),
				) as { callbackErrors: string[]; globalErrors: string[] };
				expect(result.callbackErrors).toEqual(["refresh failed"]);
				expect(result.globalErrors).toEqual([]);
			});
			it(`${client} client with ${helper} AI transport uses the client's endpoint base`, () => {
				const result = JSON.parse(
					execFileSync(
						process.execPath,
						[
							fileURLToPath(
								new URL("./mixed-ai-base-probe.ts", import.meta.url),
							),
							client,
							helper,
						],
						{ encoding: "utf8", timeout: 15_000 },
					),
				) as { api: string };
				expect(result.api).toBe("https://custom.test/app/chat");
			});
			it(`${client} client with ${helper} helper refreshes after the new scope connects`, () => {
				const result = JSON.parse(
					execFileSync(
						process.execPath,
						[
							fileURLToPath(
								new URL("./mixed-recovery-probe.ts", import.meta.url),
							),
							client,
							helper,
						],
						{ encoding: "utf8", timeout: 15_000 },
					),
				) as {
					early: string[];
					refreshes: string[];
					keys: string[];
					pendingKeys: string[];
					symbolsAfterRecovery: string[];
					symbolsAfterDispose: string[];
				};
				expect(result.early).toEqual([]);
				expect(result.refreshes).toEqual(["b"]);
				expect(result.pendingKeys).toEqual(result.keys);
				expect(result.symbolsAfterRecovery).toEqual([]);
				expect(result.symbolsAfterDispose).toEqual([]);
			});
		}
	}
});
