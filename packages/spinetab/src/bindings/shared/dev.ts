/** Keep warning text inside the NODE_ENV branch so production builds can remove it. */
export function warnUnowned(name: string, framework: "vue" | "solid"): void {
	try {
		if (process.env.NODE_ENV !== "production") {
			console.warn(
				`[spinetab] ${name} was called ${
					framework === "vue"
						? "without an active effect scope"
						: "outside a reactive owner"
				}; call dispose() yourself.`,
			);
		}
	} catch {
		// No `process` global and no bundler replacement.
	}
}
