<script setup lang="ts">
import { QueryClient, VUE_QUERY_CLIENT } from "@tanstack/vue-query";
import { onMounted, onUnmounted, provide } from "vue";
import Queue from "./Queue.vue";

const client = new QueryClient();
provide(VUE_QUERY_CLIENT, client);
onMounted(() => client.mount());
onUnmounted(() => client.unmount());
</script>

<template
	><Queue /></template
>
