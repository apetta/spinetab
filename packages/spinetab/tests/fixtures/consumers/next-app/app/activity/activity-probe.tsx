"use client";

import { Activity, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { sse } from "spinetab/sse";
import { useLive } from "../live";
import { QueryLink } from "../query-link";

/** Record committed values before effects reattach so reveal-time assertions can detect data retained during hiding. */
interface CommitRecord {
	label: string;
	mount: number;
	data: number | undefined;
	/** Probe-local ordinal of the exposed handle; null while none is exposed. */
	handle: number | null;
	path: string;
}

interface ActivityLog {
	commits: CommitRecord[];
	marks: { name: string; at: number }[];
}

declare global {
	interface Window {
		__activity?: ActivityLog;
	}
}

let mounts = 0;
let handleCount = 0;
const handles = new WeakMap<object, number>();

function log(): ActivityLog {
	window.__activity ??= { commits: [], marks: [] };
	return window.__activity;
}

function mark(name: string): void {
	log().marks.push({ name, at: log().commits.length });
}

function handleId(handle: object | null): number | null {
	if (handle === null) return null;
	let id = handles.get(handle);
	if (id === undefined) {
		handleCount += 1;
		id = handleCount;
		handles.set(handle, id);
	}
	return id;
}

/** The page's `run`, read after hydration so the route stays static. */
function useRun(): string | null {
	const [run, setRun] = useState<string | null>(null);
	useEffect(() => {
		setRun(new URLSearchParams(location.search).get("run") ?? "default");
	}, []);
	return run;
}

export function LiveCount({
	label,
	run,
}: {
	label: string;
	run: string | null;
}) {
	const [mount] = useState(() => {
		mounts += 1;
		return mounts;
	});
	const feed = useMemo(
		() =>
			run === null
				? null
				: sse(
						`fx/sse/ticks?run=${encodeURIComponent(run)}&scope=activity&rate=250`,
					).subscription<{ n: number }>({ event: "tick" }),
		[run],
	);
	const live = useLive(feed, {
		initial: 0,
		reduce: (count: number | undefined) => (count ?? 0) + 1,
	});
	const handle = handleId(live.subscription);
	useLayoutEffect(() => {
		log().commits.push({
			label,
			mount,
			data: live.data,
			handle,
			path: location.pathname,
		});
	});
	return <p data-testid={`count-${label}`}>{String(live.data)}</p>;
}

/**
 * `target` sits inside <Activity>; `witness` subscribes to the same feed
 * outside it, so its count shows the events that arrived while `target`
 * was hidden. `bumps` is plain state: a Cache Components back-navigation
 * that preserved the route keeps it.
 */
export function ActivityProbe() {
	const run = useRun();
	const [shown, setShown] = useState(true);
	const [bumps, setBumps] = useState(0);
	return (
		<section>
			<button
				type="button"
				data-testid="toggle"
				onClick={() => {
					mark(shown ? "hide" : "reveal");
					setShown(!shown);
				}}
			>
				{shown ? "Hide" : "Reveal"}
			</button>
			<button
				type="button"
				data-testid="bump"
				onClick={() => setBumps((count) => count + 1)}
			>
				Bump
			</button>
			<p data-testid="bumps">{bumps}</p>
			<Activity mode={shown ? "visible" : "hidden"}>
				<LiveCount label="target" run={run} />
			</Activity>
			<LiveCount label="witness" run={run} />
			<QueryLink href="/activity/other" testId="to-activity-other">
				Other page
			</QueryLink>
		</section>
	);
}

/** The second route: the same feed keeps arriving while /activity is hidden. */
export function OtherProbe() {
	const run = useRun();
	return (
		<section>
			<LiveCount label="other" run={run} />
			<QueryLink href="/activity" testId="to-activity">
				Back to the Activity probe
			</QueryLink>
		</section>
	);
}
