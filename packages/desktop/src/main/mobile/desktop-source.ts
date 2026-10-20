// The Smolt desktop as the mobile protocol's source: the whole protocol on top of the running
// desktop, through the same IPC channels its own window uses (packages/desktop/src/preload.ts),
// reached through a DesktopTransport (transport.ts). In the app that transport is in-process.
//
// Smolt has one live chat shared by its windows ("follows desktop"): opening, sending to or
// retrying a chat here switches the computer to it, and the computer switching chats is announced
// to the phone as `conversation.updated {conversation, reason: "desktop_switched"}`.
//
// Mapping (protocol → Smolt):
//   conversations.list/search  app:sessions [query]             (Smolt lists the newest 50)
//   conversations.get          app:session-messages path        (+ the live turn, if streaming)
//   conversations.update       agent:call setSessionName / setModel; starred is kept here
//   conversations.delete       app:session-delete path          (+ newSession if it was open)
//   conversations.subscribe    agent:call switchSession path    (follows desktop)
//   chat.send                  switchSession | newSession, [setModel], [setThinkingLevel], prompt
//   chat.send with parentId    getForkMessages + fork(entryId), then prompt   (edit = a new session)
//   chat.retry                 getForkMessages + fork(entryId of the user message), prompt its text
//   chat.send options.deliver  prompt(text, images, "steer" | "followUp")  into the running reply
//   chat.send projectId        app:open-project folder (or newSession if it is open), then prompt
//   chat.stop                  agent:call abort
//   models / settings          getAvailableModels, getAvailableThinkingLevels, getState,
//                              setModel / setThinkingLevel (persist), app:providers-list
//   approvals                  permission:request / permission:removed, app:pending-approvals,
//                              app:permission-reply
//   prompts                    agent:event extension_ui_request, agent:call respondExtensionUI
//   streaming                  agent:event (see turn.ts), agent:busy, agent:background-settled
//   projects (folders)         app:folders + app:recent-projects; conversations by session cwd
//   settings.permissionMode    app:permission-mode
//   following the computer     session:changed, agent:attached

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { newId } from "./ids.ts";
import { imageSize } from "./images.ts";
import { bool, makeSnippet, str } from "./params.ts";
import {
	type Approval,
	badParams,
	type Conversation,
	type Decision,
	ErrorCode,
	type FileRef,
	type Message,
	type Model,
	notFound,
	type PermissionMode,
	type Project,
	type Prompt,
	type PromptAnswer,
	RpcError,
	type Settings,
	type StreamEvent,
	type Style,
} from "./protocol.ts";
import type { Conn } from "./server.ts";
import type {
	CallCtx,
	ConversationDetail,
	Hub,
	Params,
	ProjectsApi,
	RetryResult,
	SendResult,
	Source,
} from "./source.ts";
import type { Store, StoredFile } from "./store.ts";
import { IMAGE_ONLY_TEXT, imagesOf, mapTranscript, type Raw, textOf, userMessage } from "./transcript.ts";
import { DesktopClient, DesktopError, type DesktopTransport } from "./transport.ts";
import { LiveTurn } from "./turn.ts";

export const FEATURES = [
	"thinking",
	"thinking_levels",
	"prompts",
	"approvals",
	"files",
	"search",
	"follows_desktop",
	"steer",
	"permission_modes",
	"projects",
	"project_folders",
];

/**
 * Smolt's permission modes (coding-agent extensions/permissions PERMISSION_MODES), named and
 * described as the desktop's mode picker does (renderer/state/app.ts MODE_ITEMS).
 */
export const PERMISSION_MODES: PermissionMode[] = [
	{ id: "auto", name: "Auto", description: "Edit files and run commands without asking" },
	{ id: "acceptEdits", name: "Accept edits", description: "Apply file edits, ask before running commands" },
	{ id: "manual", name: "Manual", description: "Ask before every edit and command" },
	{ id: "plan", name: "Plan", description: "Investigate and propose, change nothing" },
	{ id: "bypass", name: "Bypass", description: "Skip every check, including destructive commands" },
];

/** What Smolt calls a chat nobody has named yet (packages/desktop/src/main/sessions.ts). */
const UNNAMED_TITLE = "New session";
/** Smolt's own levels; anything else in getAvailableThinkingLevels is an extension entry ("auto"). */
const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
/** Approvals expire in the agent after this long (coding-agent extensions/permissions REQUEST_TIMEOUT_MS). */
const APPROVAL_TTL_MS = 5 * 60_000;
/** Text files up to this size are put into the prompt; Smolt itself only takes images. */
const INLINE_DOCUMENT_LIMIT = 200 * 1024;
const MODELS_TTL_MS = 30_000;
/** How soon to look again at which chat the desktop is on after its agent failed to say. */
const FOLLOW_RETRY_MS = 3000;

/** One row of `app:sessions` (packages/desktop/src/main/sessions.ts SessionSummary + busy). */
type Row = {
	path: string;
	id: string;
	cwd: string;
	title: string;
	preview: string;
	lastActive: number;
	messageCount: number;
	model: string;
	thinking: string;
	parent: string;
	created: number;
	busy?: boolean;
};

/** `getState` (coding-agent modes/rpc/rpc-types.ts RpcSessionState), the parts used here. */
type AgentState = {
	model?: { provider?: string; id?: string };
	thinkingLevel?: string;
	activeThinkingEntry?: string;
	isStreaming?: boolean;
	sessionFile?: string;
	sessionId?: string;
	sessionName?: string;
};

/** A permission request as main.ts forwards it (approvals.ts PermissionRequest + requestMeta). */
type PermissionRequest = {
	id: string;
	tool: string;
	summary: string;
	mode?: string;
	danger?: string;
	createdAt: number;
	slot?: number;
	session?: string;
};

type Active = {
	slot?: number;
	path: string;
	sessionId: string;
	conversationId: string;
	model: string;
	thinking: string;
	name: string;
};

/** A send waiting for its turn to start: the ids promised to the phone, and its events held until the response is out. */
type PendingSend = {
	userId: string;
	assistantId: string;
	conn: Conn;
	createdAt: number;
	hold: boolean;
	queue: (() => void)[];
	userUsed?: boolean;
	assistantUsed?: boolean;
};

type BridgeState = {
	/** Smolt has no starring; the bridge keeps it. Conversation ids. */
	starred: string[];
	/** Conversation id -> session file. */
	paths: Record<string, string>;
	/** `${sessionId}:${u|a}${timestamp}` -> the message id promised to the phone in chat.send. */
	ids: Record<string, string>;
	feedback: Record<string, "up" | "down">;
	/** Project id -> folder path (projects are Smolt's project folders). */
	projects: Record<string, string>;
	starredProjects: string[];
};

export const conversationIdOf = (sessionId: string) => `cnv_${sessionId}`;
const sessionIdOf = (conversationId: string) => conversationId.replace(/^cnv_/, "");

export type SmoltDesktopOptions = {
	store: Store;
	transport: DesktopTransport;
};

