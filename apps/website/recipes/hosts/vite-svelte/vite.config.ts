import { svelte } from "@sveltejs/vite-plugin-svelte";
import { spinetab } from "spinetab/vite";
import { defineConfig } from "vite";

export default defineConfig({ plugins: [svelte(), spinetab()] });
