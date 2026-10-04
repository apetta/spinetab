import { createRuntime } from "spinetab/runtime";
import { adapters } from "./live.adapters.js";

// Lazily imported local runtime: loaded only when the client selects local mode.
export default () => createRuntime({ adapters: adapters() });
