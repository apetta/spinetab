import { expectTypeOf } from "expect-type";
import { createSpinetab, resolveEndpoint } from "spinetab";
import { polling } from "spinetab/polling";

// `nodenext` ESM resolution: the `import` condition and its `.d.ts`.
expectTypeOf(createSpinetab).toBeFunction();
expectTypeOf(resolveEndpoint).toBeFunction();
expectTypeOf(polling).toBeFunction();
