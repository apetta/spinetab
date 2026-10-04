import { createRuntime } from "spinetab/runtime";
import { adapters } from "./live.adapters";

// Lazily imported local runtime: the same adapters as the worker, loaded only
// when the client selects local mode.
export default () => createRuntime({ adapters });
