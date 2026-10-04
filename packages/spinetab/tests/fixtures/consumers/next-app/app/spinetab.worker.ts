import { sseAdapter } from "spinetab/sse/runtime";
import { websocketAdapter } from "spinetab/websocket/runtime";
import { defineWorker } from "spinetab/worker";
import { topics } from "./protocol";

// Function-valued topic codecs require an explicit worker file.
export default defineWorker(() => [
	websocketAdapter({ protocols: { topics } }),
	sseAdapter(),
]);
