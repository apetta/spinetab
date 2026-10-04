import vue from "@vitejs/plugin-vue";
import { spinetab } from "spinetab/vite";
import { defineConfig } from "vite";

export default defineConfig({ plugins: [vue(), spinetab()] });
