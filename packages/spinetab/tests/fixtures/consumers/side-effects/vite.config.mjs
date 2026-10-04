// Plain Vite build with sourcemaps; the module worker keeps Vite's default
// output (no code splitting in the worker graph).
export default {
	build: { sourcemap: true, manifest: true },
};
