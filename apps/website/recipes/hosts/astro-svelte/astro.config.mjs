import svelte from "@astrojs/svelte";
import { defineConfig } from "astro/config";
import { spinetab } from "spinetab/astro";

export default defineConfig({ integrations: [svelte(), spinetab()] });
