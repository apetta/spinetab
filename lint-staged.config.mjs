export default {
	"*.{js,jsx,ts,tsx,cjs,mjs,cts,mts,json,jsonc,css,html,astro,vue,svelte}":
		"biome check --write --no-errors-on-unmatched --files-ignore-unknown=true",
	"*.{md,mdx,yml,yaml}": "prettier --write --ignore-unknown",
};
