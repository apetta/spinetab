import { createSpinetab } from "spinetab";
import { bindClient } from "spinetab/react";

// Client module: imported only by Client Components. The standard recipe: no worker, no local runtime; the plugin supplies both.
const params =
	typeof location === "undefined" ? null : new URLSearchParams(location.search);

export const spinetab = createSpinetab({
	sharing:
		params?.get("mode") === "local"
			? "off"
			: params?.get("sharing") === "require"
				? "require"
				: "prefer",
});

export const { useSubscription, useSpinetabStatus } = bindClient(spinetab);
