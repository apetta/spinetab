import { initTRPC } from "@trpc/server";

const t = initTRPC.create();

// Server-side contract. Mount this router on your existing tRPC server.
export const appRouter = t.router({
	queue: t.procedure.subscription(async function* ({ signal }) {
		let open = 0;
		while (!signal?.aborted) {
			yield { open: open++ };
			await new Promise<void>((resolve) => {
				const finish = () => {
					clearTimeout(timer);
					signal?.removeEventListener("abort", finish);
					resolve();
				};
				const timer = setTimeout(finish, 1_000);
				signal?.addEventListener("abort", finish, { once: true });
			});
		}
	}),
});
export type AppRouter = typeof appRouter;
