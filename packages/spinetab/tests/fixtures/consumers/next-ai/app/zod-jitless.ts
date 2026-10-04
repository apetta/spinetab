// zod 4 (the AI SDK's schema library) probes `new Function` once to choose its
// JIT object parser. Under a CSP without 'unsafe-eval' the browser reports that
// caught probe as a securitypolicyviolation, although zod falls back; `jitless`
// skips the probe (zod 4.6.5 `v4/core/util.js`, `allowsEval`). An application
// setting for its own dependency, unrelated to Spinetab.
import { config } from "zod";

config({ jitless: true });
