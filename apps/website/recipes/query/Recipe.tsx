import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import Queue from "./Queue";

export default function Recipe() {
	const [client] = useState(() => new QueryClient());
	return (
		<QueryClientProvider client={client}>
			<Queue />
		</QueryClientProvider>
	);
}
