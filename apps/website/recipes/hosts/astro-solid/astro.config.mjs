import solid from "@astrojs/solid-js";
import { defineConfig } from "astro/config";
import { spinetab } from "spinetab/astro";

export default defineConfig({ integrations: [solid(), spinetab()] });
