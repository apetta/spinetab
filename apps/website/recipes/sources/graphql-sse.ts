import { parse } from "graphql";
import {
	type GraphqlDocument,
	type GraphqlResult,
	graphqlSse,
} from "spinetab/graphql-sse";
import type { Queue, QueueView } from "./queue-types";

const document: GraphqlDocument<
	{ queue: Queue },
	Record<string, never>
> = parse("subscription Queue { queue { open } }");

export const queueSource = graphqlSse("/graphql/stream").subscription({
	query: document,
});

export function selectQueue(
	result: GraphqlResult<{ queue: Queue }>,
): QueueView {
	return {
		open: result.data?.queue?.open,
		problem:
			result.errors?.map((error) => error.message).join("; ") ||
			(result.data?.queue ? undefined : "The server returned no queue."),
	};
}
