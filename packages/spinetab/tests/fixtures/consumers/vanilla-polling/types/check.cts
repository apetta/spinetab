import spinetab = require("spinetab");
import pollingEntry = require("spinetab/polling");
// @ts-expect-error: runtime entries are ESM-only and have no `require` condition.
import pollingRuntime = require("spinetab/polling/runtime");

// `nodenext` CommonJS resolution: the `require` condition and its `.d.cts`.
export const pageEntries = [
	spinetab.createSpinetab,
	pollingEntry.polling,
	pollingRuntime,
];
