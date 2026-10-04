import { defineConfig } from "astro/config";
import { spinetab } from "spinetab/astro";

// Astro recipe: the Spinetab integration, and
// sourcemaps for the isolation inspection. `astro build` writes dist/.
export default defineConfig({
	integrations: [spinetab()],
	vite: { build: { sourcemap: true } },
});
