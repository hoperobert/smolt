import { useSyncExternalStore } from "react";
import type {
	Approval,
	Message,
	Roster,
	Routine,
	Rule,
	Screen,
	SecretRequest,
	Share,
	Skill,
	Task,
	TeachSession,
	VosState,
	VosStatus,
} from "../../../../coding-agent/src/extensions/vos/types.ts";
import { api, type VosCallResult, type VosConnection } from "../lib/api.ts";
import { app, bump as bumpApp } from "./app.ts";

/**
 * The Vos section's state, kept apart from the app store.
 *
 * Vos is the user's AI-teammate service. Everything here reaches it through
 * the main process (window.smolt.vos*), which holds the API key: this side
 * only ever sees answers, never the key. Live updates arrive as `vos:event`
 * messages from streams the main process runs.
 *
 * A separate store because the live computer view repaints a few times a
 * second; waking the whole app (sidebar, transcript) for each frame would be
 * waste. Components read it through `useVos()`.
 */

export type VosTab = "chat" | "routines" | "skills" | "teach" | "rules" | "computers" | "profile";

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

interface VosStore {
	connection: VosConnection | null;
	roster: Roster | null;
	rosterError: string | null;
	/** The open thread: a vos id, or `group:<id>`. */
	selected: string | null;
	tab: VosTab;
	threads: Map<string, ThreadState>;
	skills: Skill[] | null;
	rules: Rule[] | null;
	/** Routines by vos id. */
	routines: Map<string, Routine[]>;
	secrets: SecretRequest[];
	shares: Share[] | null;
	screens: Screen[] | null;
	images: Map<string, string>;
	frames: Map<string, LiveFrame>;
	live: Map<string, "open" | "closed" | "unavailable">;
	teach: TeachState | null;
	/** A failure to show at the top of the section, until dismissed. */
	notice: string | null;
	/** Pairing with the phone, while the connect screen shows one. */
	pair: PairState | null;
	/** Sidebar disclosures. */
	rosterOpen: boolean;
	hiddenOpen: boolean;
}

export const vos: VosStore = {
	connection: null,
	roster: null,
	rosterError: null,
	selected: null,
	tab: "chat",
	threads: new Map(),
	skills: null,
	rules: null,
	routines: new Map(),
	secrets: [],
	shares: null,
	screens: null,
	images: new Map(),
	frames: new Map(),
	live: new Map(),
	teach: null,
	notice: null,
	pair: null,
	rosterOpen: readFlag("smolt.vosRosterOpen", true),
	hiddenOpen: false,
};

function readFlag(key: string, fallback: boolean): boolean {
	try {
		const value = localStorage.getItem(key);
		return value === null ? fallback : value === "1";
	} catch {
		return fallback;
	}
}

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

// ---------------------------------------------------------------- calls

export class VosCallError extends Error {
	readonly status: number;
	constructor(message: string, status: number) {
		super(message);
		this.status = status;
	}
}

/** One Vos API call through the main process; throws with the server's message. */
export async function vosCall<T>(method: string, path: string, body?: unknown, dot?: string): Promise<T> {
	const result: VosCallResult = await api.vosCall(method, path, body, dot);
	if (!result.ok) throw new VosCallError(result.error, result.status);
	return result.value as T;
}

/** Run an action; a failure lands in the section's notice instead of vanishing. */
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

// ---------------------------------------------------------------- connection

export async function refreshConnection(): Promise<void> {
	try {
		vos.connection = await api.vosStatus();
	} catch {
		vos.connection = null;
	}
	bumpVos();
	if (vos.connection?.connected) void refreshRoster();
}

export async function connectVos(url: string, key: string): Promise<string | null> {
	const status = await api.vosConnect(url, key);
	vos.connection = status;
	bumpVos();
	if (!status.connected || status.error) return status.error ?? "Could not connect.";
	resetData();
	await refreshRoster();
	openVos();
	return null;
}

/** Ask the server for a pairing; the main process polls it and says how it went (`vos:pair`). */
export async function startPair(url: string): Promise<void> {
	vos.pair = { state: "starting" };
	bumpVos();
	const result = await api.vosPairStart(url);
	vos.pair = result.ok ? { ...result.value, state: "waiting" } : { state: "error", error: result.error };
	bumpVos();
}

export function cancelPair(): void {
	if (vos.pair?.state === "waiting" || vos.pair?.state === "starting") void api.vosPairCancel();
	vos.pair = null;
	bumpVos();
}

export async function disconnectVos(): Promise<void> {
	vos.connection = await api.vosDisconnect();
	resetData();
	bumpVos();
}

