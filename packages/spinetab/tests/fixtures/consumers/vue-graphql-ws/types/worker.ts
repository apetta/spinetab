import { graphqlWsAdapter } from "spinetab/graphql-ws/runtime";
import { createRuntime } from "spinetab/runtime";
import { serveSharedWorker } from "spinetab/worker";

// Worker realm declarations: `WebWorker` lib only, no DOM.
serveSharedWorker(() => createRuntime({ adapters: [graphqlWsAdapter()] }));
