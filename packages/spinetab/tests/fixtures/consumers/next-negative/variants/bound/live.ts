import { createSpinetab } from "spinetab";
import { bindClient } from "spinetab/react";

// The `bound` variant's client module: next-app's shape on the
// standard recipe, imported only by Client Components in a correct app.
export const spinetab = createSpinetab();

// `bindClient`: the hooks with this client applied, no provider.
export const { useSubscription, useSpinetabStatus } = bindClient(spinetab);
