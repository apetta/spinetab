import { bindClient } from "spinetab/solid";
import { spinetab } from "./live";
import { queueSource, selectQueue } from "./source";

const { createLive } = bindClient(spinetab);

export default function Recipe() {
	const queue = createLive(queueSource, {
		map: selectQueue,
		reconcile: "latest",
	});
	const problem = () => queue.error()?.message ?? queue.data()?.problem;
	return (
		<>
			{problem() ? (
				<p role="alert">{problem()}</p>
			) : queue.data()?.open === undefined ? (
				<p role="status">Loading queue…</p>
			) : (
				<p>
					<output>{queue.data()?.open}</output> open
				</p>
			)}
		</>
	);
}
