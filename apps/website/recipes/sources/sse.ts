import { sse } from "spinetab/sse";
import type { Queue, QueueView } from "./queue-types";

export const queueSource = sse<Queue>("/api/queue/events");
export const selectQueue = (queue: Queue): QueueView => queue;
