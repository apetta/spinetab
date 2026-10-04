import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import Queue from "./Queue";

export default function Recipe() {
	const client = new QueryClient();
	return (
		<QueryClientProvider client={client}>
			<Queue />
		</QueryClientProvider>
	);
}
