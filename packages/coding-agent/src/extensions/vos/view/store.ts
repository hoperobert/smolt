import { useSyncExternalStore } from "react";
import { readComputerState } from "../client.ts";
import type {
	Approval,
	ApprovalRemember,
	ComputerState,
	InboxCount,
	InboxItem,
	MemoryNote,
	Message,
	Plugin,
	Roster,
	Routine,
	Rule,
	Screen,
	SecretRequest,
	Share,
	Skill,
	Task,
	TeachSession,
	VosCallResult,
	VosConnection,
	VosPairing,
	VosState,
	VosStatus,
} from "../types.ts";
import { bridge } from "./bridge.ts";

/**
 * The Vos view's state.
 *
 * Everything reaches Vos through the extension's Node side (bridge.request),
 * which holds the API key: this page only ever sees answers, never the key.
 * Live updates arrive as events the Node side pushes (`event`, `stream`,
 * `frame`, `live`, `pair`, `connection`, `inbox`).
 *
 * One plain object and a version counter: components read it through
 * `useVos()`, and every change calls `bump()`.
 */

export type VosTab =
	| "chat"
	| "routines"
	| "memory"
	| "skills"
	| "teach"
	| "rules"
	| "connectors"
	| "computers"
	| "profile";

/** The main pane: a thread (with its tabs) or the inbox across all vos. */
export type VosPage = "thread" | "inbox";

export interface ThreadState {
	messages: Message[];
	tasks: Map<string, Task>;
	approvals: Map<string, Approval>;
	status: VosStatus;
	loaded: boolean;
	stream: "connecting" | "live" | "error" | "idle";
	error?: string;
}

export interface LiveFrame {
	image: string;
	w: number;
	h: number;
	at: number;
}

/** A pairing on the connect screen: its QR text (which carries the pairing code, not a key) and where it is. */
export interface PairState {
	id?: string;
	qr?: string;
	short?: string;
	expiresAt?: string;
	name?: string;
	state: "starting" | "waiting" | "approved" | "denied" | "expired" | "error";
	error?: string;
}

export interface TeachState extends TeachSession {
	dot: string;
	error?: string;
}

/** A confirmation or a one-line question, drawn over the view. */
export type DialogState =
	| {
			kind: "confirm";
			title: string;
			message?: string;
			actionLabel?: string;
			destructive?: boolean;
			resolve: (ok: boolean) => void;
	  }
	| {
			kind: "input";
			title: string;
			message?: string;
			placeholder?: string;
			initial?: string;
			actionLabel?: string;
			multiline?: boolean;
			resolve: (value: string | null) => void;
	  };

interface VosStore {
	connection: VosConnection | null;
	roster: Roster | null;
	rosterError: string | null;
	page: VosPage;
	/** The open thread: a vos id, or `group:<id>`. */
	selected: string | null;
	tab: VosTab;
	threads: Map<string, ThreadState>;
	skills: Skill[] | null;
	rules: Rule[] | null;
	/** Routines by vos id. */
	routines: Map<string, Routine[]>;
	/** Memory notes by vos id. */
	memory: Map<string, MemoryNote[]>;
	/** Connectors by vos id. */
	plugins: Map<string, Plugin[]>;
	/** Whether the user drives a vos's computer, and a handoff waiting for them, by vos id. */
	computers: Map<string, ComputerState>;
	inbox: InboxItem[] | null;
	inboxCount: InboxCount | null;
	/** Show done and dismissed items too. */
	inboxAll: boolean;
	secrets: SecretRequest[];
	shares: Share[] | null;
	screens: Screen[] | null;
	images: Map<string, string>;
	frames: Map<string, LiveFrame>;
	live: Map<string, "open" | "closed" | "unavailable">;
	teach: TeachState | null;
	/** A failure to show at the top of the view, until dismissed. */
	notice: string | null;
	/** Pairing with the phone, while the connect screen shows one. */
	pair: PairState | null;
	hiddenOpen: boolean;
	dialog: DialogState | null;
}

