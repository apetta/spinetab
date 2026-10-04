import { pollingAdapter } from "spinetab/polling/runtime";
import { createRuntime } from "spinetab/runtime";
import { serveSharedWorker } from "spinetab/worker";
import { observeNetwork } from "./network";
import { workerExperiment } from "./protocol";

export function createOrbitRuntime(group: string, epoch: string) {
	const network = observeNetwork("orbit", group, epoch);
	const runtime = createRuntime({
		adapters: [pollingAdapter({ fetch: network.fetch })],
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
	const experiment = workerExperiment("orbit");
	serveSharedWorker(() =>
		createOrbitRuntime(experiment.group, experiment.epoch),
	);
}
