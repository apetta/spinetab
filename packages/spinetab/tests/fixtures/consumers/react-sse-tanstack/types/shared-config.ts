import { sse } from "spinetab/sse";
import { stream } from "spinetab/stream";

// The application's shared configuration module in TypeScript: page code
// imports it type-only, so payload types flow to `subscribe` without pulling
// worker code into the page.
export interface Tick {
	n: number;
	text: string;
}

export interface Line {
	n: number;
	text: string;
}

export const ticks = sse({
	url: "fx/sse/ticks",
	mode: "fetch",
	decoder: "json",
}).subscription<Tick>({ event: "tick" });

export const lines = stream({
	url: "fx/stream/ndjson",
	parser: "ndjson",
	repeatable: true,
}).subscription<Line>();
