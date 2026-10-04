import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { startQueue } from "./feed";
import type { QueueView } from "./queue-types";

export default function Queue() {
	const client = useQueryClient();
	const { data } = useQuery<QueueView>({
		queryKey: ["queue"],
		queryFn: skipToken,
	});
	const [error, setError] = useState("");
	useEffect(() => {
		const binding = startQueue(client, setError);
		return () => binding.unsubscribe();
	}, [client]);
	if (error || data?.problem)
		return <p role="alert">{error || data?.problem}</p>;
	if (data?.open === undefined) return <p role="status">Loading queue…</p>;
	return (
		<p>
			<output>{data.open}</output> open
		</p>
	);
}
