import { SseParser } from "./sse.ts";
import type {
	Approval,
	Dot,
	Group,
	Message,
	Roster,
	Routine,
	RoutineRun,
	Rule,
	Screen,
	SecretRequest,
	Share,
	Skill,
	TeachSession,
	VosEvent,
	VosState,
} from "./types.ts";

/**
 * A client for the Vos API, shared by the TUI's /vos commands and the desktop
 * app's main process (which holds the key so the window never sees it).
 *
 * Plain fetch, no Node imports: it runs anywhere fetch and streams do.
 *
 * Which vos a call is about travels in the `X-Vos-Dot` header ("main" when
 * absent). A group chat is addressed the same way, as `group:<id>`.
 * Account-wide calls (skills, rules, groups, the roster) send no header.
 */

export const DEFAULT_VOS_URL = "https://vos-api.vosgrau.com";

export class VosError extends Error {
	readonly status: number;
	constructor(message: string, status: number) {
		super(message);
		this.name = "VosError";
		this.status = status;
	}
}

/**
 * The server's origin from whatever the user typed: a bare host gets https,
 * and a trailing slash or `/v1` is dropped, since every path adds its own.
 */
export function normalizeBaseUrl(input: string): string {
	let url = input.trim();
	if (url === "") return DEFAULT_VOS_URL;
	if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `https://${url}`;
	const parsed = new URL(url);
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		throw new Error("The Vos server address must start with https://");
	}
	let path = parsed.pathname.replace(/\/+$/, "");
	if (path.endsWith("/v1")) path = path.slice(0, -3);
	return `${parsed.protocol}//${parsed.host}${path}`;
}

/** The header value naming a group chat's thread. */
export const groupDot = (groupId: string): string => `group:${groupId}`;

/**
 * Reject anything but a path on this API. The desktop's renderer asks the
 * main process for calls by path, so this is what keeps a request (and the
 * key riding on it) on the configured server.
 */
export function checkApiPath(path: string): string {
	if (!path.startsWith("/") || path.startsWith("//") || /[\s\\]|\/\.\.?(\/|$)|^\/v1(\/|$)/.test(path)) {
		throw new Error(`Not a Vos API path: ${path}`);
	}
	return path;
}

export interface VosClientOptions {
	baseUrl: string;
	apiKey: string;
	fetch?: typeof fetch;
	/** Per-request timeout for ordinary calls; streams are not timed. */
	timeoutMs?: number;
}

export interface RequestOptions {
	/** The vos (or `group:<id>`) the call is about. */
	dot?: string;
	body?: unknown;
	signal?: AbortSignal;
}

export type RoutineInput = Pick<Routine, "name" | "instructions" | "trigger"> &
	Partial<Pick<Routine, "skillId" | "enabled">>;
export type SkillInput = Partial<Omit<Skill, "id" | "createdAt" | "updatedAt" | "uses" | "lastUsedAt">>;
export type RuleInput = Omit<Rule, "id" | "createdAt" | "source">;
/** A rule edit; null clears `match` or `vos`. */
export type RulePatch = Partial<Omit<RuleInput, "match" | "vos">> & { match?: string | null; vos?: string | null };
export type DotPatch = Partial<
	Pick<Dot, "name" | "label" | "personality" | "job" | "rules" | "look" | "pinned" | "hidden">
>;

export class VosClient {
	readonly baseUrl: string;
	private readonly apiKey: string;
	private readonly fetchImpl: typeof fetch;
	private readonly timeoutMs: number;

	constructor(options: VosClientOptions) {
		this.baseUrl = normalizeBaseUrl(options.baseUrl);
		this.apiKey = options.apiKey;
		this.fetchImpl = options.fetch ?? fetch;
		this.timeoutMs = options.timeoutMs ?? 20_000;
	}

	private headers(dot?: string, extra?: Record<string, string>): Record<string, string> {
		return {
			authorization: `Bearer ${this.apiKey}`,
			...(dot ? { "x-vos-dot": dot } : {}),
			...extra,
		};
	}

