import { bindClient } from "spinetab/react";
import { spinetab } from "./live";
import { queueSource, selectQueue } from "./source";

const { useLive } = bindClient(spinetab);

export default function Recipe() {
	const { data, error } = useLive(queueSource, {
		map: selectQueue,
		reconcile: "latest",
	});
	if (error || data?.problem)
		return <p role="alert">{error?.message ?? data?.problem}</p>;
	if (data?.open === undefined) return <p role="status">Loading queue…</p>;
	return (
		<p>
			<output>{data.open}</output> open
		</p>
	);
}
