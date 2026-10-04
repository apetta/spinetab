import spinetab = require("spinetab");
import graphqlWsEntry = require("spinetab/graphql-ws");
import vueEntry = require("spinetab/vue");
// @ts-expect-error: runtime entries are ESM-only and have no `require` condition.
import graphqlWsRuntime = require("spinetab/graphql-ws/runtime");

// `nodenext` CommonJS resolution: the `require` condition and its `.d.cts`.
export const pageEntries = [
	spinetab.createSpinetab,
	graphqlWsEntry.graphqlWs,
	vueEntry.useSubscription,
	graphqlWsRuntime,
];
