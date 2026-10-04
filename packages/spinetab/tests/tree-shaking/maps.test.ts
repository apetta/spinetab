import { encode } from "@jridgewell/sourcemap-codec";
import { expect, it } from "vitest";
import { packageText } from "./fixture.ts";

it("does not count removed source bodies as surviving code", () => {
	expect(
		packageText("keptother", {
			sources: [
				"spinetab/src/core/summary.ts",
				"app/page.jsx",
				"spinetab/src/core/status.ts",
			],
			sourcesContent: ["kept", "other", "Object.freeze({ unused: true })"],
			mappings: encode([
				[
					[0, 0, 0, 0],
					[4, 1, 0, 0],
				],
			]),
		}),
	).toBe("kept");
});

it("stops indexed-map attribution at the next section", () => {
	expect(
		packageText("keptother", {
			sources: [],
			mappings: "",
			sections: [
				{
					offset: { line: 0, column: 0 },
					map: {
						sources: ["spinetab/src/core/summary.ts"],
						mappings: encode([[[0, 0, 0, 0]]]),
					},
				},
				{
					offset: { line: 0, column: 4 },
					map: {
						sources: ["app/page.jsx"],
						mappings: encode([[[0, 0, 0, 0]]]),
					},
				},
			],
		}),
	).toBe("kept");
});
