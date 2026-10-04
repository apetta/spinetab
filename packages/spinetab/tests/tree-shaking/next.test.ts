import {
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { type Browser, chromium } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { binPath } from "../package/consumers/run.ts";
import {
	assertFresh,
	browserPackageText,
	fixture,
	packageRoot,
	probes,
	run,
	unused,
} from "./fixture.ts";

let root: string;
let browser: Browser;
let installed = false;
beforeAll(async () => {
	root = await fixture("next");
	const manifest = JSON.parse(
		readFileSync(join(packageRoot, "package.json"), "utf8"),
	);
	const dependencies = Object.fromEntries(
		["next", "react-dom", ...Object.keys(manifest.peerDependencies)].map(
			(name) => [name, manifest.devDependencies[name]],
		),
	);
	const archive = readdirSync(join(root, "pack")).find((name) =>
		name.endsWith(".tgz"),
	);
	writeFileSync(
		join(root, "package.json"),
		JSON.stringify({
			name: "tree-shaking-next",
			private: true,
			type: "module",
			sideEffects: false,
			dependencies: { ...dependencies, spinetab: `file:./pack/${archive}` },
		}),
	);
	const install = await run(
		"pnpm",
		[
			"install",
			"--prefer-offline",
			"--ignore-scripts",
			"--config.auto-install-peers=false",
		],
		{ cwd: root, logFile: join(root, "install.log"), timeoutMs: 120_000 },
	);
	expect(install.code, install.output).toBe(0);
	installed = true;
	assertFresh(root);
	mkdirSync(join(root, "app"));
	writeFileSync(
		join(root, "app/layout.jsx"),
		'export default function Layout({ children }) { return <html lang="en"><body>{children}</body></html>; }',
	);
	browser = await chromium.launch();
});
afterAll(async () => {
	await browser?.close();
	if (installed) assertFresh(root);
});

const cases = {
	unused: {
		source: unused,
		check: "keep",
		result: "tree-shaking-witness",
		forbidden: [],
	},
	summary: probes.summary,
	polling: probes.polling,
	status: {
		source:
			'import { SERVER_STATUS } from "spinetab"; globalThis.keep = SERVER_STATUS;',
		check: "[Object.isFrozen(keep), keep.mode, keep.reason]",
		result: [true, "inactive", "server"],
		forbidden: ["This Spinetab client has been disposed", "needsReconcile"],
	},
} as const;

async function buildApp(
	bundler: string,
	name: string,
	source: string,
	worker = false,
): Promise<string> {
	const distDir = `.next-${bundler}-${name}`;
	rmSync(join(root, "out"), { recursive: true, force: true });
	rmSync(join(root, ".next"), { recursive: true, force: true });
	writeFileSync(
		join(root, "app/page.jsx"),
		worker
			? source
			: `"use client";\n${source}\nexport default function Page() { return <p>Tree shaking probe</p>; }`,
	);
	writeFileSync(
		join(root, "next.config.mjs"),
		`${worker ? 'import { withSpinetab } from "spinetab/next";\n' : ""}const config = { output: "export", distDir: ${JSON.stringify(distDir)}, productionBrowserSourceMaps: true, turbopack: { root: ${JSON.stringify(root)} } };\nexport default ${worker ? 'withSpinetab(config, { adapters: ["polling"] })' : "config"};`,
	);
	const result = await run(
		process.execPath,
		[
			binPath(root, "next"),
			"build",
			...(bundler === "webpack" ? ["--webpack"] : []),
		],
		{
			cwd: root,
			env: { NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1" },
			logFile: join(root, `${bundler}-${name}.log`),
			timeoutMs: 180_000,
		},
	);
	expect(result.code, result.output.slice(-4000)).toBe(0);
	return join(root, distDir);
}

async function serve(out: string) {
	let open = 12;
	const server = createServer((req, res) => {
		const path = new URL(req.url ?? "/", "http://localhost").pathname;
		if (path === "/feed.json") {
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ open }));
			return;
		}
		try {
			const file = path === "/" ? "index.html" : decodeURIComponent(path);
			res.setHeader(
				"Content-Type",
				file.endsWith(".js")
					? "application/javascript"
					: file.endsWith(".css")
						? "text/css"
						: "text/html",
			);
			res.end(readFileSync(join(out, file)));
		} catch {
			res.writeHead(404).end();
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("Missing fixture address");
	return {
		url: `http://127.0.0.1:${address.port}`,
		update: () => {
			open = 13;
		},
		close: () =>
			new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			),
	};
}

describe.each([
	"turbopack",
	"webpack",
])("Next %s production tree shaking", (bundler) => {
	for (const [name, probe] of Object.entries(cases)) {
		it(`${name}: prunes unused code and keeps the selected export usable`, async () => {
			const out = await buildApp(bundler, name, probe.source);
			const text = browserPackageText(
				join(out, "_next/static"),
				join(root, "node_modules/spinetab/dist"),
			);
			if (name === "unused") expect(text.trim()).toBe("");
			else {
				expect(text.length).toBeGreaterThan(0);
				for (const marker of probe.forbidden)
					expect(text).not.toContain(marker);
				if (name === "status") expect(text).toContain("Object.freeze");
			}
			const app = await serve(out);
			const context = await browser.newContext();
			try {
				const page = await context.newPage();
				await page.goto(app.url);
				await page.waitForFunction("globalThis.keep !== undefined");
				expect(await page.evaluate(probe.check)).toEqual(probe.result);
			} finally {
				await context.close();
				await app.close();
			}
		});
	}
	it("keeps the generated worker functional across two tabs", async () => {
		const out = await buildApp(
			bundler,
			"worker",
			'"use client";\nimport { useEffect } from "react"; import { createSpinetab } from "spinetab"; import { polling, pollEvery } from "spinetab/polling"; export default function Page() { useEffect(() => { const client = createSpinetab({ anonymous: true }); const sub = client.subscribe(polling("/feed.json"), (value) => { globalThis.keep = { open: value.open, mode: client.status.get().mode, generation: client.status.get().generation }; }, pollEvery(1000, { whileHidden: true })); return () => { sub.unsubscribe(); client.dispose(); }; }, []); return <p>Worker probe</p>; }',
			true,
		);
		const text = browserPackageText(
			join(out, "_next/static"),
			join(root, "node_modules/spinetab/dist"),
		);
		expect(text).toContain("polling");
		expect(text).not.toContain("graphql-ws");
		const app = await serve(out);
		const context = await browser.newContext();
		try {
			const pages = await Promise.all([context.newPage(), context.newPage()]);
			await Promise.all(pages.map((page) => page.goto(app.url)));
			await Promise.all(
				pages.map((page) =>
					page.waitForFunction(
						'globalThis.keep?.open === 12 && keep.mode === "shared"',
					),
				),
			);
			const generations = await Promise.all(
				pages.map((page) => page.evaluate("keep.generation")),
			);
			expect(generations[0]).toBe(generations[1]);
			await pages[0]?.close();
			app.update();
			await pages[1]?.waitForFunction("keep.open === 13");
		} finally {
			await context.close();
			await app.close();
		}
	});
});
