import {
	BRIDGE_VERSION,
	type PageBody,
	type RuntimeAnnounce,
	type RuntimeMessage,
} from "./bridge.ts";
import {
	isUnknownRuntimeType,
	parseAnnounce,
	parseRuntimeMessage,
} from "./bridge-page.ts";

/**
 * The subset of the MessagePort API the page client uses. A SharedWorker
 * port, a local `MessageChannel` port and test wrappers all satisfy it.
 */
export interface PortLike {
	postMessage(message: unknown): void;
	addEventListener(type: string, listener: (event: Event) => void): void;
	removeEventListener(type: string, listener: (event: Event) => void): void;
	start(): void;
	close(): void;
}

export interface AttachmentHandlers {
	message(message: RuntimeMessage): void;
	/** The runtime serving this port announced itself (port-level, unfenced). */
	announce(message: RuntimeAnnounce): void;
	/** Not a valid v1 envelope (other bridge version or not Spinetab). */
	foreign(data: unknown): void;
	/** A well-formed v1 envelope of a type this page does not know: ignored. */
	unknown(data: unknown): void;
	/** Valid envelope addressed to another attachment or generation. */
	stale(message: RuntimeMessage): void;
	messageError(): void;
	close(): void;
}

export interface PageAttachment {
	readonly a: string;
	readonly g: number;
	/** Post an envelope; throws when the body cannot be cloned. */
	post(body: PageBody): void;
	/** Post best effort; false when the body could not be cloned. */
	tryPost(body: PageBody): boolean;
	retire(detach: boolean): void;
	readonly retired: boolean;
}

/**
 * One page↔runtime attachment over a port. Fencing happens here, before any
 * side effect: envelopes whose `a`/`g` differ from this attachment are
 * reported as stale and never reach the client's handlers. The
 * port-level `announce` carries no attachment and is passed through as such.
 */
export function openAttachment(
	port: PortLike,
	a: string,
	g: number,
	handlers: AttachmentHandlers,
): PageAttachment {
	let retired = false;
	const onMessage = (event: Event) => {
		if (retired) return;
		const data = (event as MessageEvent).data;
		const announce = parseAnnounce(data);
		if (announce) {
			handlers.announce(announce);
			return;
		}
		const message = parseRuntimeMessage(data);
		if (!message) {
			if (isUnknownRuntimeType(data)) handlers.unknown(data);
			else handlers.foreign(data);
			return;
		}
		if (message.a !== a || message.g !== g) {
			handlers.stale(message);
			return;
		}
		handlers.message(message);
	};
	const onMessageError = () => {
		if (!retired) handlers.messageError();
	};
	const onClose = () => {
		if (!retired) handlers.close();
	};
	port.addEventListener("message", onMessage);
	port.addEventListener("messageerror", onMessageError);
	port.addEventListener("close", onClose);
	port.start();

	const post = (body: PageBody) => {
		port.postMessage({ v: BRIDGE_VERSION, a, g, ...body });
	};
	return {
		a,
		g,
		get retired() {
			return retired;
		},
		post,
		tryPost(body) {
			if (retired) return false;
			try {
				post(body);
				return true;
			} catch {
				return false;
			}
		},
		retire(detach) {
			if (retired) return;
			if (detach) {
				try {
					post({ t: "detach" });
				} catch {
					// Best effort; the runtime lease covers a lost detach.
				}
			}
			retired = true;
			port.removeEventListener("message", onMessage);
			port.removeEventListener("messageerror", onMessageError);
			port.removeEventListener("close", onClose);
			try {
				port.close();
			} catch {
				// Already closed.
			}
		},
	};
}
