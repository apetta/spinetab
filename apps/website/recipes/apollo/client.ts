import { ApolloClient, HttpLink, InMemoryCache } from "@apollo/client";
import { spinetabSplit } from "spinetab/apollo";
import { endpoint } from "./endpoint";
import { spinetab } from "./live";

export function makeClient() {
	return new ApolloClient({
		cache: new InMemoryCache(),
		link: spinetabSplit(spinetab, endpoint, new HttpLink({ uri: "/graphql" }), {
			reconcile: "latest",
		}),
	});
}
