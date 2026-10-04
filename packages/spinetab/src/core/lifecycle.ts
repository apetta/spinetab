/**
 * Page lifecycle hints. Listeners exist only between
 * `start()` and `dispose()`. Hidden visibility is not a detach; `pagehide`
 * and `freeze` detach best effort (including BFCache entry).
 */
export type LifecycleTarget = "window" | "document";

export interface LifecycleEnv {
	listen(
		target: LifecycleTarget,
		type: string,
		listener: (event: Event) => void,
	): () => void;
	visible(): boolean;
}

export interface LifecycleHandlers {
	hint(reason: string): void;
	detach(reason: string): void;
	visibility(visible: boolean): void;
}

export function watchLifecycle(
	env: LifecycleEnv,
	handlers: LifecycleHandlers,
): () => void {
	const stops = [
		env.listen("window", "pagehide", () => handlers.detach("pagehide")),
		env.listen("document", "freeze", () => handlers.detach("freeze")),
		env.listen("window", "pageshow", (event) => {
			if ((event as PageTransitionEvent).persisted) handlers.hint("pageshow");
		}),
		env.listen("document", "visibilitychange", () => {
			const visible = env.visible();
			handlers.visibility(visible);
			if (visible) handlers.hint("visible");
		}),
		env.listen("window", "online", () => handlers.hint("online")),
		env.listen("document", "resume", () => handlers.hint("resume")),
	];
	return () => {
		for (const stop of stops) stop();
	};
}
