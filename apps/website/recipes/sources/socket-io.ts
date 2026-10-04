import { socketIo } from "spinetab/socket-io";
import type { Queue, QueueView } from "./queue-types";

export const queueSource = socketIo("/", { sharing: "shared" }).subscription<
	[Queue]
>({ event: "queue" });
export const selectQueue = ([queue]: [Queue]): QueueView => queue;
