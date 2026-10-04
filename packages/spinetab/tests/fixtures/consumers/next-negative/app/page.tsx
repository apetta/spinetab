import { createSpinetab } from "spinetab";
import { useSubscription } from "spinetab/react";
import { websocket } from "spinetab/websocket";

const client = createSpinetab({});
const ticks = websocket({
	url: "ws://127.0.0.1:4500/ws/topics?run=next-negative&scope=negative",
	protocol: "topics",
}).subscription("ticks");

// Deliberately wrong: a Server Component calling a client hook. React must
// reject it during prerender, and no connection may be attempted.
export default function Page() {
	const { status } = useSubscription(client, ticks, { next() {} });
	return <main>{status.connection.state}</main>;
}
