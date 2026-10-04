import { ChatView } from "./chat-view";

// Server Component: prerendered; the chat transport lives in the client module.
export default function Page() {
	return (
		<main>
			<h1>Spinetab AI SDK on Next.js</h1>
			<ChatView api="api/chat" />
		</main>
	);
}
