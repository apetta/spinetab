// Deployment label. The deployment fixture rebuilds with "v2" so the worker
// script hash changes; subscriptions using the `deployment`
// decoder report which deployment's runtime served them.
export const DEPLOYMENT = "v1";