function resetData(): void {
	vos.roster = null;
	vos.selected = null;
	vos.threads.clear();
	vos.skills = null;
	vos.rules = null;
	vos.routines.clear();
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
		if (open && app.vosOpen) open.unread = 0;
		const group = vos.roster.groups.find((g) => `group:${g.id}` === vos.selected);
		if (group && app.vosOpen) group.unread = 0;
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

/** Open the Vos section, on a thread when one is named. */
export function openVos(dot?: string, tab?: VosTab): void {
	app.vosOpen = true;
	bumpApp();
	if (tab) vos.tab = tab;
	if (dot) void selectThread(dot);
	else if (!vos.selected && vos.roster) {
		const first = vos.roster.dots.find((d) => !d.hidden);
		if (first) void selectThread(first.id);
	}
	bumpVos();
}

export function closeVos(): void {
	app.vosOpen = false;
	bumpApp();
}

export function setTab(tab: VosTab): void {
	vos.tab = tab;
	bumpVos();
	void loadTab();
}

export async function selectThread(dot: string): Promise<void> {
	const previous = vos.selected;
	vos.selected = dot;
	app.vosOpen = true;
	bumpApp();
	// A group has no routines, teach or profile of its own: those pages follow the lead.
	if (isGroupThread(dot) && (vos.tab === "teach" || vos.tab === "profile")) vos.tab = "chat";
	bumpVos();
	if (previous && previous !== dot) void api.vosUnwatch(previous);
	void api.vosWatch(dot);
	if (leaseTimer) clearInterval(leaseTimer);
	leaseTimer = setInterval(() => {
		if (vos.selected) void api.vosWatch(vos.selected);
	}, 20_000);
	await loadThread(dot);
	void loadTab();
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
		case "skills":
			await loadSkills();
			return;
		case "rules":
			await loadRules();
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

const upsert = <T extends { id: string }>(list: T[], item: T): T[] => {
	const index = list.findIndex((x) => x.id === item.id);
	if (index === -1) return [...list, item];
	const next = [...list];
	next[index] = item;
	return next;
};

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
			if (dot !== vos.selected || !app.vosOpen) refreshRosterSoon();
			break;
		}
		case "task.created":
		case "task.updated":
			if (thread && doc.id) thread.tasks.set(doc.id, data as Task);
			break;
		case "approval.requested":
			if (thread && doc.id) thread.approvals.set(doc.id, data as Approval);
			break;
		case "approval.resolved":
			if (thread && doc.id) thread.approvals.set(doc.id, data as Approval);
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

/** Hook the main process's Vos messages once, at boot. */
export function bootVos(): void {
	if (wired) return;
	wired = true;
	api.onVosEvent((event) => applyEvent(event));
	api.onVosStream(({ dot, state, error }) => {
		const thread = threadOf(dot);
		thread.stream = state;
		thread.error = state === "error" ? error : undefined;
		// Back on after a drop: what was missed comes with Last-Event-ID, but a
		// first connect after a load may still have raced it.
		bumpVos();
	});
	api.onVosFrame(({ dot, image, w, h }) => {
		vos.frames.set(dot, { image, w, h, at: Date.now() });
		bumpVos();
	});
	api.onVosPair(({ id, state }) => {
		if (!vos.pair || vos.pair.id !== id) return;
		vos.pair = { ...vos.pair, state };
		bumpVos();
		if (state !== "approved") return;
		// A beat on "Approved" before the section opens, so the change is seen.
		setTimeout(() => {
			vos.pair = null;
			resetData();
			void refreshConnection().then(async () => {
				await refreshRoster();
				openVos();
			});
		}, 900);
	});
	api.onVosLive(({ dot, state }) => {
		vos.live.set(dot, state);
		bumpVos();
	});
	void refreshConnection();
	// The roster's unread counts and moods: often while the section is open,
	// now and then while it is not.
	const poll = (): void => {
		if (document.visibilityState === "visible" && vos.connection?.connected) void refreshRoster();
		setTimeout(poll, app.vosOpen ? 10_000 : 30_000);
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

export async function answerApproval(dot: string, id: string, decision: "approve" | "deny" | "always"): Promise<void> {
	const result = await attempt(() =>
		vosCall<Approval>("POST", `/approvals/${encodeURIComponent(id)}`, { decision }, dot),
	);
	if (result) {
		threadOf(dot).approvals.set(id, result);
		bumpVos();
	}
}

/** The image behind an API path, fetched through the main process once and kept. */
export function imageFor(url: string): string | undefined {
	if (url.startsWith("data:")) return url;
	const cached = vos.images.get(url);
	if (cached !== undefined) return cached === "" ? undefined : cached;
	if (!url.startsWith("/")) return undefined;
	vos.images.set(url, "");
	void api.vosFile(url).then((result) => {
		if (result.ok && typeof result.value === "string") {
			vos.images.set(url, result.value);
			bumpVos();
		}
	});
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
	const result = await api.vosSecret(request.vos, request.id, value);
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

const asList = <T>(value: unknown, key: string): T[] =>
	Array.isArray(value) ? (value as T[]) : (((value as Record<string, unknown> | null)?.[key] as T[]) ?? []);

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

// ---------------------------------------------------------------- sidebar disclosures

export function toggleRosterOpen(): void {
	vos.rosterOpen = !vos.rosterOpen;
	try {
		localStorage.setItem("smolt.vosRosterOpen", vos.rosterOpen ? "1" : "0");
	} catch {
		// A disclosure that forgets is fine.
	}
	bumpVos();
}

export function toggleHiddenOpen(): void {
	vos.hiddenOpen = !vos.hiddenOpen;
	bumpVos();
}
