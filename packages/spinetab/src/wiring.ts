// `spinetab/wiring` (page realm): the plugin-absent default. A Spinetab bundler
// plugin redirects this specifier to `spinetab/auto/wiring` in client builds;
// without a plugin the root sees `undefined` and `createSpinetab()` reports
// `not-configured`.
import type { SpinetabWiring } from "./core/types.ts";

export const wiring: SpinetabWiring | undefined = undefined;
