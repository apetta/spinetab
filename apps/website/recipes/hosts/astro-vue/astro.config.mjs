import vue from "@astrojs/vue";
import { defineConfig } from "astro/config";
import { spinetab } from "spinetab/astro";

export default defineConfig({ integrations: [vue(), spinetab()] });
