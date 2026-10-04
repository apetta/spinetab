import { createRuntime } from "spinetab/runtime";
import { serveSharedWorker } from "spinetab/worker";
import { adapters } from "./live.adapters.js";

serveSharedWorker(() => createRuntime({ adapters: adapters() }));
