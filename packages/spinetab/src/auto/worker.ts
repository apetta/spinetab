// Read the worker binding so tree shaking cannot prune the worker entry to an empty module.
import worker from "spinetab/worker-config";

if (typeof worker !== "function") {
	throw new TypeError(
		"spinetab: the worker file must export default defineWorker(…).",
	);
}

export default worker;
