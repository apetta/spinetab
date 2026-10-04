import { graphqlWsAdapter } from "spinetab/graphql-ws/runtime";
import { createRuntime } from "spinetab/runtime";
import { serveSharedWorker } from "spinetab/worker";
import { observeNetwork } from "./network";
import { workerExperiment } from "./protocol";

export function createTransitRuntime(group: string, epoch: string) {
	const network = observeNetwork("transit", group, epoch);
	const runtime = createRuntime({
		adapters: [graphqlWsAdapter({ webSocketImpl: network.WebSocket })],
		limits: { idleCloseMs: 1 },
	});
	network.identify(runtime.id);
	return {
		id: runtime.id,
		accept: runtime.accept,
		dispose() {
			runtime.dispose();
			network.dispose();
		},
	};
}

if (
	typeof document === "undefined" &&
	"SharedWorkerGlobalScope" in globalThis
) {
	const experiment = workerExperiment("transit");
	serveSharedWorker(() =>
		createTransitRuntime(experiment.group, experiment.epoch),
	);
}
