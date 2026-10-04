import react from "@vitejs/plugin-react";
import { spinetab } from "spinetab/vite";
import { defineConfig } from "vite";

export default defineConfig({ plugins: [react(), spinetab()] });
