import { ApolloProvider } from "@apollo/client/react";
import { useState } from "react";
import { makeClient } from "./client";
import Queue from "./Queue";

export default function Recipe() {
	const [client] = useState(makeClient);
	return (
		<ApolloProvider client={client}>
			<Queue />
		</ApolloProvider>
	);
}