export const vos: VosStore = {
	connection: null,
	roster: null,
	rosterError: null,
	page: "thread",
	selected: null,
	tab: "chat",
	threads: new Map(),
	skills: null,
	rules: null,
	routines: new Map(),
	memory: new Map(),
	plugins: new Map(),
	computers: new Map(),
	inbox: null,
	inboxCount: null,
	inboxAll: false,
	secrets: [],
	shares: null,
	screens: null,
	images: new Map(),
	frames: new Map(),
	live: new Map(),
	teach: null,
	notice: null,
	pair: null,
	hiddenOpen: false,
	dialog: null,
};

const listeners = new Set<() => void>();
let version = 0;

export function bumpVos(): void {
	version += 1;
	for (const listener of listeners) listener();
}

export function useVos(): VosStore {
	useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		() => version,
	);
	return vos;
}

/** A thread's state, made on first use. */
export function threadOf(dot: string): ThreadState {
	let thread = vos.threads.get(dot);
	if (!thread) {
		thread = {
			messages: [],
			tasks: new Map(),
			approvals: new Map(),
			status: { mood: "idle", statusLine: "" },
			loaded: false,
			stream: "idle",
		};
		vos.threads.set(dot, thread);
	}
	return thread;
}

export const isGroupThread = (dot: string | null): boolean => !!dot && dot.startsWith("group:");

/** The vos a thread's per-vos pages (routines, teach, profile) are about: a group's lead. */
export function vosOfThread(dot: string | null): string | null {
	if (!dot) return null;
	if (!isGroupThread(dot)) return dot;
	const group = vos.roster?.groups.find((g) => `group:${g.id}` === dot);
	return group?.members[0] ?? null;
}

export function nameOf(id: string): string {
	return vos.roster?.dots.find((d) => d.id === id)?.name ?? id;
}

// ---------------------------------------------------------------- dialogs

export function requestConfirm(
	options: Omit<Extract<DialogState, { kind: "confirm" }>, "kind" | "resolve">,
): Promise<boolean> {
	return new Promise((resolve) => {
		vos.dialog = { kind: "confirm", ...options, resolve };
		bumpVos();
	});
}

export function requestInput(
	options: Omit<Extract<DialogState, { kind: "input" }>, "kind" | "resolve">,
): Promise<string | null> {
	return new Promise((resolve) => {
		vos.dialog = { kind: "input", ...options, resolve };
		bumpVos();
	});
}

export function closeDialog(): void {
	vos.dialog = null;
	bumpVos();
}

// ---------------------------------------------------------------- calls

export class VosCallError extends Error {
	readonly status: number;
	constructor(message: string, status: number) {
		super(message);
		this.status = status;
	}
}

/** One Vos API call through the extension; throws with the server's message. */
export async function vosCall<T>(method: string, path: string, body?: unknown, dot?: string): Promise<T> {
	const result = (await bridge.request("call", { method, path, body, dot })) as VosCallResult;
	if (!result.ok) throw new VosCallError(result.error, result.status);
	return result.value as T;
}

/** Run an action; a failure lands in the view's notice instead of vanishing. */
export async function attempt<T>(action: () => Promise<T>): Promise<T | undefined> {
	try {
		return await action();
	} catch (error) {
		vos.notice = error instanceof Error ? error.message : String(error);
		bumpVos();
		return undefined;
	}
}

export function dismissNotice(): void {
	vos.notice = null;
	bumpVos();
}

const asList = <T>(value: unknown, key: string): T[] =>
	Array.isArray(value) ? (value as T[]) : (((value as Record<string, unknown> | null)?.[key] as T[]) ?? []);

const upsert = <T extends { id: string }>(list: T[], item: T): T[] => {
	const index = list.findIndex((x) => x.id === item.id);
	if (index === -1) return [...list, item];
	const next = [...list];
	next[index] = item;
	return next;
};

// ---------------------------------------------------------------- connection

/** The settings row only shows the connection: it loads nothing else and follows no thread. */
let connectionOnly = false;

