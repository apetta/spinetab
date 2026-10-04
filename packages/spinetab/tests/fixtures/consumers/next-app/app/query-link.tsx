"use client";

import Link from "next/link";
import { type ReactNode, useEffect, useState } from "react";

/**
 * A soft-navigation link that keeps the current query string, which carries
 * the probe's `run` identity. The prerendered href has no query; it is added
 * after hydration, so the static prerender is unchanged.
 */
export function QueryLink({
	href,
	testId,
	children,
}: {
	href: string;
	testId: string;
	children: ReactNode;
}) {
	const [search, setSearch] = useState("");
	useEffect(() => setSearch(location.search), []);
	return (
		<Link href={`${href}${search}`} data-testid={testId}>
			{children}
		</Link>
	);
}