export class SmoltDesktopSource implements Source {
	readonly name = "smolt-desktop";
	readonly client: DesktopClient;
	private store: Store;
	private hub!: Hub;
	private file: string;
	private state: BridgeState;
	private saveTimer: NodeJS.Timeout | undefined;

	private active: Active | undefined;
	private activeStale = true;
	private activeLoading: Promise<Active> | undefined;
	private rows = new Map<string, Row>();
	private busyPaths = new Set<string>();
	private turns = new Map<number, LiveTurn>();
	private approvals = new Map<string, Approval>();
	private prompts = new Map<string, { prompt: Prompt; slot?: number; timer?: NodeJS.Timeout }>();
	private pending: PendingSend | undefined;
	private chain: Promise<void> = Promise.resolve();
	private moves: Promise<unknown> = Promise.resolve();
	private modelsCache: { at: number; models: Model[] } | undefined;
	private knownFiles = new Set<string>();
	/** Messages steered into a running reply from the phone, waiting for the agent to take them. */
	private steers: { conversationId: string; text: string; id: string; at: number }[] = [];
	/** Folders Smolt lists as projects (app:folders + app:recent-projects), best first. */
	private projectFolders: string[] = [];
	/** No following the desktop before this time (its agent just failed to answer). */
	private followAgainAt = 0;
	private followTimer: NodeJS.Timeout | undefined;
	private lastFailure: { line: string; at: number } | undefined;
	private closed = false;

	constructor(opts: SmoltDesktopOptions) {
		this.store = opts.store;
		this.client = new DesktopClient(opts.transport, (s) => this.hub.log(s));
		this.file = path.join(opts.store.dir, "smolt-desktop.json");
		let saved: Partial<BridgeState> = {};
		try {
			saved = JSON.parse(fs.readFileSync(this.file, "utf8"));
		} catch {
			// first run
		}
		this.state = { starred: [], paths: {}, ids: {}, feedback: {}, projects: {}, starredProjects: [], ...saved };
		for (const f of this.store.data.files) this.knownFiles.add(f.id);
	}

	attach(hub: Hub) {
		this.hub = hub;
	}

	async start() {
		this.client.on("event", (channel: string, args: unknown[]) => this.enqueue(() => this.onEvent(channel, args)));
		this.client.on("up", (info: { restarted: boolean }) => this.enqueue(() => this.onUp(info.restarted)));
		this.client.start();
	}

	async close() {
		this.closed = true;
		this.client.close();
		clearTimeout(this.followTimer);
		for (const p of this.prompts.values()) clearTimeout(p.timer);
		this.flush();
	}

	// ---------------------------------------------------------------- persistence

	private save() {
		if (this.saveTimer) return;
		this.saveTimer = setTimeout(() => this.flush(), 300);
	}

