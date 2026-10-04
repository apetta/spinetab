import { polling } from "spinetab/polling";

// Shared configuration module, imported type-only by page code.
export interface PolledValue {
	n: number;
	at: number;
	scope: string | null;
}

export const value = polling({
	url: "fx/poll/value",
	decoder: "json",
}).subscription<PolledValue>();
