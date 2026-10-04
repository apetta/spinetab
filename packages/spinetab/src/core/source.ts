import type {
	Observer,
	Source,
	SubscriptionObserver,
	SubscriptionRequest,
} from "./types.ts";
import { unsupported } from "./validate.ts";

/** Normalise sources before keying so bindings and integrations share the request identity sent by the client. */

/**
 * A feed becomes its default selection; a request is returned as is. Never
 * validates the result: the caller does. A selection that needs an argument
 * fails in its builder, which names its own path, so the second argument (the
 * caller's name for the source, as `toObserver` takes) is unused here.
 */
export function toRequest<E>(
	source: Source<E>,
	_where: string,
): SubscriptionRequest<E> {
	const candidate = source as { subscription?: unknown } | null | undefined;
	return typeof candidate?.subscription === "function"
		? (source as { subscription(): SubscriptionRequest<E> }).subscription()
		: (source as SubscriptionRequest<E>);
}

/**
 * A function becomes `{ next: fn }`; an observer object is returned as is.
 * Anything without a `next` function throws `unsupported-option` at
 * `<where>.next`, so the client's `where` of `observer` keeps its message.
 */
export function toObserver<E>(
	observer: Observer<E>,
	where: string,
): SubscriptionObserver<E> {
	if (typeof observer === "function") return { next: observer };
	const candidate = observer as { next?: unknown } | null | undefined;
	if (typeof candidate?.next === "function") return observer;
	throw unsupported(`${where}.next`, "must be a function.");
}
