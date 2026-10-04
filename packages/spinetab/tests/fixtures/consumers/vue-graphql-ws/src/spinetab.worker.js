import { graphqlWsAdapter } from "spinetab/graphql-ws/runtime";
import { defineWorker } from "spinetab/worker";

// The conventional worker filename overrides the generated worker.
export default defineWorker(() => [graphqlWsAdapter()]);
