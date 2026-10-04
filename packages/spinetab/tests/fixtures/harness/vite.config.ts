import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Browser test harness. Consumes the built `spinetab` package through its
// package exports (workspace link), never source aliases. Served by the fixture
// server under /harness/ with a strict same-origin CSP.
// Pages: index.html (window.harness for the library suites) and native.html
// (a minimal SharedWorker page WITHOUT Spinetab, used to separate engine
// behaviour from library behaviour). Performance pages (bench.html,
// baseline.html, noop-worker.html) are added here when the performance slice
// created by the performance slice.
export default defineConfig({
	base: "/harness/",
	build: {
		outDir: "dist",
		emptyOutDir: true,
		target: "es2022",
		sourcemap: true,
		minify: false,
		rolldownOptions: {
			input: {
				index: fileURLToPath(new URL("./index.html", import.meta.url)),
				native: fileURLToPath(new URL("./native.html", import.meta.url)),
				bench: fileURLToPath(new URL("./bench.html", import.meta.url)),
				baseline: fileURLToPath(new URL("./baseline.html", import.meta.url)),
				"noop-worker": fileURLToPath(
					new URL("./noop-worker.html", import.meta.url),
				),
			},
		},
	},
	worker: { format: "es" },
});
