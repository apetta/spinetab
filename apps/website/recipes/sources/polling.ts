import { polling } from "spinetab/polling";
import type { Queue, QueueView } from "./queue-types";

export const queueSource = polling<Queue>("/api/queue");
export const selectQueue = (queue: Queue): QueueView => queue;
