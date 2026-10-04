import { defineWorker } from "spinetab/worker";
import { adapters } from "./adapters";

// the application's worker file, found by convention;
// the same clock adapter as the L1 `core` scenario.
export default defineWorker(() => adapters());
