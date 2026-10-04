import { type Clock, randomId } from "./clock.ts";
import { SpinetabError } from "./errors.ts";
import { isPlainObject } from "./plain-object.ts";
import type {
	CredentialRequest,
	CredentialRevision,
	Credentials,
	SerialisedError,
} from "./types.ts";

/** Provider failures take precedence over cached grants; dropping a scope fences its in-flight credential requests. */
export interface CredentialTarget {
	readonly id: string;
	readonly scope: string;
	readonly lastActive: number;
	readonly closed: boolean;
	/** Post a `credentialsRequest`; false when it could not be posted. */
	request(id: string, body: CredentialAsk): boolean;
}

export interface CredentialAsk {
	scope: string;
	revision: CredentialRevision | null;
	reason: CredentialRequest["reason"];
}

export interface CredentialReply {
	ok: boolean;
	credentials?: Credentials;
	error?: SerialisedError;
	revision: CredentialRevision | null;
}

export interface Grant {
	credentials: Credentials;
	revision: CredentialRevision | null;
}

interface ScopeState {
	revision: CredentialRevision | null;
	rejected: Set<string>;
	latest?: Grant;
	flight?: Promise<Grant>;
}

type Outcome = CredentialReply | "timeout" | "retired";

export interface BrokerHost {
	clock: Clock;
	timeoutMs(): number;
	targets(scope: string): CredentialTarget[];
	onRevision(scope: string, restart: boolean): void;
	onStale(): void;
}

/** Maximum tabs tried per credential request. */
export const MAX_CREDENTIAL_TABS = 3;

export function revisionKey(revision: CredentialRevision | null): string {
	return JSON.stringify(revision);
}

/**
 * Negative when `a` is older than `b`. Revisions are non-negative safe
 * integers, so the comparison is numeric only; `isOlder` handles null.
 */
export function compareRevisions(
	a: CredentialRevision,
	b: CredentialRevision,
): number {
	return a - b;
}

/** A null revision is stale once the scope has a numeric revision. */
function isOlder(
	candidate: CredentialRevision | null,
	current: CredentialRevision | null,
): boolean {
	return (
		current !== null &&
		(candidate === null || compareRevisions(candidate, current) < 0)
	);
}

/**
 * Fetch's forbidden request header names (never settable from script), plus
 * `last-event-id`, which only the SSE transport may set. The prefixes
 * `access-control-request-`, `proxy-` and `sec-` are checked in `isHeaderName`.
 * The page's `isCredentials` (validate.ts) applies the same rule; the runtime
 * does not import the page's option guards, so a parity test pins the two.
 */
const FORBIDDEN_HEADERS = new Set([
	"accept-charset",
	"accept-encoding",
	"connection",
	"content-length",
	"cookie",
	"cookie2",
	"date",
	"dnt",
	"expect",
	"host",
	"keep-alive",
	"last-event-id",
	"origin",
	"referer",
	"set-cookie",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
	"via",
]);
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

const isHeaderName = (name: string) => {
	const lower = name.toLowerCase();
	return (
		HEADER_NAME.test(name) &&
		!FORBIDDEN_HEADERS.has(lower) &&
		!lower.startsWith("access-control-request-") &&
		!lower.startsWith("proxy-") &&
		!lower.startsWith("sec-")
	);
};

/**
 * The closed provider shape: `{ headers?, connectionParams?, auth? }`,
 * headers as string values under valid, settable names, the other two as
 * plain records. Replies cross a structured clone, so their contents are data.
 */
export function isProviderShape(value: unknown): boolean {
	if (!isPlainObject(value)) return false;
	for (const [key, item] of Object.entries(value)) {
		if (item === undefined) continue;
		if (!isPlainObject(item)) return false;
		if (key === "headers") {
			for (const [name, header] of Object.entries(item)) {
				if (
					typeof header !== "string" ||
					/[\r\n\0]/.test(header) ||
					!isHeaderName(name)
				) {
					return false;
				}
			}
		} else if (key !== "connectionParams" && key !== "auth") {
			return false;
		}
	}
	return true;
}

