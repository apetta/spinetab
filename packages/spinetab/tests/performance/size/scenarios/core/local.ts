import { createRuntime } from "spinetab/runtime";
import { adapters } from "./adapters";

// Lazily imported local runtime: requested only in local mode.
export default () => createRuntime({ adapters: adapters() });
