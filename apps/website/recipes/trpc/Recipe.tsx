import { useEffect, useState } from "react";
import type { QueueView } from "./queue-types";
import { watchQueue } from "./watch";

export default function Recipe() {
	const [data, setData] = useState<QueueView>();
	const [error, setError] = useState("");
	useEffect(
		() =>
			watchQueue((value) => {
				setData(value);
				setError("");
			}, setError),
		[],
	);
	if (error) return <p role="alert">{error}</p>;
	if (data?.open === undefined) return <p role="status">Loading queue…</p>;
	return (
		<p>
			<output>{data.open}</output> open
		</p>
	);
}
