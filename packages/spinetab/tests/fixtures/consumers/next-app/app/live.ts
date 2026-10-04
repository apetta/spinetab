import { createSpinetab } from "spinetab";
import { bindClient } from "spinetab/react";

declare global {
	var __credCalls: number | undefined;
}

// Client module (PK:344): imported only by Client Components. One client per
// module instance; construction is inert, so during SSR and prerender it
// starts no worker, connection or timer and never calls the credentials
// callback.
const params =
	typeof location === "undefined" ? null : new URLSearchParams(location.search);
const sharing =
	params?.get("mode") === "local"
		? "off"
		: params?.get("sharing") === "require"
			? "require"
			: "prefer";

// Base for relative endpoints: Next routes have no trailing slash,
// so `document.baseURI` of `/app` would resolve `fx/…` outside the base path.
export const base =
	typeof location === "undefined"
		? undefined
		: new URL(`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/`, location.origin)
				.href;

export const spinetab = createSpinetab({
	sharing,
	...(base ? { baseUrl: base } : {}),
	credentials: () => {
		globalThis.__credCalls = (globalThis.__credCalls ?? 0) + 1;
		return {};
	},
});

// `bindClient`: the hooks with this client applied, no provider.
export const { useSubscription, useSpinetabStatus, useLive } =
	bindClient(spinetab);
