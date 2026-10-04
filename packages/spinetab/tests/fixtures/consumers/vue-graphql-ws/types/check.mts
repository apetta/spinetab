import { expectTypeOf } from "expect-type";
import { createSpinetab } from "spinetab";
import { graphqlWs } from "spinetab/graphql-ws";
import { useSubscription } from "spinetab/vue";

// `nodenext` ESM resolution: the `import` condition and its `.d.ts`.
expectTypeOf(createSpinetab).toBeFunction();
expectTypeOf(graphqlWs).toBeFunction();
expectTypeOf(useSubscription).toBeFunction();
