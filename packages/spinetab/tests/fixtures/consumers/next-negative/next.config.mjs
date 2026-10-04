import { withSpinetab } from "spinetab/next";

// Negative fixture on the standard recipe: the default
// configuration plus the plugin, kept separate from the positive app so its
// failure can never contaminate that build.
export default withSpinetab({
	reactStrictMode: true,
});
