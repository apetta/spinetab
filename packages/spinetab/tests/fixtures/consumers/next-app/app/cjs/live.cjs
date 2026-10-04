"use client";

const { createSpinetab } = require("spinetab");
const { bindClient } = require("spinetab/react");

const params =
	typeof location === "undefined" ? null : new URLSearchParams(location.search);
const client = createSpinetab({
	sharing: params?.get("mode") === "local" ? "off" : "prefer",
	credentials: () => ({}),
});

module.exports = { client, hooks: bindClient(client) };
