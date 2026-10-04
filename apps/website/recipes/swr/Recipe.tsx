import { swrSubscription } from "spinetab/swr";
import useSWRSubscription from "swr/subscription";
import { spinetab } from "./live";
import { queueSource, selectQueue } from "./source";

const subscribe = swrSubscription(spinetab, (_key: "queue") => queueSource, {
	map: selectQueue,
	reconcile: "latest",
});

export default function Recipe() {
	const { data, error } = useSWRSubscription("queue", subscribe);
	if (error || data?.problem)
		return <p role="alert">{error?.message ?? data?.problem}</p>;
	if (data?.open === undefined) return <p role="status">Loading queue…</p>;
	return (
		<p>
			<output>{data.open}</output> open
		</p>
	);
}
