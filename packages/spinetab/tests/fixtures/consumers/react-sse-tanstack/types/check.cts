import spinetab = require("spinetab");
import react = require("spinetab/react");
import sseEntry = require("spinetab/sse");
import streamEntry = require("spinetab/stream");
import tanstack = require("spinetab/tanstack-query");
// @ts-expect-error: runtime entries are ESM-only and have no `require` condition.
import sseRuntime = require("spinetab/sse/runtime");

// `nodenext` CommonJS resolution: the `require` condition and its `.d.cts`.
export const pageEntries = [
	spinetab.createSpinetab,
	react.useSubscription,
	sseEntry.sse,
	streamEntry.stream,
	tanstack.bindQuery,
	sseRuntime,
];
