<script lang="ts">
import { QueryClient, QueryClientProvider } from "@tanstack/svelte-query";
import Queue from "./Queue.svelte";

const client = new QueryClient();
</script>

<QueryClientProvider {client}><Queue /></QueryClientProvider>
