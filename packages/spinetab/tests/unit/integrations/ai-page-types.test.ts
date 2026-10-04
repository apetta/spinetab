import type { UIMessageChunk } from "ai";
import { describe, expectTypeOf, it } from "vitest";
import type {
	AiChunk,
	AiObserveEvent,
	AiStreamEvent,
} from "../../../src/integrations/ai-sdk/index.ts";
import type {
	AiObserveEvent as RuntimeObserveEvent,
	AiStreamEvent as RuntimeStreamEvent,
} from "../../../src/integrations/ai-sdk/runtime.ts";

/**
 * the page entry keeps the AI SDK's discriminated chunk
 * union on its event types while the runtime entry stays structural (so its
 * declarations never import `ai`). Type-level only; `tsc` over the
 * tests enforces it.
 */
describe("AI SDK event types per entry", () => {
	it("page events carry UIMessageChunk and narrow on type", () => {
		expectTypeOf<AiStreamEvent>().toEqualTypeOf<UIMessageChunk[]>();
		type ObservedChunk = Extract<
			AiObserveEvent,
			{ type: "chunks" }
		>["chunks"][number];
		expectTypeOf<ObservedChunk>().toEqualTypeOf<UIMessageChunk>();
		expectTypeOf<
			Extract<ObservedChunk, { type: "text-delta" }>["delta"]
		>().toEqualTypeOf<string>();
	});

	it("runtime events stay structural", () => {
		expectTypeOf<RuntimeStreamEvent>().toEqualTypeOf<AiChunk[]>();
		type WireChunk = Extract<
			RuntimeObserveEvent,
			{ type: "chunks" }
		>["chunks"][number];
		expectTypeOf<WireChunk>().toEqualTypeOf<AiChunk>();
		// The AI SDK's union satisfies the wire shape, so page aliases are valid.
		expectTypeOf<UIMessageChunk>().toExtend<AiChunk>();
	});
});
