import type { Experiment } from "./protocol";

export interface FeedCallbacks<T> {
	data(value: T): void;
	received(): void;
	mode(value: string, runtimeId?: string): void;
	connection(connected: boolean): void;
	error(message: string): void;
}

export interface ExampleFeed {
	stop(): void;
}

export type StartFeed<T> = (
	experiment: Experiment,
	callbacks: FeedCallbacks<T>,
) => ExampleFeed;
