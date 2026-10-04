import react from "@astrojs/react";
import { defineConfig } from "astro/config";
import { spinetab } from "spinetab/astro";

export default defineConfig({ integrations: [react(), spinetab()] });
