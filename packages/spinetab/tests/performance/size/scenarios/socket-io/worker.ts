import { createRuntime } from "spinetab/runtime";
import { serveSharedWorker } from "spinetab/worker";
import { adapters } from "./adapters";

serveSharedWorker(() => createRuntime({ adapters: adapters() }));
