<script setup lang="ts">
import { useChat } from "@ai-sdk/vue";
import { computed, onMounted, onUnmounted, ref } from "vue";
import { chatId, transport } from "./transport";

const { messages, status, error, sendMessage, resumeStream, stop } = useChat({
	id: chatId,
	transport,
});
const mounted = ref(false);
const busy = computed(
	() => status.value === "submitted" || status.value === "streaming",
);
let unfollow: (() => void) | undefined;
onMounted(() => {
	mounted.value = true;
	unfollow = transport.follow(chatId, resumeStream);
	void resumeStream();
});
onUnmounted(() => {
	unfollow?.();
	void stop();
});
</script>

<template>
	<section aria-label="Chat">
		<p v-for="message in messages" :key="message.id">
			{{ message.parts.map((part) => part.type === "text" ? part.text : "").join("") }}
		</p>
		<p v-if="error" role="alert">{{ error.message }}</p>
		<p role="status">{{ status }}</p>
		<button
			type="button"
			:disabled="!mounted || busy"
			@click="sendMessage({ text: 'Explain shared browser connections in one sentence.' })"
		>
			Send
		</button>
	</section>
</template>
