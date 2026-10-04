<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import type { QueueView } from "./queue-types";
import { watchQueue } from "./watch";

const data = ref<QueueView>();
const error = ref("");
let stop: (() => void) | undefined;
onMounted(() => {
	stop = watchQueue(
		(value) => {
			data.value = value;
			error.value = "";
		},
		(message) => {
			error.value = message;
		},
	);
});
onUnmounted(() => stop?.());
</script>

<template>
	<p v-if="error" role="alert">{{ error }}</p>
	<p v-else-if="data?.open === undefined" role="status">Loading queue…</p>
	<p v-else><output>{{ data.open }}</output> open</p>
</template>
