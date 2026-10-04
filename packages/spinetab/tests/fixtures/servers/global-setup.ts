import type { TestProject } from "vitest/node";
import { startFixtures } from "./start.ts";

declare module "vitest" {
	interface ProvidedContext {
		/** Two fixture origins on ephemeral ports: primary and second origin. */
		fixtureOrigins: [string, string];
	}
}

// Vitest integration project: real protocol fixtures on ephemeral ports so
// parallel test runs never collide. Tests read `inject("fixtureOrigins")`.
export default async function setup(project: TestProject) {
	const running = await startFixtures([0, 0]);
	const [primary, second] = running.apps;
	if (!primary || !second) throw new Error("fixture servers failed to start");
	project.provide("fixtureOrigins", [primary.origin, second.origin]);
	return async () => {
		await running.close();
	};
}
