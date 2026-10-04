import { useChat } from "@ai-sdk/react";
import { useEffect, useState } from "react";
import { chatId, transport } from "./transport";

export default function Recipe() {
	const [mounted, setMounted] = useState(false);
	const { messages, status, error, sendMessage, resumeStream, stop } = useChat({
		id: chatId,
		transport,
	});
	useEffect(() => {
		setMounted(true);
		const unfollow = transport.follow(chatId, resumeStream);
		void resumeStream();
		return () => {
			unfollow();
			void stop();
		};
	}, [resumeStream, stop]);
	const busy = status === "submitted" || status === "streaming";
	return (
		<section aria-label="Chat">
			{messages.map((message) => (
				<p key={message.id}>
					{message.parts
						.map((part) => (part.type === "text" ? part.text : ""))
						.join("")}
				</p>
			))}
			{error && <p role="alert">{error.message}</p>}
			<p role="status">{status}</p>
			<button
				type="button"
				disabled={!mounted || busy}
				onClick={() => {
					void sendMessage({
						text: "Explain shared browser connections in one sentence.",
					});
				}}
			>
				Send
			</button>
		</section>
	);
}