	/** One call to `/v1<path>`; JSON in and out, the server's own error message on failure. */
	async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
		checkApiPath(path);
		const timeout = AbortSignal.timeout(this.timeoutMs);
		const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
		let response: Response;
		try {
			response = await this.fetchImpl(`${this.baseUrl}/v1${path}`, {
				method,
				headers: this.headers(
					options.dot,
					options.body !== undefined ? { "content-type": "application/json" } : undefined,
				),
				body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
				signal,
			});
		} catch (error) {
			// Never echo the request: a secret's value can be in its body.
			const reason = error instanceof Error && error.name === "TimeoutError" ? "timed out" : "could not be reached";
			throw new VosError(`The Vos server ${reason} (${this.baseUrl}).`, 0);
		}
		const text = await response.text();
		let value: unknown;
		try {
			value = text === "" ? undefined : JSON.parse(text);
		} catch {
			value = undefined;
		}
		if (!response.ok) {
			const message =
				value && typeof value === "object" && typeof (value as { error?: unknown }).error === "string"
					? (value as { error: string }).error
					: response.status === 401
						? "The Vos server did not accept the API key."
						: `The Vos server answered ${response.status}.`;
			throw new VosError(message, response.status);
		}
		return value as T;
	}

	// ------------------------------------------------------------ roster and profile

	async roster(): Promise<Roster> {
		const value = await this.request<Partial<Roster>>("GET", "/dots");
		return { dots: value?.dots ?? [], groups: value?.groups ?? [] };
	}
	updateDot(id: string, patch: DotPatch): Promise<Dot> {
		return this.request("PATCH", `/dots/${encodeURIComponent(id)}`, { body: patch });
	}
	duplicateDot(id: string, name?: string): Promise<Dot> {
		return this.request("POST", `/dots/${encodeURIComponent(id)}/duplicate`, { body: name ? { name } : {} });
	}
	deleteDot(id: string): Promise<unknown> {
		return this.request("DELETE", `/dots/${encodeURIComponent(id)}`);
	}
	shareDot(id: string): Promise<Share> {
		return this.request("POST", `/dots/${encodeURIComponent(id)}/share`);
	}
	async shares(): Promise<Share[]> {
		const value = await this.request<Share[] | { shares: Share[] }>("GET", "/shares");
		return Array.isArray(value) ? value : (value?.shares ?? []);
	}
	revokeShare(code: string): Promise<unknown> {
		return this.request("DELETE", `/shares/${encodeURIComponent(code)}`);
	}
	importDot(urlOrCode: string): Promise<Dot> {
		const trimmed = urlOrCode.trim();
		return this.request("POST", "/dots/import", {
			body: trimmed.includes("/") ? { url: trimmed } : { code: trimmed },
		});
	}

	// ------------------------------------------------------------ chat

	state(dot: string): Promise<VosState> {
		return this.request("GET", "/state", { dot });
	}
	messages(dot: string, limit = 50): Promise<Message[]> {
		return this.request("GET", `/messages?limit=${limit}`, { dot });
	}
	async send(dot: string, text: string, clientId?: string): Promise<Message> {
		const value = await this.request<{ message: Message }>("POST", "/messages", {
			dot,
			body: { text, ...(clientId ? { clientId } : {}) },
		});
		return value.message;
	}
	stop(dot: string): Promise<unknown> {
		return this.request("POST", "/stop", { dot });
	}
	answerApproval(dot: string, id: string, decision: "approve" | "deny" | "always"): Promise<Approval> {
		return this.request("POST", `/approvals/${encodeURIComponent(id)}`, { dot, body: { decision } });
	}

	// ------------------------------------------------------------ routines (per vos)

	async routines(dot: string): Promise<Routine[]> {
		const value = await this.request<Routine[] | { routines: Routine[] }>("GET", "/routines", { dot });
		return Array.isArray(value) ? value : (value?.routines ?? []);
	}
	createRoutine(dot: string, routine: RoutineInput): Promise<Routine> {
		return this.request("POST", "/routines", { dot, body: routine });
	}
	updateRoutine(dot: string, id: string, patch: Partial<RoutineInput>): Promise<Routine> {
		return this.request("PATCH", `/routines/${encodeURIComponent(id)}`, { dot, body: patch });
	}
	deleteRoutine(dot: string, id: string): Promise<unknown> {
		return this.request("DELETE", `/routines/${encodeURIComponent(id)}`, { dot });
	}
	testRoutine(dot: string, id: string): Promise<RoutineRun> {
		return this.request("POST", `/routines/${encodeURIComponent(id)}/test`, { dot });
	}
	runRoutine(dot: string, id: string): Promise<RoutineRun> {
		return this.request("POST", `/routines/${encodeURIComponent(id)}/run`, { dot });
	}
	rotateRoutine(dot: string, id: string): Promise<Routine> {
		return this.request("POST", `/routines/${encodeURIComponent(id)}/rotate`, { dot });
	}

	// ------------------------------------------------------------ skills (account-wide)

	async skills(): Promise<Skill[]> {
		const value = await this.request<Skill[] | { skills: Skill[] }>("GET", "/skills");
		return Array.isArray(value) ? value : (value?.skills ?? []);
	}
	createSkill(skill: SkillInput): Promise<Skill> {
		return this.request("POST", "/skills", { body: skill });
	}
	updateSkill(id: string, patch: SkillInput): Promise<Skill> {
		return this.request("PATCH", `/skills/${encodeURIComponent(id)}`, { body: patch });
	}
	deleteSkill(id: string): Promise<unknown> {
		return this.request("DELETE", `/skills/${encodeURIComponent(id)}`);
	}
	/** Runs the skill on safe inputs as a task in this vos. */
	testSkill(dot: string, id: string): Promise<{ taskId: string }> {
		return this.request("POST", `/skills/${encodeURIComponent(id)}/test`, { dot });
	}

	// ------------------------------------------------------------ auto-review rules (account-wide)

	async rules(): Promise<Rule[]> {
		const value = await this.request<Rule[] | { rules: Rule[] }>("GET", "/rules");
		return Array.isArray(value) ? value : (value?.rules ?? []);
	}
	createRule(rule: RuleInput): Promise<Rule> {
		return this.request("POST", "/rules", { body: rule });
	}
	updateRule(id: string, patch: RulePatch): Promise<Rule> {
		return this.request("PATCH", `/rules/${encodeURIComponent(id)}`, { body: patch });
	}
	deleteRule(id: string): Promise<unknown> {
		return this.request("DELETE", `/rules/${encodeURIComponent(id)}`);
	}

	// ------------------------------------------------------------ group chats

	async groups(): Promise<Group[]> {
		const value = await this.request<Group[] | { groups: Group[] }>("GET", "/groups");
		return Array.isArray(value) ? value : (value?.groups ?? []);
	}
	createGroup(name: string, members: string[]): Promise<Group> {
		return this.request("POST", "/groups", { body: { name, members } });
	}
	updateGroup(id: string, patch: { name?: string; members?: string[] }): Promise<Group> {
		return this.request("PATCH", `/groups/${encodeURIComponent(id)}`, { body: patch });
	}
	deleteGroup(id: string): Promise<unknown> {
		return this.request("DELETE", `/groups/${encodeURIComponent(id)}`);
	}

	// ------------------------------------------------------------ teach a task (per vos)

	startTeach(dot: string, goal: string, computerId?: string): Promise<{ id: string; computerId: string }> {
		return this.request("POST", "/teach", { dot, body: { goal, ...(computerId ? { computerId } : {}) } });
	}
	teach(dot: string, id: string): Promise<TeachSession> {
		return this.request("GET", `/teach/${encodeURIComponent(id)}`, { dot });
	}
	stopTeach(dot: string, id: string): Promise<TeachSession> {
		return this.request("POST", `/teach/${encodeURIComponent(id)}/stop`, { dot });
	}
	cancelTeach(dot: string, id: string): Promise<TeachSession> {
		return this.request("POST", `/teach/${encodeURIComponent(id)}/cancel`, { dot });
	}

	// ------------------------------------------------------------ secret requests

	async secrets(dot?: string): Promise<SecretRequest[]> {
		const value = await this.request<SecretRequest[] | { secrets: SecretRequest[] }>("GET", "/secrets", { dot });
		return Array.isArray(value) ? value : (value?.secrets ?? []);
	}
	/** Hands the value over once. It is never kept, logged or put in an error. */
	async answerSecret(dot: string, id: string, value: string): Promise<void> {
		await this.request("POST", `/secrets/${encodeURIComponent(id)}`, { dot, body: { value } });
	}
	declineSecret(dot: string, id: string): Promise<unknown> {
		return this.request("POST", `/secrets/${encodeURIComponent(id)}/decline`, { dot });
	}

	// ------------------------------------------------------------ computers

	async screens(): Promise<Screen[]> {
		const value = await this.request<{ screens: Screen[] }>("GET", "/screens");
		return value?.screens ?? [];
	}

	/** A file the API serves (`/v1/files/<id>`, a replay frame): bytes and type. */
	async file(path: string): Promise<{ contentType: string; bytes: Uint8Array }> {
		const relative = path.replace(/^\/v1(?=\/)/, "");
		checkApiPath(relative);
		const response = await this.fetchImpl(`${this.baseUrl}/v1${relative}`, {
			headers: this.headers(),
			signal: AbortSignal.timeout(this.timeoutMs),
		});
		if (!response.ok) throw new VosError(`The Vos server answered ${response.status}.`, response.status);
		return {
			contentType: response.headers.get("content-type") ?? "application/octet-stream",
			bytes: new Uint8Array(await response.arrayBuffer()),
		};
	}

	/**
	 * Follow one thread's live stream until it ends or `signal` aborts.
	 * Resolves when the server closes the stream; the caller reconnects,
	 * passing back `lastEventId` so nothing in between is lost.
	 */
	async events(
		dot: string,
		onEvent: (event: VosEvent) => void,
		options: { signal?: AbortSignal; lastEventId?: string } = {},
	): Promise<{ lastEventId?: string }> {
		const response = await this.fetchImpl(`${this.baseUrl}/v1/events`, {
			headers: this.headers(dot, {
				accept: "text/event-stream",
				...(options.lastEventId ? { "last-event-id": options.lastEventId } : {}),
			}),
			signal: options.signal,
		});
		if (!response.ok || !response.body) {
			throw new VosError(
				response.status === 401
					? "The Vos server did not accept the API key."
					: `The Vos event stream answered ${response.status}.`,
				response.status,
			);
		}
		const parser = new SseParser();
		parser.lastEventId = options.lastEventId;
		const decoder = new TextDecoder();
		const reader = response.body.getReader();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				for (const e of parser.push(decoder.decode(value, { stream: true }))) {
					let data: unknown = e.data;
					try {
						data = JSON.parse(e.data);
					} catch {
						// Not JSON: hand the text on as it came.
					}
					onEvent({ event: e.event, data, ...(e.id !== undefined ? { id: e.id } : {}) });
				}
			}
		} catch (error) {
			if (!options.signal?.aborted) throw error;
		} finally {
			reader.releaseLock();
		}
		return { lastEventId: parser.lastEventId };
	}
}
