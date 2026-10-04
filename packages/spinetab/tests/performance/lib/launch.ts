// Chromium launch arguments shared by the config and the headed background
// spec (which must set launchOptions at file level, replacing the project's).

/** Resolve only loopback fixture hosts; refuse all other names. */
export const HOST_RESOLVER_RULES =
	"--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1";

/** Host restriction plus the optional CDP fallback port. */
export function chromiumArgs(): string[] {
	const cdpPort = Number(process.env.SPINETAB_PERF_CDP_PORT);
	return [
		HOST_RESOLVER_RULES,
		...(Number.isInteger(cdpPort) && cdpPort > 0
			? [`--remote-debugging-port=${cdpPort}`]
			: []),
	];
}
