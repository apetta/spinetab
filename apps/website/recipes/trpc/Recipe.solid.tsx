import { createSignal, onCleanup, onMount } from "solid-js";
import type { QueueView } from "./queue-types";
import { watchQueue } from "./watch";

export default function Recipe() {
	const [data, setData] = createSignal<QueueView>();
	const [error, setError] = createSignal("");
	let stop: (() => void) | undefined;
	onMount(() => {
		stop = watchQueue((value) => {
			setData(value);
			setError("");
		}, setError);
	});
	onCleanup(() => stop?.());
	return (
		<>
			{error() ? (
				<p role="alert">{error()}</p>
			) : data()?.open === undefined ? (
				<p role="status">Loading queue…</p>
			) : (
				<p>
					<output>{data()?.open}</output> open
				</p>
			)}
		</>
	);
}
