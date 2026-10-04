import { websocket } from "spinetab/websocket";
import { useSubscription } from "./live";

// `bound` variant: the harness copies this directory's
// `live.ts` (the L3 client module: `createSpinetab()` plus `bindClient`) beside
// this page. A Server Component importing that client module is wrong: on the
// server `bindClient` is a client reference, so evaluating the module must
// fail the build detectably, and no connection may be attempted.
const ticks = websocket(
	"ws://127.0.0.1:4500/ws/topics?run=next-negative-bound&scope=negative",
	{ protocol: "topics" },
).subscription("ticks");

export default function Page() {
	const { status } = useSubscription(ticks, () => {});
	return <main>{status.connection.state}</main>;
}
