import { spinetab } from "spinetab/vite";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({ plugins: [solid(), spinetab()] });
