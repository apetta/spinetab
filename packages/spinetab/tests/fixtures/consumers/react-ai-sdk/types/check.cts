import spinetab = require("spinetab");
import aiSdk = require("spinetab/ai-sdk");
import react = require("spinetab/react");
// @ts-expect-error: runtime entries are ESM-only and have no `require` condition.
import aiRuntime = require("spinetab/ai-sdk/runtime");

// `nodenext` CommonJS resolution: the `require` condition and its `.d.cts`.
export const pageEntries = [
	spinetab.createSpinetab,
	aiSdk.SpinetabChatTransport,
	react.useSpinetabStatus,
	aiRuntime,
];
