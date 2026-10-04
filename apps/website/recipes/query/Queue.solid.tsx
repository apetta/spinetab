import { createQuery, skipToken, useQueryClient } from "@tanstack/solid-query";
import { createSignal, onCleanup, onMount } from "solid-js";
import { startQueue } from "./feed";
import type { QueueView } from "./queue-types";

export default function Queue() {
	const client = useQueryClient();
	const queue = createQuery<QueueView>(() => ({
		queryKey: ["queue"],
		queryFn: skipToken,
	}));
	const [error, setError] = createSignal("");
	let binding: ReturnType<typeof startQueue> | undefined;
	onMount(() => {
		binding = startQueue(client, setError);
	});
	onCleanup(() => binding?.unsubscribe());
	const problem = () => error() || queue.data?.problem;
	return (
		<>
			{problem() ? (
				<p role="alert">{problem()}</p>
			) : queue.data?.open === undefined ? (
				<p role="status">Loading queue…</p>
			) : (
				<p>
					<output>{queue.data.open}</output> open
				</p>
			)}
		</>
	);
}
