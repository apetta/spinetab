"use client";

import { HttpLink } from "@apollo/client";
import {
	ApolloClient,
	ApolloNextAppProvider,
	InMemoryCache,
} from "@apollo/client-integration-nextjs";
import { spinetabSplit } from "spinetab/apollo";
import { endpoint } from "./endpoint";
import { spinetab } from "./live";
import Queue from "./Queue";

function makeClient() {
	return new ApolloClient({
		cache: new InMemoryCache(),
		link: spinetabSplit(spinetab, endpoint, new HttpLink({ uri: "/graphql" }), {
			reconcile: "latest",
		}),
	});
}

export default function Recipe() {
	return (
		<ApolloNextAppProvider makeClient={makeClient}>
			<Queue />
		</ApolloNextAppProvider>
	);
}