export async function refreshConnection(): Promise<void> {
	try {
		vos.connection = (await bridge.request("status")) as VosConnection;
	} catch (error) {
		vos.connection = {
			connected: false,
			url: "",
			keySource: "none",
			canPersist: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
	bumpVos();
	if (vos.connection?.connected && !connectionOnly) {
		await refreshRoster();
		void loadInbox();
		if (!vos.selected) openVos();
	}
}

export async function connectVos(url: string, key: string): Promise<string | null> {
	const status = (await bridge.request("connect", { url, key })) as VosConnection;
	vos.connection = status;
	bumpVos();
	if (!status.connected || status.error) return status.error ?? "Could not connect.";
	resetData();
	await refreshRoster();
	openVos();
	return null;
}

/** Ask the server for a pairing; the extension polls it and says how it went (`pair`). */
export async function startPair(url: string): Promise<void> {
	vos.pair = { state: "starting" };
	bumpVos();
	const result = (await bridge.request("pairStart", { url }).catch((error: unknown) => ({
		ok: false,
		error: error instanceof Error ? error.message : String(error),
	}))) as { ok: true; value: VosPairing } | { ok: false; error: string };
	vos.pair = result.ok ? { ...result.value, state: "waiting" } : { state: "error", error: result.error };
	bumpVos();
}

export function cancelPair(): void {
	if (vos.pair?.state === "waiting" || vos.pair?.state === "starting")
		void bridge.request("pairCancel").catch(() => {});
	vos.pair = null;
	bumpVos();
}

export async function disconnectVos(): Promise<void> {
	vos.connection = (await bridge.request("disconnect")) as VosConnection;
	resetData();
	bumpVos();
}

function resetData(): void {
	vos.roster = null;
	vos.selected = null;
	vos.page = "thread";
	vos.threads.clear();
	vos.skills = null;
	vos.rules = null;
	vos.routines.clear();
	vos.memory.clear();
	vos.plugins.clear();
	vos.computers.clear();
	vos.inbox = null;
	vos.inboxCount = null;
	vos.secrets = [];
	vos.shares = null;
	vos.screens = null;
	vos.images.clear();
	vos.teach = null;
}

export async function refreshRoster(): Promise<void> {
	if (!vos.connection?.connected) return;
	try {
		const value = await vosCall<Partial<Roster>>("GET", "/dots");
		vos.roster = { dots: value?.dots ?? [], groups: value?.groups ?? [] };
		vos.rosterError = null;
		// The open thread was read on opening; the server's count lags until the next /state.
		const open = vos.selected ? vos.roster.dots.find((d) => d.id === vos.selected) : undefined;
		if (open) open.unread = 0;
		const group = vos.roster.groups.find((g) => `group:${g.id}` === vos.selected);
		if (group) group.unread = 0;
	} catch (error) {
		vos.rosterError = error instanceof Error ? error.message : String(error);
	}
	bumpVos();
}

let rosterTimer: ReturnType<typeof setTimeout> | null = null;
function refreshRosterSoon(): void {
	if (rosterTimer) return;
	rosterTimer = setTimeout(() => {
		rosterTimer = null;
		void refreshRoster();
	}, 400);
}

// ---------------------------------------------------------------- navigation

let leaseTimer: ReturnType<typeof setInterval> | null = null;

/** Show a thread (or the first vos), on a tab when one is named. */
export function openVos(dot?: string, tab?: VosTab): void {
	vos.page = "thread";
	if (tab) vos.tab = tab;
	if (dot) void selectThread(dot);
	else if (vos.selected) void loadTab();
	else if (vos.roster) {
		const first = vos.roster.dots.find((d) => !d.hidden);
		if (first) void selectThread(first.id);
	}
	bumpVos();
}

export function openInbox(): void {
	vos.page = "inbox";
	vos.notice = null;
	bumpVos();
	void loadInbox();
	void bridge.request("call", { method: "POST", path: "/inbox/read", body: {} }).catch(() => {});
}

export function setTab(tab: VosTab): void {
	vos.tab = tab;
	vos.page = "thread";
	// A failure belongs to the page it happened on.
	vos.notice = null;
	bumpVos();
	void loadTab();
}

export async function selectThread(dot: string): Promise<void> {
	const previous = vos.selected;
	vos.selected = dot;
	vos.page = "thread";
	if (previous !== dot) vos.notice = null;
	// A group has no routines, teach, memory or connectors of its own.
	if (isGroupThread(dot) && ["teach", "routines", "memory", "connectors"].includes(vos.tab)) vos.tab = "chat";
	bumpVos();
	if (previous && previous !== dot) void bridge.request("unwatch", { dot: previous }).catch(() => {});
	void bridge.request("watch", { dot }).catch(() => {});
	if (leaseTimer) clearInterval(leaseTimer);
	leaseTimer = setInterval(() => {
		if (vos.selected) void bridge.request("watch", { dot: vos.selected }).catch(() => {});
	}, 20_000);
	await loadThread(dot);
	void loadTab();
	if (!isGroupThread(dot)) void loadComputer(dot);
}

/** Load the open thread: messages, tasks, approvals, status. Opening it reads it. */
export async function loadThread(dot: string): Promise<void> {
	const thread = threadOf(dot);
	try {
		const state = await vosCall<VosState>("GET", "/state", undefined, dot);
		thread.messages = [...(state.messages ?? [])].sort((a, b) => a.date.localeCompare(b.date));
		thread.tasks = new Map((state.tasks ?? []).map((t) => [t.id, t]));
		thread.approvals = new Map((state.approvals ?? []).map((a) => [a.id, a]));
		thread.status = state.status ?? thread.status;
		thread.loaded = true;
		// Newer servers send the thread's pending secret requests with its state.
		if (Array.isArray(state.secrets)) {
			const ids = new Set(state.secrets.map((s) => s.id));
			vos.secrets = [...vos.secrets.filter((s) => !ids.has(s.id)), ...state.secrets];
		}
		thread.error = undefined;
		const row = vos.roster?.dots.find((d) => d.id === dot);
		if (row) row.unread = 0;
		const group = vos.roster?.groups.find((g) => `group:${g.id}` === dot);
		if (group) group.unread = 0;
	} catch (error) {
		thread.error = error instanceof Error ? error.message : String(error);
		thread.loaded = true;
	}
	bumpVos();
	void loadSecrets();
}

/** What the open page needs, loaded when it is first shown. */
async function loadTab(): Promise<void> {
	const dot = vosOfThread(vos.selected);
	switch (vos.tab) {
		case "chat":
			if (!vos.skills) void loadSkills();
			return;
		case "routines":
			if (dot) await loadRoutines(dot);
			if (!vos.skills) void loadSkills();
			return;
		case "memory":
			if (dot) await loadMemory(dot);
			return;
		case "skills":
			await loadSkills();
			return;
		case "rules":
			await loadRules();
			return;
		case "connectors":
			if (dot) await loadPlugins(dot);
			return;
		case "computers":
			await loadScreens();
			return;
		case "profile":
			await loadShares();
			return;
		default:
			return;
	}
}

// ---------------------------------------------------------------- live events

interface Incoming {
	dot: string;
	event: string;
	data: unknown;
}

/** Apply one event from a thread's stream. Exported for tests. */
export function applyEvent(incoming: Incoming): void {
	const { dot, data } = incoming;
	// A removal can come as "<kind>.deleted" or as the kind's event with {id, deleted: true}.
	const removal = incoming.event.endsWith(".deleted") && !incoming.event.startsWith("memory.");
	const event = removal ? incoming.event.slice(0, -".deleted".length) : incoming.event;
	const doc = { ...((data ?? {}) as { id?: string; deleted?: boolean; vos?: string }) };
	if (removal) doc.deleted = true;
	const thread = vos.threads.get(dot);
	switch (event) {
		case "message.created":
		case "message.updated": {
			if (!thread || !doc.id) break;
			thread.messages = upsert(thread.messages, data as Message).sort((a, b) => a.date.localeCompare(b.date));
			if (dot !== vos.selected) refreshRosterSoon();
			break;
		}
		case "task.created":
		case "task.updated":
			if (thread && doc.id) thread.tasks.set(doc.id, data as Task);
			break;
		case "approval.requested":
		case "approval.resolved":
			if (thread && doc.id) thread.approvals.set(doc.id, data as Approval);
			if (!isGroupThread(dot)) void loadComputer(dot);
			break;
		case "status":
			if (thread) thread.status = data as VosStatus;
			{
				const row = vos.roster?.dots.find((d) => d.id === dot);
				if (row) row.status = data as VosStatus;
			}
			break;
		case "resync":
			void loadThread(dot);
			break;
		case "routine": {
			const owner = doc.vos ?? vosOfThread(dot);
			if (!owner || !doc.id) break;
			const list = vos.routines.get(owner) ?? [];
			vos.routines.set(owner, doc.deleted ? list.filter((r) => r.id !== doc.id) : upsert(list, data as Routine));
			break;
		}
		case "memory.added":
		case "memory.created":
		case "memory.updated":
		case "memory.deleted": {
			const note = ((data as { note?: MemoryNote } | null)?.note ?? data) as MemoryNote & { deleted?: boolean };
			const owner = vosOfThread(dot);
			if (!owner || !note?.id) break;
			const list = vos.memory.get(owner);
			if (!list) break;
			vos.memory.set(
				owner,
				event === "memory.deleted" || note.deleted ? list.filter((n) => n.id !== note.id) : upsert(list, note),
			);
			break;
		}
		case "inbox.added":
		case "inbox.updated": {
			const item = ((data as { item?: InboxItem } | null)?.item ?? data) as InboxItem;
			if (item?.id && vos.inbox) vos.inbox = upsert(vos.inbox, item);
			break;
		}
		case "skill":
			if (vos.skills && doc.id) {
				vos.skills = doc.deleted ? vos.skills.filter((s) => s.id !== doc.id) : upsert(vos.skills, data as Skill);
			}
			break;
		case "rule":
			if (vos.rules && doc.id) {
				vos.rules = doc.deleted ? vos.rules.filter((r) => r.id !== doc.id) : upsert(vos.rules, data as Rule);
			}
			break;
		case "secret": {
			const secret = data as SecretRequest;
			if (!secret.id) break;
			vos.secrets =
				secret.state === "pending" && !doc.deleted
					? upsert(vos.secrets, secret)
					: vos.secrets.filter((s) => s.id !== secret.id);
			break;
		}
		case "teach":
			if (vos.teach && doc.id === vos.teach.id) {
				vos.teach = { ...vos.teach, ...(data as TeachSession), dot: vos.teach.dot };
				if (vos.teach.state === "done") void loadSkills();
			}
			break;
		case "computer":
			if (!isGroupThread(dot)) void loadComputer(dot);
			break;
		case "group":
		case "dot":
			refreshRosterSoon();
			break;
		default:
			return;
	}
	bumpVos();
}

let wired = false;

/** Hook the extension's events once, at boot; `connectionOnly` for the settings row. */
export function bootVos(options: { connectionOnly?: boolean } = {}): void {
	if (wired) return;
	wired = true;
	connectionOnly = options.connectionOnly === true;
	if (connectionOnly) {
		bridge.on("connection", (raw) => {
			vos.connection = raw as VosConnection;
			bumpVos();
		});
		void refreshConnection();
		return;
	}
	bridge.on("event", (event) => applyEvent(event as Incoming));
	bridge.on("stream", (raw) => {
		const { dot, state, error } = raw as { dot: string; state: ThreadState["stream"]; error?: string };
		const thread = threadOf(dot);
		thread.stream = state;
		thread.error = state === "error" ? error : undefined;
		bumpVos();
	});
	bridge.on("frame", (raw) => {
		const { dot, image, w, h } = raw as { dot: string; image: string; w: number; h: number };
		vos.frames.set(dot, { image, w, h, at: Date.now() });
		bumpVos();
	});
	bridge.on("live", (raw) => {
		const { dot, state } = raw as { dot: string; state: "open" | "closed" | "unavailable" };
		vos.live.set(dot, state);
		bumpVos();
	});
	bridge.on("connection", (raw) => {
		const next = raw as VosConnection;
		const was = vos.connection?.connected;
		vos.connection = next;
		if (was && !next.connected) resetData();
		bumpVos();
	});
	bridge.on("inbox", (raw) => {
		const { count, items } = raw as { count: InboxCount; items: InboxItem[] };
		vos.inboxCount = count;
		// The open list keeps what the user chose to see; the background poll only knows open items.
		if (!vos.inboxAll) vos.inbox = items;
		bumpVos();
	});
	bridge.on("pair", (raw) => {
		const { id, state } = raw as { id: string; state: PairState["state"] };
		if (!vos.pair || vos.pair.id !== id) return;
		vos.pair = { ...vos.pair, state };
		bumpVos();
		if (state !== "approved") return;
		// A beat on "Approved" before the view opens, so the change is seen.
		setTimeout(() => {
			vos.pair = null;
			resetData();
			void refreshConnection();
		}, 900);
	});
	void refreshConnection();
	// The roster's unread counts and moods, every ten seconds while the view is shown.
	const poll = (): void => {
		if (document.visibilityState === "visible" && vos.connection?.connected) void refreshRoster();
		setTimeout(poll, 10_000);
	};
	setTimeout(poll, 10_000);
}

// ---------------------------------------------------------------- chat

let clientSeq = 0;

export async function sendMessage(dot: string, text: string): Promise<boolean> {
	const trimmed = text.trim();
	if (!trimmed) return false;
	const thread = threadOf(dot);
	const clientId = `smolt-${Date.now()}-${++clientSeq}`;
	const optimistic: Message = { id: clientId, role: "you", text: trimmed, date: new Date().toISOString(), clientId };
	thread.messages = [...thread.messages, optimistic];
	bumpVos();
	try {
		const sent = await vosCall<{ message: Message }>("POST", "/messages", { text: trimmed, clientId }, dot);
		thread.messages = thread.messages.filter((m) => m.id !== clientId);
		thread.messages = upsert(thread.messages, sent.message).sort((a, b) => a.date.localeCompare(b.date));
		bumpVos();
		return true;
	} catch (error) {
		thread.messages = thread.messages.filter((m) => m.id !== clientId);
		vos.notice = error instanceof Error ? error.message : String(error);
		bumpVos();
		return false;
	}
}

export async function stopThread(dot: string): Promise<void> {
	await attempt(() => vosCall("POST", "/stop", undefined, dot));
}

/**
 * Answer an approval. A yes can hold for longer than this once: for an hour,
 * for today, or always; the server then writes an allow rule (with an expiry
 * for the first two).
 */
export async function answerApproval(
	dot: string,
	id: string,
	decision: "approve" | "deny",
	remember: ApprovalRemember = "once",
): Promise<void> {
	const body = decision === "approve" && remember !== "once" ? { decision, remember } : { decision };
	const result = await attempt(() => vosCall<Approval>("POST", `/approvals/${encodeURIComponent(id)}`, body, dot));
	if (result) {
		threadOf(dot).approvals.set(id, result);
		bumpVos();
		if (remember !== "once" && vos.rules) void loadRules();
	}
}

/** The image behind an API path, fetched through the extension once and kept. */
export function imageFor(url: string): string | undefined {
	if (url.startsWith("data:")) return url;
	const cached = vos.images.get(url);
	if (cached !== undefined) return cached === "" ? undefined : cached;
	if (!url.startsWith("/")) return undefined;
	vos.images.set(url, "");
	void bridge
		.request("file", { path: url })
		.then((raw) => {
			const result = raw as VosCallResult;
			if (result.ok && typeof result.value === "string") {
				vos.images.set(url, result.value);
				bumpVos();
			}
		})
		.catch(() => {});
	return undefined;
}

// ---------------------------------------------------------------- secrets

export async function loadSecrets(): Promise<void> {
	const dot = vosOfThread(vos.selected);
	if (!dot) return;
	const list = await vosCall<SecretRequest[] | { secrets: SecretRequest[] }>("GET", "/secrets", undefined, dot).catch(
		() => null,
	);
	if (!list) return;
	vos.secrets = Array.isArray(list) ? list : (list.secrets ?? []);
	bumpVos();
}

/** Hand a secret to the vos's computer. The value is passed straight through and not kept here. */
export async function answerSecret(request: SecretRequest, value: string): Promise<string | null> {
	const result = (await bridge.request("secret", { dot: request.vos, id: request.id, value })) as VosCallResult;
	if (!result.ok) return result.error;
	vos.secrets = vos.secrets.filter((s) => s.id !== request.id);
	bumpVos();
	return null;
}

export async function declineSecret(request: SecretRequest): Promise<void> {
	const ok = await attempt(() =>
		vosCall("POST", `/secrets/${encodeURIComponent(request.id)}/decline`, {}, request.vos),
	);
	if (ok !== undefined) {
		vos.secrets = vos.secrets.filter((s) => s.id !== request.id);
		bumpVos();
	}
}

// ---------------------------------------------------------------- lists

export async function loadSkills(): Promise<void> {
	const value = await attempt(() => vosCall<unknown>("GET", "/skills"));
	if (value !== undefined) vos.skills = asList<Skill>(value, "skills");
	bumpVos();
}

export async function loadRules(): Promise<void> {
	const value = await attempt(() => vosCall<unknown>("GET", "/rules"));
	if (value !== undefined) vos.rules = asList<Rule>(value, "rules");
	bumpVos();
}

export async function loadRoutines(dot: string): Promise<void> {
	const value = await attempt(() => vosCall<unknown>("GET", "/routines", undefined, dot));
	if (value !== undefined) vos.routines.set(dot, asList<Routine>(value, "routines"));
	bumpVos();
}

export async function loadMemory(dot: string): Promise<void> {
	const value = await attempt(() => vosCall<unknown>("GET", "/memory", undefined, dot));
	if (value !== undefined) vos.memory.set(dot, asList<MemoryNote>(value, "memory"));
	bumpVos();
}

export async function loadPlugins(dot: string): Promise<void> {
	const value = await attempt(() => vosCall<unknown>("GET", "/plugins", undefined, dot));
	if (value !== undefined) vos.plugins.set(dot, asList<Plugin>(value, "plugins"));
	bumpVos();
}

export async function loadInbox(): Promise<void> {
	const state = vos.inboxAll ? "all" : "open";
	const [items, count] = await Promise.all([
		vosCall<unknown>("GET", `/inbox?state=${state}`).catch(() => undefined),
		vosCall<InboxCount>("GET", "/inbox/count").catch(() => undefined),
	]);
	if (items !== undefined) vos.inbox = asList<InboxItem>(items, "items");
	if (count) vos.inboxCount = count;
	bumpVos();
}

export function setInboxAll(all: boolean): void {
	vos.inboxAll = all;
	bumpVos();
	void loadInbox();
}

export async function settleInboxItem(item: InboxItem, how: "done" | "dismiss"): Promise<void> {
	const next = await attempt(() => vosCall<InboxItem>("POST", `/inbox/${encodeURIComponent(item.id)}/${how}`, {}));
	if (!next || !vos.inbox) return;
	vos.inbox = vos.inboxAll ? upsert(vos.inbox, next) : vos.inbox.filter((i) => i.id !== item.id);
	if (vos.inboxCount) vos.inboxCount = { ...vos.inboxCount, open: Math.max(0, vos.inboxCount.open - 1) };
	bumpVos();
	void bridge.request("inboxRefresh").catch(() => {});
}

export async function loadComputer(dot: string): Promise<void> {
	const value = await vosCall<unknown>("GET", "/computer", undefined, dot).catch(() => undefined);
	if (value === undefined) return;
	vos.computers.set(dot, readComputerState(value));
	bumpVos();
}

/** Take the computer over (the vos pauses on it), or hand it back. */
export async function takeover(dot: string, take: boolean): Promise<void> {
	const done = await attempt(() => vosCall("POST", take ? "/computer/takeover" : "/computer/handback", {}, dot));
	if (done === undefined) return;
	const current = vos.computers.get(dot) ?? { userInControl: false };
	vos.computers.set(dot, take ? { ...current, userInControl: true } : { userInControl: false });
	bumpVos();
	void loadComputer(dot);
}

export async function loadShares(): Promise<void> {
	const value = await vosCall<unknown>("GET", "/shares").catch(() => undefined);
	vos.shares = value === undefined ? [] : asList<Share>(value, "shares");
	bumpVos();
}

export async function loadScreens(): Promise<void> {
	const value = await vosCall<{ screens?: Screen[] }>("GET", "/screens").catch(() => undefined);
	vos.screens = value?.screens ?? [];
	bumpVos();
}

/** Ask a vos to start a coding agent on its computer: it shows as a task in the chat. */
export async function startCoding(dot: string, task: string, repo?: string): Promise<boolean> {
	const started = await attempt(() => vosCall<Task>("POST", "/code", { task, ...(repo ? { repo } : {}) }, dot));
	if (!started) return false;
	if (started.id) threadOf(dot).tasks.set(started.id, started);
	bumpVos();
	return true;
}

// ---------------------------------------------------------------- teach a task

let teachTimer: ReturnType<typeof setInterval> | null = null;

export async function startTeach(dot: string, goal: string): Promise<void> {
	const started = await attempt(() => vosCall<{ id: string; computerId: string }>("POST", "/teach", { goal }, dot));
	if (!started) return;
	vos.teach = {
		id: started.id,
		computerId: started.computerId,
		goal,
		dot,
		state: "recording",
		startedAt: new Date().toISOString(),
		steps: 0,
	};
	bumpVos();
	pollTeach();
}

function pollTeach(): void {
	if (teachTimer) clearInterval(teachTimer);
	teachTimer = setInterval(async () => {
		const teach = vos.teach;
		if (!teach) {
			if (teachTimer) clearInterval(teachTimer);
			return;
		}
		try {
			const next = await vosCall<TeachSession>(
				"GET",
				`/teach/${encodeURIComponent(teach.id)}`,
				undefined,
				teach.dot,
			);
			vos.teach = { ...teach, ...next, dot: teach.dot };
			if (next.state === "done" || next.state === "cancelled") {
				if (teachTimer) clearInterval(teachTimer);
				if (next.state === "done") void loadSkills();
			}
		} catch (error) {
			vos.teach = { ...teach, error: error instanceof Error ? error.message : String(error) };
		}
		bumpVos();
	}, 1500);
}

export async function stopTeach(): Promise<void> {
	const teach = vos.teach;
	if (!teach) return;
	const next = await attempt(() =>
		vosCall<TeachSession>("POST", `/teach/${encodeURIComponent(teach.id)}/stop`, {}, teach.dot),
	);
	if (next) vos.teach = { ...teach, ...next, dot: teach.dot };
	bumpVos();
}

export async function cancelTeach(): Promise<void> {
	const teach = vos.teach;
	if (!teach) return;
	await attempt(() => vosCall("POST", `/teach/${encodeURIComponent(teach.id)}/cancel`, {}, teach.dot));
	vos.teach = null;
	if (teachTimer) clearInterval(teachTimer);
	bumpVos();
}

export function clearTeach(): void {
	vos.teach = null;
	bumpVos();
}

export function toggleHiddenOpen(): void {
	vos.hiddenOpen = !vos.hiddenOpen;
	bumpVos();
}
