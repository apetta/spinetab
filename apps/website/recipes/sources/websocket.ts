import { websocket } from "spinetab/websocket";
import type { Queue, QueueView } from "./queue-types";

export const queueSource = websocket<Queue>("/ws/queue", { decoder: "json" });
export const selectQueue = (queue: Queue): QueueView => queue;
