import { describe, expect, it } from "vitest";
import { nextRouteFallbacks } from "../../package/consumers/route-chunks.ts";

describe("Next route fallback accounting", () => {
	it("checks the current route's lazy module while retaining another route as a negative control", () => {
		const chunks: Record<string, string> = {
			"static/chunks/home.js":
				'Promise.all(["static/chunks/runtime-home.js"].map(e=>r.l(e))).then(()=>r.i(1))',
			"static/chunks/activity.js":
				'Promise.all(["static/chunks/runtime-activity.js"].map(e=>r.l(e))).then(()=>r.i(2))',
		};
		const all = [
			"static/chunks/runtime-home.js",
			"static/chunks/runtime-activity.js",
		];
		expect(
			nextRouteFallbacks(
				'<script src="/_next/static/chunks/home.js" async></script>',
				(file) => chunks[file] ?? "",
				all,
			),
		).toEqual([all[0]]);
		expect(
			nextRouteFallbacks(
				'<script src="/base/_next/static/chunks/activity.js" async></script>',
				(file) => chunks[file] ?? "",
				all,
			),
		).toEqual([all[1]]);
	});

	it("does not count a worker-only file or a quoted inline script as a local loader", () => {
		expect(
			nextRouteFallbacks('<script>const example="/_next/static/chunks/home.js"</script>', () => {
				throw Error("not an external initial script");
			}, ["static/chunks/runtime.js"]),
		).toEqual([]);
		expect(
			nextRouteFallbacks(
				'<script src="/_next/static/chunks/home.js"></script>',
				() => 'r.b("turbopack-worker-abc.js", ["static/chunks/worker.js"])',
				["static/chunks/worker.js"],
			),
		).toEqual([]);
	});
});
