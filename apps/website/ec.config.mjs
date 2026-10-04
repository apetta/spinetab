/** @type {import("@astrojs/starlight/expressive-code").StarlightExpressiveCodeOptions} */
export default {
	defaultProps: { wrap: true },
	// Starlight applies per-theme frame colours after global overrides.
	customizeTheme(theme) {
		theme.styleOverrides.frames = {
			...theme.styleOverrides.frames,
			editorBackground: "var(--st-code-bg)",
			terminalBackground: "var(--st-code-bg)",
			editorActiveTabBackground: "var(--st-code-bg)",
		};
		return theme;
	},
	styleOverrides: {
		borderColor: "var(--st-code-line)",
		codeBackground: "var(--st-code-bg)",
		borderRadius: "0.6rem",
		borderWidth: "1px",
	},
};
