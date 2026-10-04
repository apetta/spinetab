<script setup lang="ts">
import { skipToken, useQuery, useQueryClient } from "@tanstack/vue-query";
import { onMounted, onUnmounted, ref } from "vue";
import { startQueue } from "./feed";
import type { QueueView } from "./queue-types";

const client = useQueryClient();
const { data } = useQuery<QueueView>({
	queryKey: ["queue"],
	queryFn: skipToken,
});
const error = ref("");
let binding: ReturnType<typeof startQueue> | undefined;
onMounted(() => {
	binding = startQueue(client, (message) => {
		error.value = message;
	});
});
onUnmounted(() => binding?.unsubscribe());
</script>

<template>
	<p v-if="error || data?.problem" role="alert">{{ error || data?.problem }}</p>
	<p v-else-if="data?.open === undefined" role="status">Loading queue…</p>
	<p v-else><output>{{ data.open }}</output> open</p>
</template>