export function createBroker(host: BrokerHost) {
	const scopes = new Map<string, ScopeState>();
	const waits = new Map<
		string,
		{ target: CredentialTarget; settle(outcome: Outcome): void }
	>();

	const state = (scope: string): ScopeState => {
		let current = scopes.get(scope);
		if (!current) {
			current = { revision: null, rejected: new Set() };
			scopes.set(scope, current);
		}
		return current;
	};

	const isRejected = (scope: ScopeState, revision: CredentialRevision | null) =>
		scope.rejected.has(revisionKey(revision));

	const usable = (scope: ScopeState, grant: Grant | undefined) =>
		grant !== undefined &&
		!isRejected(scope, grant.revision) &&
		!isOlder(grant.revision, scope.revision);

	function ask(
		target: CredentialTarget,
		body: CredentialAsk,
	): Promise<Outcome> {
		const id = randomId();
		return new Promise<Outcome>((resolve) => {
			const timer = host.clock.setTimeout(() => {
				waits.delete(id);
				resolve("timeout");
			}, host.timeoutMs());
			waits.set(id, {
				target,
				settle: (outcome) => {
					host.clock.clearTimeout(timer);
					waits.delete(id);
					resolve(outcome);
				},
			});
			if (!target.request(id, body)) waits.get(id)?.settle("retired");
		});
	}

	async function fly(
		scopeName: string,
		scope: ScopeState,
		reason: CredentialRequest["reason"],
	): Promise<Grant> {
		let timedOut = false;
		let failed = false;
		const asked = new Set<CredentialTarget>();
		while (asked.size < MAX_CREDENTIAL_TABS) {
			// The next live target not yet asked, chosen now rather than when the
			// request started, so a tab that attached meanwhile is not missed.
			const target = liveTargets(scopeName).find((each) => !asked.has(each));
			if (!target) break;
			asked.add(target);
			// A tab is asked at most twice: once, and once more after a reply
			// for an older revision.
			for (let asks = 1; asks <= 2 && !target.closed; asks += 1) {
				const outcome = await ask(target, {
					scope: scopeName,
					revision: scope.revision,
					reason,
				});
				// Fence: the scope was dropped (its last page retired) while this
				// ask was pending. Nothing from the dropped state may be used or
				// cached; answer from whatever the scope's current state is.
				if (scopes.get(scopeName) !== scope) return request(scopeName, reason);
				if (outcome === "timeout") {
					timedOut = true;
					break;
				}
				if (outcome === "retired") break;
				if (
					!outcome.ok ||
					!outcome.credentials ||
					!isProviderShape(outcome.credentials)
				) {
					// Only tabs that declared a provider are asked, so any
					// unsuccessful reply, "no source" included, is that provider
					// failing, as is a reply outside the closed
					// provider shape.
					failed = true;
					break;
				}
				if (isRejected(scope, outcome.revision)) {
					throw new SpinetabError(
						"credentials-rejected",
						"The page supplied a credential revision the upstream already rejected; supply a newer revision.",
					);
				}
				if (isOlder(outcome.revision, scope.revision)) {
					// Minted for a revision that has since moved on: ask again at
					// the current one; a second older reply is a failure.
					host.onStale();
					if (asks === 2) failed = true;
					continue;
				}
				if (outcome.revision !== null) scope.revision = outcome.revision;
				scope.latest = {
					credentials: outcome.credentials,
					revision: outcome.revision,
				};
				return scope.latest;
			}
		}
		// A provider failure is never masked by the cached grant.
		if (!failed && usable(scope, scope.latest)) return scope.latest as Grant;
		if (timedOut) {
			throw new SpinetabError(
				"credentials-timeout",
				"No page in this scope supplied credentials in time.",
			);
		}
		if (failed) {
			throw new SpinetabError(
				"credentials-failed",
				"No page in this scope supplied credentials: its credentials provider failed.",
			);
		}
		throw new SpinetabError(
			"no-credential-source",
			"No live page in this scope has a credentials provider.",
		);
	}

	/** Live provider tabs of the scope, most recently active first. */
	function liveTargets(scopeName: string): CredentialTarget[] {
		return host
			.targets(scopeName)
			.filter((target) => !target.closed)
			.sort((x, y) => y.lastActive - x.lastActive);
	}

	/** Obtain credentials for a scope (single flight per scope). */
	function request(
		scopeName: string,
		reason: CredentialRequest["reason"],
	): Promise<Grant> {
		const existing = scopes.get(scopeName);
		if (!existing && liveTargets(scopeName).length === 0) {
			// Nothing is known and nobody can answer: do not create state for a
			// scope without pages (a dropped scope stays forgotten).
			return Promise.reject(
				new SpinetabError(
					"no-credential-source",
					"No live page in this scope has a credentials provider.",
				),
			);
		}
		const scope = existing ?? state(scopeName);
		if (
			(reason === "connect" || reason === "reconnect") &&
			scope.latest !== undefined &&
			revisionKey(scope.latest.revision) === revisionKey(scope.revision) &&
			usable(scope, scope.latest)
		) {
			return Promise.resolve(scope.latest);
		}
		if (!scope.flight) {
			scope.flight = fly(scopeName, scope, reason).finally(() => {
				scope.flight = undefined;
			});
		}
		return scope.flight;
	}

	return {
		request,
		/**
		 * Whether a request could end in a grant: a live provider tab to ask,
		 * or a usable cached grant. When false, `request` would end
		 * `no-credential-source` without asking anyone.
		 */
		canSupply(scopeName: string): boolean {
			if (liveTargets(scopeName).length > 0) return true;
			const scope = scopes.get(scopeName);
			return scope !== undefined && usable(scope, scope.latest);
		},
		reply(target: CredentialTarget, id: string, reply: CredentialReply): void {
			const wait = waits.get(id);
			if (!wait || wait.target !== target) {
				host.onStale();
				return;
			}
			wait.settle(reply);
		},
		/** The attachment was retired: its pending asks move on to the next tab. */
		retire(target: CredentialTarget): void {
			for (const wait of [...waits.values()]) {
				if (wait.target === target) wait.settle("retired");
			}
		},
		/**
		 * The upstream rejected this revision: never use it again. A scope the
		 * broker does not know is left alone: nothing was granted there.
		 */
		reject(scopeName: string, revision: CredentialRevision | null): void {
			const scope = scopes.get(scopeName);
			if (!scope) return;
			scope.rejected.add(revisionKey(revision));
			if (scope.latest && isRejected(scope, scope.latest.revision)) {
				scope.latest = undefined;
			}
		},
		/**
		 * A page reported a revision (hello or rotation). Older, equal and
		 * rejected revisions are no-ops; a newer one becomes current.
		 */
		observe(
			scopeName: string,
			revision: CredentialRevision | null,
			restart: boolean,
		): boolean {
			if (revision === null) return false;
			const scope = state(scopeName);
			if (isRejected(scope, revision)) return false;
			if (
				scope.revision !== null &&
				compareRevisions(revision, scope.revision) <= 0
			) {
				return false;
			}
			scope.revision = revision;
			host.onRevision(scopeName, restart);
			return true;
		},
		/**
		 * The scope's last connection closed: forget its cached grant unless a
		 * request is in flight. Its revision and rejections are kept, as
		 * they carry no credential and still fence later replies.
		 */
		forget(scopeName: string): void {
			const scope = scopes.get(scopeName);
			if (scope && !scope.flight) scope.latest = undefined;
		},
		/**
		 * The scope has no live attachments: forget its credentials now, even
		 * during a refresh. Asks still waiting on pages of that scope settle as
		 * retired, and the in-flight request is fenced (see `fly`).
		 */
		drop(scopeName: string): void {
			if (!scopes.delete(scopeName)) return;
			for (const wait of [...waits.values()]) {
				if (wait.target.scope === scopeName) wait.settle("retired");
			}
		},
		revision(scopeName: string): CredentialRevision | null {
			return scopes.get(scopeName)?.revision ?? null;
		},
		pending(): number {
			return waits.size;
		},
	};
}

export type Broker = ReturnType<typeof createBroker>;
