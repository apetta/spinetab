// scanner control (consumer cell a). Nothing imports this module. It names
// Spinetab sources only in a comment and in a string, so the plugin must still
// generate a worker that holds the polling adapter alone, with no warning.
// import { socketIo } from "spinetab/socket-io";
export const importExample = 'import { websocket } from "spinetab/websocket";';
