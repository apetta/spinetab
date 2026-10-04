<script lang="ts">
import { Chat } from "@ai-sdk/svelte";
import { onMount } from "svelte";
import { chatId, transport } from "./transport";

const chat = new Chat({ id: chatId, transport });
let mounted = $state(false);
const busy = $derived(
	chat.status === "submitted" || chat.status === "streaming",
);
onMount(() => {
	mounted = true;
	const resume = () => chat.resumeStream();
	const unfollow = transport.follow(chatId, resume);
	void resume();
	return () => {
		unfollow();
		void chat.stop();
	};
});
</script>

<section aria-label="Chat">
	{#each chat.messages as message (message.id)}
		<p>
			{message.parts.map((part) => part.type === "text" ? part.text : "").join("")}
		</p>
	{/each}
	{#if chat.error}
		<p role="alert">{chat.error.message}</p>
	{/if}
	<p role="status">{chat.status}</p>
	<button
		type="button"
		disabled={!mounted || busy}
		onclick={() => { void chat.sendMessage({ text: "Explain shared browser connections in one sentence." }); }}
	>
		Send
	</button>
</section>
