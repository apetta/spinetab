import { reactRouter } from "@react-router/dev/vite";
import { spinetab } from "spinetab/vite";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [reactRouter(), spinetab()],
	optimizeDeps: { entries: ["app/**/*.{ts,tsx}"] },
});