	private flush() {
		clearTimeout(this.saveTimer);
		this.saveTimer = undefined;
		const tmp = `${this.file}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(this.state, null, 1));
		fs.renameSync(tmp, this.file);
	}

	// ---------------------------------------------------------------- helpers

	/** Run desktop events one at a time, in order. */
	private enqueue(fn: () => Promise<void> | void) {
		if (this.closed) return;
		this.chain = this.chain.then(fn).catch((err) => this.logFailure("a desktop event failed", err));
	}

	/**
	 * One short line per distinct failure per minute. A desktop error can carry a crashed
	 * agent's whole output, and the same failure repeats for as long as the agent is down.
	 */
	private logFailure(what: string, err: unknown) {
		const message = (err instanceof Error ? err.message : String(err)).split("\n")[0]!.slice(0, 200);
		const line = `${what}: ${message}`;
		const now = Date.now();
		if (this.lastFailure?.line === line && now - this.lastFailure.at < 60_000) return;
		this.lastFailure = { line, at: now };
		this.hub.log(err instanceof DesktopError || !(err instanceof Error) ? line : `${line}\n${err.stack ?? ""}`);
	}

	/** Serialize everything that moves the desktop between chats (switch, new, fork, prompt). */
	private moving<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.moves.then(fn, fn);
		this.moves = run.catch(() => undefined);
		return run;
	}

	private idFor(sessionId: string, role: "u" | "a", ts: number): string {
		return this.state.ids[`${sessionId}:${role}${ts}`] ?? `msg_${role}${ts}`;
	}

	private assignId(sessionId: string, role: "u" | "a", ts: number, id: string): string {
		this.state.ids[`${sessionId}:${role}${ts}`] = id;
		this.save();
		return id;
	}

	/** Keep a transcript image as an uploaded file (content-addressed), so the phone can download it. */
	private fileFor(image: { data: string; mimeType: string }): FileRef {
		const bytes = Buffer.from(image.data, "base64");
		const id = `fil_${crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 26)}`;
		if (!this.knownFiles.has(id)) {
			const ext = image.mimeType.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
			const file: StoredFile = {
				id,
				name: `image.${ext}`,
				mimeType: image.mimeType,
				size: bytes.length,
				kind: "image",
				...imageSize(bytes),
				createdAt: Date.now(),
			};
			this.store.writeBlob(id, bytes);
			this.store.data.files.push(file);
			this.store.save();
			this.knownFiles.add(id);
		}
		return this.store.fileRef(this.store.fileMeta(id));
	}

	private mapOptions(sessionId: string, tailRunning = false) {
		return {
			idFor: (role: "u" | "a", ts: number) => this.idFor(sessionId, role, ts),
			fileFor: (img: { data: string; mimeType: string }) => this.fileFor(img),
			tailRunning,
		};
	}

	// ---------------------------------------------------------------- the active chat

	/** Ask the desktop which chat it is on. Cached until it says it moved. */
	private refreshActive(force = false): Promise<Active> {
		if (!force && !this.activeStale && this.active) return Promise.resolve(this.active);
		this.activeLoading ??= (async () => {
			try {
				this.activeStale = false;
				const [st, slot] = await Promise.all([
					this.client.call<AgentState>("getState"),
					this.client.invoke<number>("app:active-slot").catch(() => undefined),
				]);
				const sessionId = String(st?.sessionId ?? "");
				const active: Active = {
					slot: typeof slot === "number" ? slot : undefined,
					path: String(st?.sessionFile ?? ""),
					sessionId,
					conversationId: conversationIdOf(sessionId),
					model: st?.model?.provider && st.model.id ? `${st.model.provider}/${st.model.id}` : "",
					thinking: String(st?.activeThinkingEntry ?? st?.thinkingLevel ?? ""),
					name: String(st?.sessionName ?? ""),
				};
				if (active.path && this.state.paths[active.conversationId] !== active.path) {
					this.state.paths[active.conversationId] = active.path;
					this.save();
				}
				this.active = active;
				return active;
			} catch (err) {
				this.activeStale = true;
				throw err;
			} finally {
				this.activeLoading = undefined;
			}
		})();
		return this.activeLoading;
	}

	/** The desktop may have moved: re-read, and tell the phones if it is on another chat now. */
	private async followDesktop() {
		// The desktop announces `agent:attached` after every agent call that fails, getState
		// included: answering each with another getState would spin for as long as its agent is
		// down. After a failure, follow again once a short while later instead.
		if (Date.now() < this.followAgainAt) {
			this.followLater();
			return;
		}
		const before = this.active?.conversationId;
		this.activeStale = true;
		let now: Active;
		try {
			now = await this.refreshActive();
		} catch (err) {
			this.followAgainAt = Date.now() + FOLLOW_RETRY_MS;
			this.followLater();
			throw err;
		}
		if (now.conversationId === before || !now.path) return;
		if (!this.rows.has(now.conversationId)) await this.refreshRows().catch(() => undefined);
		this.hub.broadcast("conversation.updated", {
			conversation: this.view(now.conversationId),
			reason: "desktop_switched",
		});
	}

	private followLater() {
		if (this.followTimer) return;
		this.followTimer = setTimeout(
			() => {
				this.followTimer = undefined;
				this.enqueue(() => this.followDesktop());
			},
			Math.max(0, this.followAgainAt - Date.now()),
		);
		this.followTimer.unref();
	}

	/** Switch the desktop to this session, as clicking it in Smolt's sidebar does. */
	private async ensureActive(sessionPath: string) {
		const active = await this.refreshActive();
		if (active.path === sessionPath) return;
		const r = await this.client.call<{ cancelled?: boolean } | undefined>("switchSession", sessionPath);
		if (r?.cancelled)
			throw new RpcError(ErrorCode.Upstream, "Smolt didn't open that chat (an extension cancelled the switch)");
		await this.refreshActive(true);
	}

	// ---------------------------------------------------------------- rows (the sidebar)

	private async refreshRows(query?: string): Promise<Row[]> {
		const rows = (await this.client.invoke<Row[]>("app:sessions", query)) ?? [];
		for (const r of rows) {
			const id = conversationIdOf(r.id);
			this.rows.set(id, r);
			if (this.state.paths[id] !== r.path) {
				this.state.paths[id] = r.path;
				this.save();
			}
		}
		if (query === undefined) {
			// A full listing is the truth about which chats are working.
			for (const r of rows) {
				if (r.busy) this.busyPaths.add(r.path);
			}
		}
		return rows;
	}

	/** The session file behind a conversation id. Throws -32003 when Smolt has no such chat. */
	private async pathOf(id: unknown): Promise<string> {
		if (typeof id !== "string" || !id.startsWith("cnv_")) throw notFound("Conversation");
		const known = this.state.paths[id];
		if (known) return known;
		// Not seen yet: Smolt's search reads the raw files, and the session id is in the header line.
		const sessionId = sessionIdOf(id);
		await this.refreshRows(sessionId).catch(() => undefined);
		const p = this.state.paths[id];
		if (!p) throw notFound("Conversation");
		return p;
	}

	private isBusy(conversationId: string): boolean {
		const p = this.state.paths[conversationId];
		return (p !== undefined && this.busyPaths.has(p)) || this.turnFor(conversationId)?.isOpen === true;
	}

	private turnFor(conversationId: string): LiveTurn | undefined {
		for (const t of this.turns.values()) if (t.conversationId === conversationId) return t;
		return undefined;
	}

	private view(conversationId: string): Conversation {
		const row = this.rows.get(conversationId);
		const active = this.active?.conversationId === conversationId ? this.active : undefined;
		const now = Date.now();
		const title = row && row.title !== UNNAMED_TITLE ? row.title : (active?.name ?? "");
		return {
			id: conversationId,
			title,
			model: row?.model || active?.model || this.active?.model || "",
			starred: this.state.starred.includes(conversationId),
			createdAt: row?.created ?? now,
			updatedAt: row?.lastActive ?? now,
			isGenerating: this.isBusy(conversationId),
			...(row?.preview ? { preview: row.preview } : {}),
			...(row?.cwd && this.projectFolders.includes(row.cwd) ? { projectId: this.projectIdOf(row.cwd) } : {}),
			desktopActive: this.active !== undefined && this.active.conversationId === conversationId,
		};
	}

	private announce(conversationId: string) {
		this.hub.broadcast("conversation.updated", { conversation: this.view(conversationId) });
	}

	private conversationOfPath(p: string | undefined): string | undefined {
		if (!p) return undefined;
		for (const [id, known] of Object.entries(this.state.paths)) if (known === p) return id;
		return undefined;
	}

	// ---------------------------------------------------------------- desktop events

	private async onUp(restarted: boolean) {
		this.modelsCache = undefined;
		if (restarted) {
			// A new desktop process: whatever was running died with the old one.
			for (const [slot, turn] of this.turns) {
				turn.finish({ status: "error", error: "Smolt restarted" });
				this.turns.delete(slot);
				this.announce(turn.conversationId);
			}
			for (const id of [...this.prompts.keys()]) this.resolvePrompt(id);
			this.busyPaths.clear();
		}
		await this.followDesktop().catch(() => undefined);
		await this.refreshProjectFolders().catch(() => undefined);
		await this.refreshRows().catch(() => undefined);
		// Approvals asked while we were away, and ones answered meanwhile.
		const pending = await this.client.invoke<PermissionRequest[]>("app:pending-approvals").catch(() => undefined);
		if (pending) {
			const live = new Set(pending.map((r) => r.id));
			for (const id of [...this.approvals.keys()]) if (!live.has(id)) this.removeApproval(id);
			for (const r of pending) if (!this.approvals.has(r.id)) this.addApproval(r);
		}
	}

	private async onEvent(channel: string, args: unknown[]) {
		switch (channel) {
			case "agent:event":
				return this.onAgentEvent(args[0] as Raw, typeof args[1] === "number" ? args[1] : undefined);
			case "agent:attached":
			case "session:changed":
				return this.followDesktop();
			case "agent:busy": {
				const paths = new Set(Array.isArray(args[0]) ? args[0].map(String) : []);
				const changed = [...paths, ...this.busyPaths].filter((p) => paths.has(p) !== this.busyPaths.has(p));
				this.busyPaths = paths;
				for (const p of changed) {
					const id = this.conversationOfPath(p);
					if (id) this.announce(id);
				}
				return;
			}
			case "agent:background-settled": {
				// A turn left running when the desktop switched away has finished out of sight.
				const p = String((args[0] as { sessionPath?: unknown })?.sessionPath ?? "");
				for (const [slot, turn] of this.turns) {
					if (turn.path !== p || slot === this.active?.slot) continue;
					turn.finish();
					this.turns.delete(slot);
				}
				this.busyPaths.delete(p);
				const id = this.conversationOfPath(p);
				if (id) {
					await this.refreshRows().catch(() => undefined);
					this.announce(id);
				}
				return;
			}
			case "agent:turn-dropped":
			case "agent:exited": {
				const info = (args[0] ?? {}) as { slotId?: number; sessionPath?: string };
				for (const [slot, turn] of this.turns) {
					if (slot !== info.slotId && turn.path !== info.sessionPath) continue;
					turn.finish({ status: "error", error: "Smolt's agent stopped before the reply finished" });
					this.turns.delete(slot);
					this.announce(turn.conversationId);
				}
				return;
			}
			case "permission:request":
				return this.addApproval(args[0] as PermissionRequest);
			case "permission:removed":
				return this.removeApproval(String(args[0]));
			default:
				return;
		}
	}

	private async onAgentEvent(ev: Raw, slot: number | undefined) {
		if (!ev || typeof ev !== "object") return;
		const type = ev.type;
		if (type === "extension_ui_request") return this.onUiRequest(ev, slot);
		if (type === "session_info_changed") {
			const active = await this.refreshActive(true).catch(() => undefined);
			await this.refreshRows().catch(() => undefined);
			if (active?.path) this.announce(active.conversationId);
			return;
		}
		if (type === "session_replaced") return this.followDesktop();

		const key = slot ?? -1;
		let turn = this.turns.get(key);
		const streaming =
			type === "message_start" ||
			type === "message_update" ||
			type === "message_end" ||
			type === "tool_execution_end";
		if (type === "agent_start" || (!turn && streaming)) {
			if (turn && type === "agent_start") turn.finish();
			turn = await this.beginTurn(slot);
			this.turns.set(key, turn);
			this.announce(turn.conversationId);
			if (type === "agent_start") return;
		}
		if (!turn) return;
		if (turn.handle(ev)) {
			this.turns.delete(key);
			this.busyPaths.delete(turn.path);
			for (const [id, p] of this.prompts) if (p.slot === slot) this.resolvePrompt(id);
			await this.refreshRows().catch(() => undefined);
			this.announce(turn.conversationId);
		}
	}

	private async beginTurn(slot: number | undefined): Promise<LiveTurn> {
		const active = await this.refreshActive(slot !== undefined && slot !== this.active?.slot);
		const conversationId = active.conversationId;
		const sessionId = active.sessionId;
		// The phone that sent this, if one did: its ids, its subscription, and its events held until its response is out.
		const pending = this.pending && Date.now() - this.pending.createdAt < 30_000 ? this.pending : undefined;
		this.pending = undefined;
		if (pending) pending.conn.subscriptions.add(conversationId);
		let history: Message[] = [];
		if (active.path) {
			const raw = await this.rawTranscript(active.path).catch(() => [] as Raw[]);
			history = mapTranscript(raw, this.mapOptions(sessionId));
		}
		const emit = (messageId: string, seq: number, event: StreamEvent) => {
			const send = () =>
				this.hub.toSubscribers(conversationId, "stream.event", { conversationId, messageId, seq, event });
			if (pending?.hold) pending.queue.push(send);
			else send();
		};
		return new LiveTurn({
			conversationId,
			slot,
			path: active.path,
			history,
			ids: {
				user: (ts, text) => {
					if (pending && !pending.userUsed) {
						pending.userUsed = true;
						return this.assignId(sessionId, "u", ts, pending.userId);
					}
					const steered = this.steers.findIndex((x) => x.conversationId === conversationId && x.text === text);
					if (steered >= 0) return this.assignId(sessionId, "u", ts, this.steers.splice(steered, 1)[0].id);
					return this.idFor(sessionId, "u", ts);
				},
				assistant: (ts) => {
					if (pending && !pending.assistantUsed) {
						pending.assistantUsed = true;
						return this.assignId(sessionId, "a", ts, pending.assistantId);
					}
					return this.idFor(sessionId, "a", ts);
				},
			},
			sink: {
				emit,
				announceUser: (id) => id !== pending?.userId,
				userMessage: (raw, id, parentId) => userMessage(raw, id, parentId, this.mapOptions(sessionId)),
			},
		});
	}

	// ---------------------------------------------------------------- prompts (extension dialogs)

	private onUiRequest(ev: Raw, slot: number | undefined) {
		const id = String(ev.id ?? "");
		const method = String(ev.method ?? "");
		// `editor` is cancelled by the desktop window at once (it has no editor surface), and
		// notify/setStatus/setWidget/… are not questions.
		if (!id || !["confirm", "select", "multiselect", "input"].includes(method)) return;
		if (this.prompts.has(id)) return;
		const owner = [...this.turns.entries()].find(([s]) => s === slot)?.[1]?.conversationId;
		const prompt: Prompt = {
			id,
			...((owner ?? (slot === this.active?.slot ? this.active?.conversationId : undefined))
				? { conversationId: owner ?? this.active!.conversationId }
				: {}),
			kind: method as Prompt["kind"],
			title: String(ev.title ?? ""),
			...(typeof ev.message === "string" ? { message: ev.message } : {}),
			...(Array.isArray(ev.options) ? { options: ev.options.map(String) } : {}),
			...(typeof ev.placeholder === "string" ? { placeholder: ev.placeholder } : {}),
			...(typeof ev.prefill === "string" ? { initial: ev.prefill } : {}),
		};
		const timeout = typeof ev.timeout === "number" && ev.timeout > 0 ? ev.timeout : undefined;
		const timer = timeout ? setTimeout(() => this.resolvePrompt(id), timeout) : undefined;
		this.prompts.set(id, { prompt, slot, timer });
		this.hub.broadcast("prompt.requested", { prompt });
	}

	private resolvePrompt(id: string) {
		const p = this.prompts.get(id);
		if (!p) return;
		clearTimeout(p.timer);
		this.prompts.delete(id);
		this.hub.broadcast("prompt.resolved", { id });
	}

	async respondPrompt(answer: PromptAnswer): Promise<boolean> {
		const p = this.prompts.get(answer.id);
		if (!p) return false;
		// The agent takes one of: {value} | {values} | {confirmed} | {cancelled: true} (rpc-types.ts
		// RpcExtensionUIResponse). The desktop routes it to the agent that asked by slotId.
		const body: Record<string, unknown> = { id: answer.id, slotId: p.slot };
		if (answer.cancelled) body.cancelled = true;
		else if (p.prompt.kind === "confirm") body.confirmed = answer.confirmed === true;
		else if (p.prompt.kind === "multiselect") body.values = answer.values ?? (answer.value ? [answer.value] : []);
		else if (answer.value !== undefined) body.value = answer.value;
		else body.cancelled = true;
		await this.client.call("respondExtensionUI", body);
		this.resolvePrompt(answer.id);
		return true;
	}

	pendingPrompts(): Prompt[] {
		return [...this.prompts.values()].map((p) => p.prompt);
	}

	// ---------------------------------------------------------------- approvals

	private addApproval(r: PermissionRequest) {
		if (!r || typeof r.id !== "string" || this.approvals.has(r.id)) return;
		const conversationId = this.conversationOfPath(r.session) ?? this.active?.conversationId ?? "";
		const titles: Record<string, string> = {
			bash: "Run a command",
			powershell: "Run a command",
			edit: "Edit a file",
			write: "Write a file",
		};
		const approval: Approval = {
			id: r.id,
			conversationId,
			messageId: this.turnFor(conversationId)?.assistant?.id ?? "",
			toolName: r.tool,
			title: titles[r.tool] ?? `Use ${r.tool}`,
			detail: r.danger ? `${r.summary}\n\nWarning: ${r.danger}` : r.summary,
			input: { summary: r.summary, ...(r.mode ? { mode: r.mode } : {}), ...(r.danger ? { danger: r.danger } : {}) },
			expiresAt: (r.createdAt || Date.now()) + APPROVAL_TTL_MS,
		};
		this.approvals.set(r.id, approval);
		this.hub.broadcast("approval.requested", { approval });
	}

	private removeApproval(id: string, decision?: Decision) {
		if (!this.approvals.delete(id)) return;
		// Answered on the PC (or expired), the decision isn't known here; the phone only needs the id.
		this.hub.broadcast("approval.resolved", { id, ...(decision ? { decision } : {}) });
	}

	async respondApproval(id: string, decision: Decision): Promise<boolean> {
		if (!this.approvals.has(id)) return false;
		const answer = { allow_once: "allow", allow_always: "always", deny: "deny" }[decision];
		const r = await this.client.invoke<{ ok?: boolean; error?: string }>("app:permission-reply", id, answer);
		if (!r?.ok) {
			// Gone already (answered on the PC, or expired).
			this.removeApproval(id);
			return false;
		}
		this.removeApproval(id, decision);
		return true;
	}

	pendingApprovals(): Approval[] {
		return [...this.approvals.values()];
	}

	// ---------------------------------------------------------------- §4.1 Session

	features(): string[] {
		return FEATURES;
	}

	styles(): Style[] {
		return [];
	}

	async models(): Promise<Model[]> {
		if (this.modelsCache && Date.now() - this.modelsCache.at < MODELS_TTL_MS) return this.modelsCache.models;
		try {
			const [all, providers, levels, active] = await Promise.all([
				this.client.call<Raw[]>("getAvailableModels"),
				this.client.invoke<{ id: string }[] | null>("app:providers-list").catch(() => null),
				this.client.call<string[]>("getAvailableThinkingLevels").catch(() => [] as string[]),
				this.refreshActive(),
			]);
			// As the desktop's picker: only providers set up in Smolt, not every key in the environment.
			const configured = Array.isArray(providers) ? new Set(providers.map((p) => p.id)) : undefined;
			let list = (all ?? []).filter((m) => !configured || configured.has(String(m.provider)));
			if (list.length === 0) list = all ?? [];
			const extras = (levels ?? []).filter((l) => !LEVELS.includes(l));
			const models = list.map((m): Model => {
				const provider = String(m.provider ?? "");
				const id = `${provider}/${m.id}`;
				const input = Array.isArray(m.input) ? m.input : [];
				const ctx =
					typeof m.contextWindow === "number" && m.contextWindow > 0
						? ` · ${Math.round(m.contextWindow / 1000)}k context`
						: "";
				return {
					id,
					name: String(m.name ?? m.id),
					description: `${provider}${ctx}`,
					isDefault: id === active.model,
					supportsThinking: m.reasoning === true,
					supportsImages: input.includes("image"),
					provider,
					thinkingLevels: [...extras, ...supportedLevels(m)],
				};
			});
			this.modelsCache = { at: Date.now(), models };
			return models;
		} catch (err) {
			// Bootstrap must work while the agent is still starting; the phone refreshes when it reconnects.
			if (this.modelsCache) return this.modelsCache.models;
			if (err instanceof DesktopError) return [];
			throw err;
		}
	}

	permissionModes(): PermissionMode[] {
		return PERMISSION_MODES;
	}

	async settings(): Promise<Settings> {
		const local = this.store.data.settings;
		const [active, mode] = await Promise.all([
			this.refreshActive().catch(() => this.active),
			// The mode lives in a file the agent reads before every tool call; the PC can change it any time.
			this.client
				.invoke<{ ok?: boolean; value?: string }>("app:permission-mode")
				.catch(() => undefined),
		]);
		const level = active?.thinking ?? "";
		return {
			displayName: local.displayName,
			nickname: local.nickname,
			preferences: local.preferences,
			defaultModel: active?.model ?? "",
			style: "normal",
			extendedThinking: level !== "" && level !== "off",
			webSearch: false,
			...(level ? { thinkingLevel: level } : {}),
			...(mode?.ok && mode.value ? { permissionMode: mode.value } : {}),
		};
	}

	async updateSettings(p: Params): Promise<Settings> {
		const local = this.store.data.settings;
		// Name and preferences have no place in Smolt; they are kept here for the phone.
		for (const key of ["displayName", "nickname", "preferences"] as const) {
			const v = str(p, key, { optional: true, allowEmpty: true });
			if (v !== undefined) local[key] = v;
		}
		this.store.save();
		const model = str(p, "defaultModel", { optional: true });
		if (model !== undefined) {
			const [provider, id] = splitModel(model);
			if (!(await this.models()).some((m) => m.id === model)) throw badParams(`Unknown model ${model}`);
			// persist: the global default too, as the desktop's own model picker does.
			await this.client.call("setModel", provider, id, true);
			this.modelsCache = undefined;
		}
		let level = str(p, "thinkingLevel", { optional: true });
		const extended = bool(p, "extendedThinking");
		if (level === undefined && extended !== undefined) level = extended ? "medium" : "off";
		if (level !== undefined) await this.client.call("setThinkingLevel", level, true);
		const mode = str(p, "permissionMode", { optional: true });
		if (mode !== undefined) {
			if (!PERMISSION_MODES.some((m) => m.id === mode)) throw badParams(`Unknown permission mode ${mode}`);
			const r = await this.client.invoke<{ ok?: boolean; error?: string }>("app:permission-mode", mode);
			if (!r?.ok) throw new DesktopError(r?.error ?? "Smolt didn't change the permission mode");
		}
		if (model !== undefined || level !== undefined) await this.refreshActive(true);
		const next = await this.settings();
		this.hub.broadcast("settings.updated", { settings: next });
		return next;
	}

	// ---------------------------------------------------------------- §4.2 Conversations

	async listConversations(q: { offset: number; limit: number; projectId?: string; starred?: boolean }) {
		const folder = q.projectId !== undefined ? await this.projectPath(q.projectId) : undefined;
		await this.refreshActive().catch(() => undefined);
		await this.refreshProjectFolders().catch(() => undefined);
		const rows = await this.refreshRows();
		const all = rows
			.filter((r) => folder === undefined || r.cwd === folder)
			.map((r) => this.view(conversationIdOf(r.id)))
			.filter((c) => q.starred === undefined || c.starred === q.starred)
			.sort((a, b) => b.updatedAt - a.updatedAt);
		const page = all.slice(q.offset, q.offset + q.limit);
		return { items: page, nextCursor: q.offset + q.limit < all.length ? String(q.offset + q.limit) : undefined };
	}

	async searchConversations(query: string, limit: number) {
		const rows = (await this.refreshRows(query)).slice(0, limit);
		const out: { conversation: Conversation; snippet: string }[] = [];
		for (const r of rows) {
			let snippet = r.title.toLowerCase().includes(query) ? r.title : makeSnippet(r.preview, query);
			if (!snippet) {
				const raw = await this.rawTranscript(r.path).catch(() => [] as Raw[]);
				for (const m of raw) {
					snippet = makeSnippet(textOf(m.content), query);
					if (snippet) break;
				}
			}
			out.push({ conversation: this.view(conversationIdOf(r.id)), snippet: snippet ?? r.preview ?? r.title });
		}
		return out;
	}

	private async rawTranscript(sessionPath: string): Promise<Raw[]> {
		const page = await this.client.invoke<{ messages?: Raw[] }>("app:session-messages", sessionPath, {
			limit: 1_000_000,
		});
		return Array.isArray(page?.messages) ? page.messages : [];
	}

	/** The stored transcript with the live turn laid over it. */
	private async transcript(conversationId: string, sessionPath: string): Promise<{ messages: Message[]; raw: Raw[] }> {
		const sessionId = sessionIdOf(conversationId);
		const raw = await this.rawTranscript(sessionPath);
		const messages = mapTranscript(raw, this.mapOptions(sessionId, this.isBusy(conversationId)));
		const turn = this.turnFor(conversationId);
		if (turn) {
			// The live reply replaces what has been written of it so far.
			let cut = messages.length;
			const at = (id: string | undefined) => (id ? messages.findIndex((m) => m.id === id) : -1);
			const live = turn.snapshot;
			if (turn.user && at(turn.user.id) >= 0) cut = at(turn.user.id) + 1;
			else if (live && at(live.id) >= 0) cut = at(live.id);
			messages.splice(cut);
			if (turn.user && at(turn.user.id) < 0) messages.push(structuredClone(turn.user));
			if (live) messages.push(live);
		}
		for (const m of messages) {
			const rating = this.state.feedback[m.id];
			if (rating) m.feedback = rating;
		}
		return { messages, raw };
	}

	async getConversation(id: unknown): Promise<ConversationDetail> {
		const sessionPath = await this.pathOf(id);
		const conversationId = id as string;
		if (!this.rows.has(conversationId)) await this.refreshRows().catch(() => undefined);
		const { messages } = await this.transcript(conversationId, sessionPath);
		const conversation = this.view(conversationId);
		const leaf = messages.at(-1)?.id;
		return { conversation: { ...conversation, ...(leaf ? { currentLeafId: leaf } : {}) }, messages, artifacts: [] };
	}

	async updateConversation(id: unknown, p: Params): Promise<Conversation> {
		const sessionPath = await this.pathOf(id);
		const conversationId = id as string;
		if (p.projectId !== undefined && p.projectId !== null) {
			throw badParams("A Smolt chat stays in the folder it was started in; it can't be moved to another project");
		}
		const starred = bool(p, "starred");
		if (starred !== undefined) {
			this.state.starred = this.state.starred.filter((x) => x !== conversationId);
			if (starred) this.state.starred.push(conversationId);
			this.save();
		}
		const title = str(p, "title", { optional: true, allowEmpty: true });
		const model = str(p, "model", { optional: true });
		if ((title !== undefined && title.trim() !== "") || model !== undefined) {
			// Smolt names and sets the model of the chat that is open, so open it first (as its own
			// Rename does for a chat that isn't).
			await this.moving(async () => {
				await this.ensureActive(sessionPath);
				if (title !== undefined && title.trim() !== "") await this.client.call("setSessionName", title.trim());
				if (model !== undefined) {
					if (!(await this.models()).some((m) => m.id === model)) throw badParams(`Unknown model ${model}`);
					const [provider, modelId] = splitModel(model);
					await this.client.call("setModel", provider, modelId, false);
				}
			});
			await this.refreshActive(true);
			await this.refreshRows().catch(() => undefined);
		}
		const view = this.view(conversationId);
		this.hub.broadcast("conversation.updated", { conversation: view });
		return view;
	}

	async deleteConversation(id: unknown): Promise<void> {
		const sessionPath = await this.pathOf(id);
		const conversationId = id as string;
		const r = await this.client.invoke<{ ok?: boolean; error?: string }>("app:session-delete", sessionPath);
		if (!r?.ok) throw new DesktopError(r?.error ?? "Smolt couldn't delete that chat");
		// As the desktop does when the open chat is deleted: start a new one.
		if (this.active?.path === sessionPath)
			await this.moving(() => this.client.call("newSession")).catch(() => undefined);
		this.rows.delete(conversationId);
		delete this.state.paths[conversationId];
		this.state.starred = this.state.starred.filter((x) => x !== conversationId);
		this.save();
		this.hub.broadcast("conversation.deleted", { id: conversationId });
	}

	async setLeaf(id: unknown, _leafId: unknown): Promise<Conversation> {
		// A Smolt session is one line; there are no sibling branches to flip between.
		await this.pathOf(id);
		return this.view(id as string);
	}

	async openConversation(id: unknown): Promise<string> {
		const sessionPath = await this.pathOf(id);
		// Follows desktop: opening a chat on the phone opens it on the PC. Not awaited: the switch
		// takes a second or two and the phone's subscribe should not.
		void this.moving(() => this.ensureActive(sessionPath)).catch((err) =>
			this.logFailure("couldn't open the chat on the desktop", err),
		);
		return id as string;
	}

	// ---------------------------------------------------------------- §4.4 Projects (Smolt's project folders)

	private projectIdOf(folder: string): string {
		const id = `prj_${crypto.createHash("sha256").update(folder).digest("hex").slice(0, 24)}`;
		if (this.state.projects[id] !== folder) {
			this.state.projects[id] = folder;
			this.save();
		}
		return id;
	}

	private async projectPath(id: unknown): Promise<string> {
		if (typeof id !== "string") throw notFound("Project");
		if (!this.state.projects[id]) await this.refreshProjectFolders().catch(() => undefined);
		const folder = this.state.projects[id];
		if (!folder) throw notFound("Project");
		return folder;
	}

	/** The open folder first, then the recent ones: what the desktop's project menu lists. */
	private async refreshProjectFolders(): Promise<string[]> {
		const [open, recent] = await Promise.all([
			this.client.invoke<string[]>("app:folders").catch(() => [] as string[]),
			this.client.invoke<string[]>("app:recent-projects").catch(() => [] as string[]),
		]);
		const folders = [
			...new Set([...(open ?? []), ...(recent ?? [])].filter((f) => typeof f === "string" && f !== "")),
		];
		this.projectFolders = folders;
		for (const f of folders) this.projectIdOf(f);
		return folders;
	}

	private projectView(folder: string): Project {
		const id = this.projectIdOf(folder);
		const rows = [...this.rows.values()].filter((r) => r.cwd === folder);
		return {
			id,
			name: path.basename(folder) || folder,
			description: folder,
			instructions: "",
			starred: this.state.starredProjects.includes(id),
			createdAt: rows.reduce((t, r) => Math.min(t, r.created), rows[0]?.created ?? 0),
			updatedAt: rows.reduce((t, r) => Math.max(t, r.lastActive), 0),
			files: [],
			conversationCount: rows.length,
		};
	}

	readonly projects: ProjectsApi = {
		list: async () => {
			const folders = await this.refreshProjectFolders();
			await this.refreshRows().catch(() => undefined);
			return folders.map((f) => this.projectView(f));
		},
		get: async (id) => {
			const folder = await this.projectPath(id);
			return this.projectView(folder);
		},
		update: async (id, p) => {
			const folder = await this.projectPath(id);
			if (["name", "description", "instructions"].some((k) => p[k] !== undefined && p[k] !== null)) {
				throw new RpcError(
					ErrorCode.MethodNotFound,
					"A Smolt project is a folder: rename or move it on the computer",
				);
			}
			const starred = bool(p, "starred");
			if (starred !== undefined) {
				const pid = this.projectIdOf(folder);
				this.state.starredProjects = this.state.starredProjects.filter((x) => x !== pid);
				if (starred) this.state.starredProjects.push(pid);
				this.save();
			}
			const project = this.projectView(folder);
			this.hub.broadcast("project.updated", { project });
			return project;
		},
		create: async () => {
			throw new RpcError(ErrorCode.MethodNotFound, "Open a folder in Smolt to add a project");
		},
		delete: async () => {
			throw new RpcError(
				ErrorCode.MethodNotFound,
				"Smolt's projects are folders; they can't be deleted from the phone",
			);
		},
		addFile: async () => {
			throw new RpcError(
				ErrorCode.MethodNotFound,
				"Smolt's projects are folders; put files in the folder on the computer",
			);
		},
		removeFile: async () => {
			throw new RpcError(ErrorCode.MethodNotFound, "Smolt's projects are folders; remove files on the computer");
		},
	};

	// ---------------------------------------------------------------- §4.3 Chat

	/** Text and images for Smolt's prompt. Smolt takes images only; small text files go into the text. */
	private promptParts(
		text: string,
		fileIds: unknown[],
	): { text: string; images: { type: "image"; data: string; mimeType: string }[] } {
		const images: { type: "image"; data: string; mimeType: string }[] = [];
		const docs: string[] = [];
		for (const fileId of fileIds) {
			const f = this.store.fileMeta(fileId);
			const bytes = this.store.readBlob(f.id);
			if (f.kind === "image") {
				images.push({ type: "image", data: bytes.toString("base64"), mimeType: f.mimeType });
			} else if (isTextual(f.mimeType, f.name) && bytes.length <= INLINE_DOCUMENT_LIMIT) {
				docs.push(`<file name="${f.name.replace(/"/g, "'")}">\n${bytes.toString("utf8")}\n</file>`);
			} else {
				throw badParams(
					`Smolt can't take "${f.name}": it accepts images, and text files up to ${INLINE_DOCUMENT_LIMIT / 1024} KB (they go into the message). Send PDFs and other documents as text or save them in the project folder.`,
				);
			}
		}
		return { text: docs.length > 0 ? [text, ...docs].filter(Boolean).join("\n\n") : text, images };
	}

	/** Apply a model / thinking level chosen on the phone to the chat that is open now. */
	private async applyChoices(model: string | undefined, thinkingLevel: string | undefined) {
		const active = await this.refreshActive();
		if (model !== undefined && model !== active.model) {
			if (!(await this.models()).some((m) => m.id === model)) throw badParams(`Unknown model ${model}`);
			const [provider, id] = splitModel(model);
			await this.client.call("setModel", provider, id, false);
		}
		if (thinkingLevel !== undefined && thinkingLevel !== active.thinking) {
			await this.client.call("setThinkingLevel", thinkingLevel, false);
		}
		if (model !== undefined || thinkingLevel !== undefined) await this.refreshActive(true);
	}

	private assertIdle(conversationId: string) {
		if (this.isBusy(conversationId)) throw new RpcError(ErrorCode.Busy, "This conversation is already generating");
	}

	/** Fork the open chat just before one of its user messages: Smolt's way to edit or retry. */
	private async forkBefore(conversationId: string, messages: Message[], raw: Raw[], userMessageId: string) {
		const users = messages.filter((m) => m.role === "user");
		const rawUsers = raw.filter((m) => m.role === "user");
		const at = users.findIndex((m) => m.id === userMessageId);
		if (at < 0) throw notFound("Message");
		const target = rawUsers[at];
		// The agent lists the user messages that have text, in file order (getUserMessagesForForking).
		const forkable = (await this.client.call<{ entryId: string; text: string }[]>("getForkMessages")) ?? [];
		const withText = rawUsers.filter((m) => textOf(m.content) !== "");
		const text = textOf(target.content);
		let entry = forkable[withText.indexOf(target)];
		if (!entry || entry.text !== text) entry = forkable.filter((f) => f.text === text).at(-1) ?? entry;
		if (!entry)
			throw new RpcError(
				ErrorCode.Upstream,
				"Smolt couldn't find that message to branch from (was the chat compacted?)",
			);
		const r = await this.client.call<{ text?: string; cancelled?: boolean }>("fork", entry.entryId);
		if (r?.cancelled) throw new RpcError(ErrorCode.Upstream, "Smolt didn't branch (an extension cancelled it)");
		const before = conversationId;
		const now = await this.refreshActive(true);
		if (now.conversationId === before) throw new RpcError(ErrorCode.Upstream, "Smolt didn't move to the branch");
		return { raw: target };
	}

	/** Send a prompt into the open chat, with the ids promised to the phone. */
	private async prompt(text: string, images: unknown[], conn: Conn, after: (fn: () => void) => void) {
		const pending: PendingSend = {
			userId: newId("msg"),
			assistantId: newId("msg"),
			conn,
			createdAt: Date.now(),
			hold: true,
			queue: [],
		};
		const release = () => {
			pending.hold = false;
			for (const send of pending.queue.splice(0)) send();
		};
		this.pending = pending;
		try {
			// "steer" as the desktop's composer sends it: an idle agent simply starts a turn.
			await this.client.call("prompt", text, images, "steer");
			const active = await this.refreshActive(true);
			conn.subscriptions.add(active.conversationId);
			if (!this.rows.has(active.conversationId)) {
				await this.refreshRows().catch(() => undefined);
				this.announce(active.conversationId);
			}
			after(release);
			return { conversationId: active.conversationId, pending };
		} catch (err) {
			if (this.pending === pending) this.pending = undefined;
			release();
			throw err;
		}
	}

	async send(p: Params, { conn, after }: CallCtx): Promise<SendResult> {
		const text = str(p, "text", { optional: true, allowEmpty: true }) ?? "";
		const fileIds: unknown[] = Array.isArray(p.attachments) ? p.attachments : [];
		const parts = this.promptParts(text, fileIds);
		if (!parts.text.trim() && parts.images.length === 0) throw badParams("text is required");
		const model = str(p, "model", { optional: true });
		const thinkingLevel =
			typeof p.options?.thinkingLevel === "string" ? (p.options.thinkingLevel as string) : undefined;

		const deliver =
			p.options?.deliver === "steer" || p.options?.deliver === "follow_up"
				? (p.options.deliver as string)
				: undefined;
		if (p.conversationId && deliver && this.isBusy(String(p.conversationId))) {
			return this.steer(String(p.conversationId), parts, deliver === "steer" ? "steer" : "followUp");
		}

		return this.moving(async () => {
			if (p.conversationId) {
				const conversationId = String(p.conversationId);
				const sessionPath = await this.pathOf(conversationId);
				this.assertIdle(conversationId);
				await this.ensureActive(sessionPath);
				if (p.parentId !== undefined && p.parentId !== null) {
					// An edit: a new message replying to `parentId` rather than to the last message. Smolt
					// branches by forking into a new session, just before the message being replaced.
					const { messages, raw } = await this.transcript(conversationId, sessionPath);
					const leaf = messages.at(-1)?.id;
					if (p.parentId !== leaf) {
						const after = p.parentId === "" ? 0 : messages.findIndex((m) => m.id === p.parentId) + 1;
						if (p.parentId !== "" && after === 0) throw notFound("Message");
						const replaced = messages.slice(after).find((m) => m.role === "user");
						if (!replaced) throw notFound("Message");
						await this.forkBefore(conversationId, messages, raw, replaced.id);
					}
				}
			} else if (p.projectId) {
				await this.newChatIn(await this.projectPath(p.projectId));
			} else {
				await this.newChat();
			}
			await this.applyChoices(model, thinkingLevel);
			const { conversationId, pending } = await this.prompt(parts.text, parts.images, conn, after);
			return { conversationId, userMessageId: pending.userId, assistantMessageId: pending.assistantId };
		});
	}

	/** A new chat, as the desktop's New chat does. */
	private async newChat() {
		const r = await this.client.call<{ cancelled?: boolean } | undefined>("newSession");
		if (r?.cancelled)
			throw new RpcError(ErrorCode.Upstream, "Smolt didn't start a new chat (an extension cancelled it)");
		await this.refreshActive(true);
	}

	/** A new chat in a project folder: open the folder (Smolt restarts its agent there, with a fresh chat), as its project menu does. */
	private async newChatIn(folder: string) {
		const open = (await this.client.invoke<string[]>("app:folders").catch(() => [] as string[])) ?? [];
		if (open[0] === folder) return this.newChat();
		const r = await this.client.invoke<{ ok?: boolean; error?: string }>("app:open-project", folder);
		if (!r?.ok) throw new DesktopError(r?.error ?? "Smolt couldn't open that folder");
		// The agent restarts in the folder; agent calls wait for it.
		await this.refreshActive(true);
	}

	/** Add a message to the reply in progress: "steer" at the next step, "followUp" when it ends. */
	private async steer(
		conversationId: string,
		parts: { text: string; images: unknown[] },
		behavior: "steer" | "followUp",
	): Promise<SendResult> {
		const sessionPath = await this.pathOf(conversationId);
		return this.moving(async () => {
			// Into the agent that is running it: a chat working in the background is brought into view.
			await this.ensureActive(sessionPath);
			const id = newId("msg");
			this.steers = this.steers.filter((x) => Date.now() - x.at < 10 * 60_000);
			this.steers.push({ conversationId, text: parts.text, id, at: Date.now() });
			try {
				await this.client.call("prompt", parts.text, parts.images, behavior);
			} catch (err) {
				this.steers = this.steers.filter((x) => x.id !== id);
				throw err;
			}
			return { conversationId, userMessageId: id, assistantMessageId: "" };
		});
	}

	async retry(p: Params, { conn, after }: CallCtx): Promise<RetryResult> {
		const conversationId = String(p.conversationId ?? "");
		const sessionPath = await this.pathOf(conversationId);
		const model = str(p, "model", { optional: true });
		return this.moving(async () => {
			this.assertIdle(conversationId);
			await this.ensureActive(sessionPath);
			const { messages, raw } = await this.transcript(conversationId, sessionPath);
			const old = messages.find((m) => m.id === p.messageId);
			if (!old) throw notFound("Message");
			if (old.role !== "assistant" || !old.parentId) throw badParams("messageId must be an assistant message");
			// Smolt has no regenerate: branch just before the user message and send it again.
			const { raw: user } = await this.forkBefore(conversationId, messages, raw, old.parentId);
			await this.applyChoices(model, undefined);
			let text = textOf(user.content);
			const images = imagesOf(user.content).map((img) => ({ type: "image" as const, ...img }));
			if (images.length > 0 && text.trim() === IMAGE_ONLY_TEXT) text = "";
			const sent = await this.prompt(text, images, conn, after);
			return { assistantMessageId: sent.pending.assistantId, conversationId: sent.conversationId };
		});
	}

	async stop(conversationId: unknown): Promise<void> {
		const sessionPath = await this.pathOf(conversationId);
		if (!this.isBusy(conversationId as string)) return;
		await this.moving(async () => {
			// Abort goes to the agent in view; a chat working in the background is brought into view first.
			await this.ensureActive(sessionPath);
			await this.client.call("abort");
		});
	}

	async feedback(p: Params): Promise<void> {
		await this.pathOf(p.conversationId);
		const id = String(p.messageId ?? "");
		if (!id) throw badParams("messageId is required");
		if (p.rating === null || p.rating === undefined) delete this.state.feedback[id];
		else if (p.rating === "up" || p.rating === "down") this.state.feedback[id] = p.rating;
		else throw badParams('rating must be "up", "down" or null');
		this.save();
	}
}

// ---------------------------------------------------------------- small helpers

function splitModel(model: string): [string, string] {
	const at = model.indexOf("/");
	if (at <= 0) throw badParams(`Unknown model ${model} (expected provider/id)`);
	return [model.slice(0, at), model.slice(at + 1)];
}

/** packages/ai/src/models.ts getSupportedThinkingLevels, from the model record. */
function supportedLevels(m: Raw): string[] {
	if (m.reasoning !== true) return ["off"];
	const map = (m.thinkingLevelMap ?? {}) as Record<string, unknown>;
	return LEVELS.filter((level) => {
		const mapped = map[level];
		if (mapped === null) return false;
		if (level === "xhigh" || level === "max") return mapped !== undefined;
		return true;
	});
}

function isTextual(mimeType: string, name: string): boolean {
	if (mimeType.startsWith("text/")) return true;
	if (/^application\/(json|xml|yaml|x-yaml|javascript|typescript|x-sh|toml|x-toml|sql|graphql)/.test(mimeType))
		return true;
	return /\.(md|markdown|txt|json|ya?ml|toml|csv|tsv|xml|html?|css|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|sh|ps1|bat|sql|ini|cfg|conf|log)$/i.test(
		name,
	);
}
