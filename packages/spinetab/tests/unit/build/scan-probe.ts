import { readFileSync } from "node:fs";
import { scanSource } from "../../../src/build/scan.ts";

// A subprocess lets the parent terminate a synchronous scanner hang.
const inputs = JSON.parse(readFileSync(0, "utf8")) as Array<{
	code: string;
	path: string;
}>;
process.stdout.write(
	JSON.stringify(
		inputs.map(({ code, path }) => {
			const result = scanSource(code, path);
			return { kinds: [...result.kinds], fallback: result.fallback };
		}),
	),
);
