import { expectTypeOf } from "expect-type";
import { createSpinetab } from "spinetab";
import { SpinetabChatTransport } from "spinetab/ai-sdk";
import { useSpinetabStatus } from "spinetab/react";

// `nodenext` ESM resolution: the `import` condition and its `.d.ts`.
expectTypeOf(createSpinetab).toBeFunction();
expectTypeOf(SpinetabChatTransport).toBeConstructibleWith({
	client: createSpinetab({}),
});
expectTypeOf(useSpinetabStatus).toBeFunction();
