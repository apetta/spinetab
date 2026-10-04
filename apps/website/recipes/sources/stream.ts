import { stream } from "spinetab/stream";
import type { Queue, QueueView } from "./queue-types";

export const queueSource = stream<Queue>("/api/queue/stream", {
	repeatable: true,
});
export const selectQueue = (queue: Queue): QueueView => queue;
