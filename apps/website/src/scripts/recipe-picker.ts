for (const root of document.querySelectorAll<HTMLElement>(
	"[data-recipe-picker]",
)) {
	const entries = JSON.parse(root.dataset.recipes!) as [
		string,
		string,
		string,
		string,
	][];
	const consumers = JSON.parse(root.dataset.consumers!) as Record<
		string,
		string
	>;
	const sources = JSON.parse(root.dataset.sources!) as Record<string, string>;
	const contexts = JSON.parse(root.dataset.contexts!) as {
		id: string;
		framework: string;
		renderer: string;
		label: string;
	}[];
	const renderers = JSON.parse(root.dataset.renderers!) as Record<
		string,
		string
	>;
	const framework = root.querySelector<HTMLSelectElement>("[data-framework]")!;
	const renderer = root.querySelector<HTMLSelectElement>("[data-renderer]")!;
	const rendererField = root.querySelector<HTMLElement>(
		"[data-renderer-field]",
	)!;
	const consumer = root.querySelector<HTMLSelectElement>("[data-consumer]");
	const source = root.querySelector<HTMLSelectElement>("[data-source]");
	const link = root.querySelector<HTMLAnchorElement>("[data-recipe-link]")!;
	const message = root.querySelector<HTMLElement>("[data-recipe-message]")!;
	const view = root.closest<HTMLElement>("[data-recipe-view]");
	const content = view?.querySelector<HTMLElement>("[data-recipe-content]");
	let renderedURL = link.getAttribute("href")!;
	let pending: AbortController | undefined;
	root.dataset.enhanced = "";

	function options(
		select: HTMLSelectElement,
		values: string[],
		labels: Record<string, string>,
		previous = select.value,
	) {
		const selected = values.includes(previous) ? previous : values[0];
		select.replaceChildren(
			...values.map(
				(value) => new Option(labels[value], value, false, value === selected),
			),
		);
		return previous !== selected;
	}
	function syncRenderer(preferred = renderer.value) {
		const available = contexts.filter((c) => c.framework === framework.value);
		options(
			renderer,
			available.map((c) => c.renderer),
			renderers,
			preferred,
		);
		rendererField.hidden = available.length < 2;
		return available.find((c) => c.renderer === renderer.value)!;
	}
	function restore(url: string) {
		const entry = entries.find((r) => r[3] === url)!;
		const context = contexts.find((c) => c.id === entry[0])!;
		framework.value = context.framework;
		syncRenderer(context.renderer);
		if (source) source.value = entry[2];
		for (const radio of root.querySelectorAll<HTMLInputElement>(
			"[data-source-radio]",
		))
			radio.checked = radio.value === entry[2];
		link.href = url;
	}
	async function render(url: string, push: boolean) {
		if (!content || !view) return;
		pending?.abort();
		pending = undefined;
		if (url === renderedURL) {
			content.removeAttribute("aria-busy");
			content.inert = false;
			message.textContent = "";
			link.removeAttribute("data-failed");
			return;
		}
		const controller = new AbortController();
		pending = controller;
		content.setAttribute("aria-busy", "true");
		content.inert = true;
		message.textContent = "Loading recipe…";
		link.removeAttribute("data-failed");
		try {
			const response = await fetch(url, { signal: controller.signal });
			if (!response.ok) throw new Error("Recipe unavailable");
			const html = new DOMParser().parseFromString(
				await response.text(),
				"text/html",
			);
			const next = html.querySelector<HTMLElement>("[data-recipe-content]");
			if (
				!next ||
				next.dataset.recipeId !== url.slice("/docs/recipes/".length, -1)
			)
				throw new Error("Unexpected recipe");
			// Keep heading and section nodes: Starlight's TOC observes their positions.
			const bodies = [
				...content.querySelectorAll<HTMLElement>("[data-recipe-part-body]"),
			];
			const nextBodies = [
				...next.querySelectorAll<HTMLElement>("[data-recipe-part-body]"),
			];
			const summary = content.querySelector("[data-recipe-summary]");
			const nextSummary = next.querySelector("[data-recipe-summary]");
			if (bodies.length !== nextBodies.length || !summary || !nextSummary)
				throw new Error("Incomplete recipe");
			if (controller.signal.aborted) return;
			bodies.forEach((body, i) => {
				body.replaceChildren(...nextBodies[i]!.childNodes);
			});
			summary.replaceChildren(...nextSummary.childNodes);
			content.dataset.recipeId = next.dataset.recipeId;
			renderedURL = url;
			restore(url);
			if (push) history.pushState(null, "", url);
			const markdownURL = `${url.replace(/\/$/, "")}.md`;
			document
				.querySelector(".page-actions docs-copy")
				?.setAttribute("data-src", markdownURL);
			document
				.querySelector("[data-page-markdown]")
				?.setAttribute("href", markdownURL);
			document
				.querySelector('link[rel="alternate"][type="text/markdown"]')
				?.setAttribute("href", markdownURL);
			const entry = entries.find((r) => r[3] === url)!;
			message.textContent = `Showing ${contexts.find((c) => c.id === entry[0])!.label} · ${sources[entry[2]]}.`;
		} catch {
			if (controller.signal.aborted) return;
			if (!push) {
				location.assign(location.href);
				return;
			}
			restore(renderedURL);
			link.href = url;
			link.dataset.failed = "";
			message.textContent =
				"Could not load that recipe. Try again or open it directly.";
		} finally {
			if (pending === controller) {
				pending = undefined;
				content.removeAttribute("aria-busy");
				content.inert = false;
			}
		}
	}
	root.addEventListener("change", () => {
		const context = syncRenderer();
		const candidates = entries.filter(([app]) => app === context.id);
		const changedConsumer = consumer
			? options(consumer, [...new Set(candidates.map((r) => r[1]))], consumers)
			: false;
		const consumerValue = consumer?.value ?? root.dataset.consumerLock!;
		const compatible = candidates.filter((r) => r[1] === consumerValue);
		const changedSource = source
			? options(
					source,
					compatible.map((r) => r[2]),
					sources,
				)
			: false;
		const sourceValue =
			source?.value ??
			root.querySelector<HTMLInputElement>("[data-source-radio]:checked")
				?.value ??
			root.dataset.sourceLock!;
		const url = compatible.find((r) => r[2] === sourceValue)![3];
		link.href = url;
		if (content) void render(url, true);
		else
			message.textContent =
				changedConsumer || changedSource
					? `Available recipe: ${consumers[consumerValue]} with ${sources[sourceValue]}.`
					: "";
	});
	if (content && view) {
		window.addEventListener("popstate", () => {
			const url =
				entries.find((r) => r[3] === location.pathname)?.[3] ??
				view.dataset.defaultUrl!;
			restore(url);
			void render(url, false);
		});
	}
}
