const hoverPointer = window.matchMedia("(hover: hover) and (pointer: fine)");
let pending: { element: HTMLElement; x: number; y: number } | null = null;
let frame: number | null = null;

function paint() {
	frame = null;
	if (!pending) return;
	const { element, x, y } = pending;
	pending = null;
	element.style.setProperty("--glow-x", `${x}px`);
	element.style.setProperty("--glow-y", `${y}px`);
}

function track(event: PointerEvent) {
	if (!hoverPointer.matches || event.pointerType === "touch") return;
	// Children ignore pointer events, so offsets stay local even on rotated sparks.
	pending = {
		element: event.currentTarget as HTMLElement,
		x: event.offsetX,
		y: event.offsetY,
	};
	if (frame === null) frame = requestAnimationFrame(paint);
}

function leave(event: PointerEvent) {
	if (pending?.element !== event.currentTarget) return;
	if (frame !== null) cancelAnimationFrame(frame);
	frame = null;
	pending = null;
}

for (const element of document.querySelectorAll<HTMLElement>(
	"[data-spotlight]",
)) {
	element.addEventListener("pointerenter", track);
	element.addEventListener("pointermove", track);
	element.addEventListener("pointerleave", leave);
	element.addEventListener("pointercancel", leave);
}
