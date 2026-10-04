import type { SerialisedError } from "../../core/types.ts";

/**
 * One UI message chunk as parsed from the wire (`data:` JSON): any object
 * whose `type` is a string. The runtime reads nothing else, so
 * `spinetab/ai-sdk/runtime` never imports `ai` and its declarations
 * type-check in a `WebWorker`-only realm without Node or DOM types. The page entry specialises the event types below to the AI
 * SDK's discriminated `UIMessageChunk`.
 */
export interface AiChunk {
	type: string;
}

export const AI_ADAPTER_KIND = "ai-sdk";
export const AI_ADAPTER_VERSION = 1;

/** Connection identity: the absolute chat endpoint (`POST` target). */
export interface AiConnectionSpec {
	api: string;
}

export type AiFetchCredentials = "omit" | "same-origin" | "include";

/**
 * - `generation`: the live stream of one explicitly identified generation,
 * identity `{ scope, chatId, generationId }` (scope comes from the client).
 * - `observe`: pre-attached observation of generations started by any tab for
 * `chatId`, delivered from position 0 when the backend echoes the id.
 * - `resume`: one backend resume request (`GET`), identity `{ url, nonce }`.
 * `headers` and `credentials` travel with the request but are not identity.
 */
export type AiSubscriptionSpec =
	| { kind: "generation"; chatId: string; generationId: string }
	| { kind: "observe"; chatId: string }
	| {
			kind: "resume";
			url: string;
			nonce: string;
			headers?: Record<string, string>;
			credentials?: AiFetchCredentials;
	  };

export type AiCommandPayload =
	| {
			type: "start";
			chatId: string;
			generationId: string;
			/** Serialised JSON request body, prepared in the page. */
			body: string;
			headers?: Record<string, string>;
			credentials?: AiFetchCredentials;
	  }
	| {
			type: "stop";
			chatId: string;
			generationId: string;
			url: string;
			headers?: Record<string, string>;
			credentials?: AiFetchCredentials;
	  };

export interface AiCommandResult {
	/** HTTP status of the start or stop response. */
	status: number;
	generationId: string;
}

/**
 * Events on an `observe` subscription: ordered batches of unmodified chunks.
 * `index` is the position of the batch's first chunk; 0 means `start`.
 * `Chunk` is structural on the wire and the AI SDK's union on the page.
 */
export type AiObserveEvent<Chunk extends AiChunk = AiChunk> =
	| {
			type: "chunks";
			generationId: string;
			index: number;
			chunks: Chunk[];
	  }
	| { type: "end"; generationId: string; outcome: "complete" }
	| {
			type: "end";
			generationId: string;
			outcome: "interrupted" | "error";
			error: SerialisedError;
	  };

/**
 * Events on `generation` and `resume` subscriptions: a non-empty, ordered
 * batch of plain chunks exactly as parsed from the wire.
 */
export type AiStreamEvent<Chunk extends AiChunk = AiChunk> = Chunk[];

/**
 * Header names that carry credentials or a resume cursor. Static and
 * per-request `headers` never carry them, on the page or in the worker:
 * credentials come only from the client's `credentials` provider, which the
 * broker, revisions, rejection and the credential audience govern. A guard against accidents, not a security boundary.
 */
const CREDENTIAL_HEADERS = new Set([
	"authorization",
	"proxy-authorization",
	"cookie",
	"x-api-key",
	"x-auth-token",
	"last-event-id",
]);

/** The refusal message for a credential header at `path`, or `undefined`. */
export function credentialHeaderRefusal(
	name: string,
	path: string,
): string | undefined {
	return CREDENTIAL_HEADERS.has(name.toLowerCase())
		? `${path} is refused: credential headers come only from the credentials provider on createSpinetab.`
		: undefined;
}
