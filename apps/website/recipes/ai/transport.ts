import { SpinetabChatTransport } from "spinetab/ai-sdk";
import { spinetab } from "./live";

export const transport = new SpinetabChatTransport({
	client: spinetab,
	api: "/api/chat",
});
// Both tabs must use the same authorised chat ID. Remount the view when it changes.
export const chatId = "shared-chat";
