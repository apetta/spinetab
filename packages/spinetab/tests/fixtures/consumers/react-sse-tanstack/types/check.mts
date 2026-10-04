import { expectTypeOf } from "expect-type";
import { createSpinetab, SpinetabError } from "spinetab";
import { useSubscription } from "spinetab/react";
import { sse } from "spinetab/sse";
import { stream } from "spinetab/stream";
import { bindQuery } from "spinetab/tanstack-query";

// `nodenext` ESM resolution: the `import` condition and its `.d.ts`.
expectTypeOf(createSpinetab).toBeFunction();
expectTypeOf(useSubscription).toBeFunction();
expectTypeOf(sse).toBeFunction();
expectTypeOf(stream).toBeFunction();
expectTypeOf(bindQuery).toBeFunction();
expectTypeOf(new SpinetabError("timeout", "x").code).toExtend<string>();
