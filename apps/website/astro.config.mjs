import react from "@astrojs/react";
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

export default defineConfig({
	output: "static",
	integrations: [
		react(),
		starlight({
			title: "Spinetab",
			customCss: ["./src/styles/docs.css"],
			sidebar: [
				{ label: "Documentation", link: "/docs/" },
				{ label: "Examples", link: "/examples/" },
			],
		}),
	],
});
