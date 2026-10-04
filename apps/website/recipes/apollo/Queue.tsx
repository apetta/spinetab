import { useSubscription } from "@apollo/client/react";
import { QUEUE } from "./document";

export default function Queue() {
	const { data, error } = useSubscription(QUEUE);
	if (error) return <p role="alert">{error.message}</p>;
	if (!data) return <p role="status">Loading queue…</p>;
	return (
		<p>
			<output>{data.queue.open}</output> open
		</p>
	);
}
