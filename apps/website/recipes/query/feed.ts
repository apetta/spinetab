import type { QueryClient } from "@tanstack/query-core";
import { bindQuery } from "spinetab/tanstack-query";
import { spinetab } from "./live";
import { queueSource, selectQueue } from "./source";

export function startQueue(
	queryClient: QueryClient,
	onError: (message: string) => void,
) {
	return bindQuery(spinetab, queueSource, {
		queryClient,
		queryKey: ["queue"],
		map: selectQueue,
		reconcile: "latest",
		onError: (error) => onError(error.message),
		onEvent: () => onError(""),
	});
}
