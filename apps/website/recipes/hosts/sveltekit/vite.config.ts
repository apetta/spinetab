import { sveltekit } from "@sveltejs/kit/vite";
import { spinetab } from "spinetab/vite";
import { defineConfig } from "vite";

export default defineConfig({ plugins: [sveltekit(), spinetab()] });
