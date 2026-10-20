// A stand-in for the Smolt desktop's main process, for test/mobile-bridge.test.ts: the IPC
// handlers the iPhone bridge calls (as a map of channels) and the messages the window is sent
// (webContents.send, fanned out to subscribers), with the shapes main.ts / agent-bridge.ts /
// rpc-mode.ts produce. It is driven through the same DesktopTransport the app builds in-process
// (ipc-tap.ts inProcessTransport). Agent turns replay fixtures/smolt-rpc-turn.jsonl, a turn
// recorded from the real `smolt --mode rpc` (thinking, text, a bash tool call, its result, a
// second request), re-stamped.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DesktopTransport } from "../src/main/mobile/transport.ts";

type Raw = Record<string, any>;
type Entry = { id: string; message: Raw };
type Session = {
	id: string;
	path: string;
	cwd: string;
	name?: string;
	created: number;
	lastActive: number;
	parent: string;
	entries: Entry[];
	/** Smolt writes a new session's file with its first assistant message (forks at once). */
	written: boolean;
};

const FIXTURE = fs
	.readFileSync(path.join(import.meta.dirname, "fixtures", "smolt-rpc-turn.jsonl"), "utf8")
	.split("\n")
	.filter(Boolean)
	.map((l) => JSON.parse(l) as Raw);

const SESSIONS_DIR = "/Users/test/.smolt/agent/sessions";
const PID = 4242;

const usage = {
	input: 10,
	output: 5,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 15,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** A few models as get_available_models returns them (full Model records). */
export const MODELS: Raw[] = [
	{
		id: "claude-opus-5-5",
		name: "Claude Opus 5.5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		thinkingLevelMap: { minimal: null, xhigh: "xhigh", max: "max" },
		input: ["text", "image"],
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		contextWindow: 1000000,
		maxTokens: 128000,
	},
	{
		id: "claude-haiku-4-5",
		name: "Claude Haiku 4.5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
		contextWindow: 200000,
		maxTokens: 64000,
	},
	{
		id: "fake-1",
		name: "Fake One",
		api: "openai-completions",
		provider: "fake",
		baseUrl: "http://127.0.0.1:7399/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	},
	{
		// A provider with a key in the environment but not set up in Smolt: the desktop hides it.
		id: "gpt-x",
		name: "GPT X",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 128000,
	},
];

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
function supportedLevels(m: Raw): string[] {
	if (!m.reasoning) return ["off"];
	return LEVELS.filter((l) => {
		const v = m.thinkingLevelMap?.[l];
		if (v === null) return false;
		if (l === "xhigh" || l === "max") return v !== undefined;
		return true;
	});
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const entryId = () => crypto.randomBytes(4).toString("hex");
const textOf = (content: unknown) =>
	typeof content === "string"
		? content
		: Array.isArray(content)
			? content
					.filter((b) => b?.type === "text")
					.map((b) => b.text)
					.join("")
			: "";

/** A 2×2 PNG. */
export const TINY_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAAAAABX3VL4AAAADklEQVR4nGNgYGBgYAAAAAUAAWmvYlwAAAAASUVORK5CYII=";

type Turn = { slot: number; session: Session; abort: AbortController; queue: { text: string; behavior: string }[] };

export class FakeSmoltDesktop {
	readonly sessions = new Map<string, Session>();
	/** Every /invoke, in order. */
	readonly invokes: { channel: string; args: any[] }[] = [];
	readonly agentCalls: { method: string; args: any[] }[] = [];
	model: Raw = MODELS[0];
	thinking = "medium";
	permissionMode = "auto";
	folders = ["/work/smolt-mobile"];
	recent = ["/work/smolt-mobile", "/work/website"];
	slot = 1;
	activePath = "";
	turn: Turn | undefined;
	approvals = new Map<string, Raw & { reply?: (answer: string) => void }>();
	uiWaits = new Map<string, (body: Raw) => void>();
	private listeners = new Set<(channel: string, args: unknown[]) => void>();
	private nextSlot = 2;
	private approvalCounter = 0;

	constructor() {
		this.seed();
	}

	// ---------------------------------------------------------------- seed data

	private newSessionRecord(cwd: string, at: number, parent = ""): Session {
		const id = crypto.randomUUID();
		const stamp = new Date(at).toISOString().replace(/[:.]/g, "-");
		const dir = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
		const s: Session = {
			id,
			path: `${SESSIONS_DIR}/${dir}/${stamp}_${id}.jsonl`,
			cwd,
			created: at,
			lastActive: at,
			parent,
			entries: [],
			written: false,
		};
		this.sessions.set(s.path, s);
		return s;
	}

	private seed() {
		const t0 = Date.now() - 3 * 86_400_000;
		const a = this.newSessionRecord("/work/smolt-mobile", t0);
		a.name = "Fix the login bug";
		const assistant = (ts: number, content: Raw[], stopReason = "stop") => ({
			role: "assistant",
			content,
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-opus-5-5",
			usage,
			stopReason,
			timestamp: ts,
		});
		a.entries.push(
			{
				id: entryId(),
				message: {
					role: "user",
					content: [
						{ type: "text", text: "Why does login fail? Screenshot attached." },
						{ type: "image", data: TINY_PNG, mimeType: "image/png" },
					],
					timestamp: t0 + 1000,
				},
			},
			{
				id: entryId(),
				message: assistant(
					t0 + 2000,
					[
						{ type: "thinking", thinking: "The token check looks wrong.", thinkingSignature: "sig" },
						{ type: "text", text: "Let me look at the auth module." },
						{ type: "toolCall", id: "toolu_01", name: "read", arguments: { path: "src/auth.ts" } },
					],
					"toolUse",
				),
			},
			{
				id: entryId(),
				message: {
					role: "toolResult",
					toolCallId: "toolu_01",
					toolName: "read",
					content: [{ type: "text", text: "export function check() { return false }" }],
					isError: false,
					timestamp: t0 + 3000,
				},
			},
			{
				id: entryId(),
				message: assistant(t0 + 4000, [{ type: "text", text: "Fixed: `check()` always returned false." }]),
			},
		);
		a.written = true;
		a.lastActive = t0 + 4000;

		const t1 = Date.now() - 3_600_000;
		const b = this.newSessionRecord("/work/website", t1);
		b.entries.push(
			{ id: entryId(), message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: t1 + 1000 } },
			{ id: entryId(), message: assistant(t1 + 2000, [{ type: "text", text: "Hi! What shall we build?" }]) },
		);
		b.written = true;
		b.lastActive = t1 + 2000;
		this.activePath = b.path;
	}

	get active(): Session {
		return this.sessions.get(this.activePath)!;
	}

	sessionByName(name: string): Session {
		return [...this.sessions.values()].find((s) => s.name === name)!;
	}

	// ---------------------------------------------------------------- the transport

	/** A channel that fails, as a handler that throws does. */
	broken: string | undefined;
	/** The agent is crashing: getState fails. */
	agentDown = false;

	/** What ipc-tap.ts inProcessTransport() is in the app: the handlers, called directly, and the window's messages. */
	transport(): DesktopTransport {
		return {
			invoke: async (channel, ...args) => {
				this.invokes.push({ channel, args });
				if (channel === this.broken) throw new Error(`${channel} is broken`);
				const value = await this.invoke(channel, args);
				if (value === NO_HANDLER) throw new Error(`no handler: ${channel}`);
				return value;
			},
			subscribe: (listener) => {
				this.listeners.add(listener);
				return () => {
					this.listeners.delete(listener);
				};
			},
		};
	}

	get subscribers(): number {
		return this.listeners.size;
	}

	/** webContents.send, as the window (and every mirror) gets it. */
	send(channel: string, ...args: unknown[]) {
		for (const listener of this.listeners) listener(channel, args);
	}

	// ---------------------------------------------------------------- ipcMain.handle channels

	private rows(query?: string) {
		const busy = this.turn ? this.turn.session.path : "";
		return [...this.sessions.values()]
			.filter((s) => s.written)
			.filter((s) => !query || JSON.stringify(s).toLowerCase().includes(query.toLowerCase()))
			.sort((a, b) => b.lastActive - a.lastActive)
			.slice(0, 50)
			.map((s) => {
				const firstUser = s.entries.find((e) => e.message.role === "user");
				return {
					path: s.path,
					id: s.id,
					cwd: s.cwd,
					title: s.name || "New session",
					preview: firstUser ? textOf(firstUser.message.content).slice(0, 120) : "",
					lastActive: s.lastActive,
					messageCount: s.entries.filter((e) => e.message.role === "user" || e.message.role === "assistant")
						.length,
					model: "anthropic/claude-opus-5-5",
					thinking: "medium",
					parent: s.parent,
					created: s.created,
					busy: s.path === busy,
					telegram: false,
				};
			});
	}

	private async invoke(channel: string, args: any[]): Promise<unknown> {
		switch (channel) {
			case "agent:call": {
				const [method, list] = args as [string, any[]];
				this.agentCalls.push({ method, args: list });
				try {
					if (method === "getState" && this.agentDown) {
						throw new Error("The agent process crashed with exit code 1. Last output:\n...");
					}
					return { ok: true, value: await this.agentCall(method, list ?? []) };
				} catch (err) {
					// main.ts puts the window back on its slot after every failed call: agent:attached.
					this.send("agent:attached", this.slot);
					return { ok: false, error: (err as Error).message };
				}
			}
			case "app:sessions":
				return this.rows(typeof args[0] === "string" && args[0].trim() ? args[0].trim() : undefined);
			case "app:session-messages": {
				const s = this.sessions.get(String(args[0]));
				if (!s || !s.written) return { messages: [], start: 0, userStart: 0 };
				return { messages: s.entries.map((e) => e.message), start: 0, userStart: 0 };
			}
			case "app:session-delete":
				if (!String(args[0]).startsWith(SESSIONS_DIR))
					return { ok: false, error: "Refusing to delete a path outside the sessions directory" };
				this.sessions.delete(String(args[0]));
				return { ok: true };
			case "app:active-slot":
				return this.slot;
			case "app:pending-approvals":
				return [...this.approvals.values()].map(({ reply: _r, ...rest }) => rest);
			case "app:permission-reply": {
				const a = this.approvals.get(String(args[0]));
				if (!a) return { ok: false, error: `No pending permission request "${args[0]}"` };
				a.reply?.(String(args[1]));
				return { ok: true };
			}
			case "app:providers-list":
				return [
					{ id: "anthropic", type: "api_key", pooled: true, pool: [] },
					{ id: "fake", type: "api_key", pooled: true, pool: [] },
				];
			case "app:permission-mode":
				if (typeof args[0] === "string") this.permissionMode = args[0];
				return { ok: true, value: this.permissionMode };
			case "app:folders":
				return this.folders;
			case "app:recent-projects":
				return this.recent;
			case "app:open-project": {
				const target = String(args[0]);
				this.folders = [target];
				this.recent = [target, ...this.recent.filter((r) => r !== target)];
				// restartAgentIn: a fresh agent in the folder, with a fresh session; announceActive only.
				this.slot = this.nextSlot++;
				this.activePath = this.newSessionRecord(target, Date.now()).path;
				setTimeout(() => {
					this.send("agent:attached", this.slot);
					this.send("agent:started", { running: true, error: null });
				}, 5);
				return { ok: true, value: target };
			}
			default:
				return NO_HANDLER;
		}
	}

	/** As if the person clicked a chat in Smolt's sidebar (or the browser did): main.ts switchToPath + announce. */
	pcSwitch(p: string) {
		this.activePath = p;
		if (this.turn && this.turn.session.path !== p) this.slot = this.nextSlot++;
		this.send("agent:attached", this.slot);
		this.send("session:changed", { slot: this.slot, path: p });
	}

	/** As if the person typed into Smolt's composer. */
	pcPrompt(text: string) {
		void this.agentCall("prompt", [text, [], "steer"]);
	}

	private async agentCall(method: string, a: any[]): Promise<unknown> {
		switch (method) {
			case "getState": {
				const s = this.active;
				return {
					model: this.model,
					thinkingLevel: this.thinking === "auto" ? "medium" : this.thinking,
					...(this.thinking === "auto" ? { activeThinkingEntry: "auto" } : {}),
					isStreaming: this.turn !== undefined,
					isCompacting: false,
					steeringMode: "one-at-a-time",
					followUpMode: "one-at-a-time",
					sessionFile: s.path,
					sessionId: s.id,
					...(s.name ? { sessionName: s.name } : {}),
					autoCompactionEnabled: true,
					showThroughput: false,
					messageCount: s.entries.length,
					pendingMessageCount: 0,
				};
			}
			case "getAvailableModels":
				return MODELS;
			case "getAvailableThinkingLevels":
				return ["auto", ...supportedLevels(this.model)];
			case "setModel": {
				const m = MODELS.find((x) => x.provider === a[0] && x.id === a[1]);
				if (!m) throw new Error(`Model not found: ${a[0]}/${a[1]}`);
				this.model = m;
				return m;
			}
			case "setThinkingLevel":
				this.thinking = String(a[0]);
				return undefined;
			case "switchSession": {
				if (!this.sessions.has(String(a[0]))) throw new Error(`Session not found: ${a[0]}`);
				this.pcSwitch(String(a[0]));
				return { cancelled: false };
			}
			case "newSession": {
				if (this.turn) this.slot = this.nextSlot++;
				const s = this.newSessionRecord(this.active?.cwd ?? "/work/smolt-mobile", Date.now());
				this.pcSwitch(s.path);
				return { cancelled: false };
			}
			case "getForkMessages":
				return this.active.entries
					.filter((e) => e.message.role === "user" && textOf(e.message.content) !== "")
					.map((e) => ({ entryId: e.id, text: textOf(e.message.content) }));
			case "fork": {
				const from = this.active;
				const at = from.entries.findIndex((e) => e.id === a[0]);
				if (at < 0) throw new Error(`Entry not found: ${a[0]}`);
				const s = this.newSessionRecord(from.cwd, Date.now(), from.path);
				s.name = from.name;
				s.entries = structuredClone(from.entries.slice(0, at));
				s.written = true; // a fork's file is written at once
				this.pcSwitch(s.path);
				return { text: textOf(from.entries[at].message.content), cancelled: false };
			}
			case "setSessionName":
				this.active.name = String(a[0]);
				this.send("agent:event", { type: "session_info_changed", name: String(a[0]) }, this.slot);
				return undefined;
			case "abort":
				this.turn?.abort.abort();
				return undefined;
			case "respondExtensionUI": {
				const body = a[0] as Raw;
				this.uiWaits.get(String(body.id))?.(body);
				this.uiWaits.delete(String(body.id));
				return undefined;
			}
			case "prompt": {
				const [text, images, behavior] = a as [string, Raw[] | undefined, string | undefined];
				if (text.includes("nokey")) throw new Error("No API key found for the selected model.");
				if (this.turn) {
					this.turn.queue.push({ text, behavior: behavior ?? "steer" });
					return undefined;
				}
				const turn: Turn = { slot: this.slot, session: this.active, abort: new AbortController(), queue: [] };
				this.turn = turn;
				setTimeout(() => void this.runTurn(turn, text, images ?? []), 5);
				return undefined;
			}
			default:
				throw new Error(`Unknown method: ${method}`);
		}
	}

	// ---------------------------------------------------------------- scripted turns

	private ev(turn: Turn, event: Raw) {
		// main.ts forwards only the slot in view, except dialogs (an agent waiting on an answer).
		if (turn.slot !== this.slot && event.type !== "extension_ui_request") return;
		this.send("agent:event", event, turn.slot);
	}

	/** Smolt persists every message at its message_end; a new session's file appears with its first assistant message. */
	private persist(turn: Turn, message: Raw) {
		turn.session.entries.push({ id: entryId(), message: structuredClone(message) });
		turn.session.lastActive = Date.now();
		if (message.role === "assistant") turn.session.written = true;
	}

	private stamp(m: Raw, ts: number): Raw {
		return { ...m, provider: this.model.provider, model: this.model.id, api: this.model.api, timestamp: ts };
	}

	private async runTurn(turn: Turn, text: string, images: Raw[]) {
		const s = turn.session;
		this.ev(turn, { type: "agent_start" });
		this.send("agent:busy", [s.path]);
		this.ev(turn, { type: "turn_start" });
		const user = {
			role: "user",
			content: [{ type: "text", text: text || "The user has provided an image with this message" }, ...images],
			timestamp: Date.now(),
		};
		this.ev(turn, { type: "message_start", message: user });
		this.persist(turn, user);
		this.ev(turn, { type: "message_end", message: user });
		try {
			if (/\bslow\b/.test(text)) await this.slowTurn(turn);
			else if (/\bapprove\b/.test(text)) await this.approveTurn(turn);
			else if (/\bask\b/.test(text)) await this.askTurn(turn);
			else await this.replayFixture(turn);
		} finally {
			this.ev(turn, { type: "agent_end", messages: [], willRetry: false });
			// main.ts marks the slot idle and broadcasts agent:busy before it forwards agent_settled.
			if (this.turn === turn) this.turn = undefined;
			this.send("agent:busy", []);
			this.ev(turn, { type: "agent_settled" });
			if (turn.slot !== this.slot) this.send("agent:background-settled", { sessionPath: s.path });
		}
	}

	/** The recorded turn: thinking + text + bash tool call, the tool run, then a second request. */
	private async replayFixture(turn: Turn, toolOutput?: string) {
		const offsets = new Map<number, number>();
		for (const raw of FIXTURE) {
			const e = structuredClone(raw);
			if (["agent_start", "agent_end", "agent_settled", "turn_start"].includes(e.type)) continue;
			if (e.message?.role === "user") continue; // our own prompt was sent above
			if (e.type === "turn_end") continue;
			if (e.message && typeof e.message.timestamp === "number") {
				if (!offsets.has(e.message.timestamp)) offsets.set(e.message.timestamp, Date.now());
				e.message =
					e.message.role === "assistant"
						? this.stamp(e.message, offsets.get(e.message.timestamp)!)
						: { ...e.message, timestamp: offsets.get(e.message.timestamp) };
				if (toolOutput && e.message.role === "toolResult") e.message.content = [{ type: "text", text: toolOutput }];
			}
			if (toolOutput && e.type === "tool_execution_end")
				e.result = { content: [{ type: "text", text: toolOutput }] };
			this.ev(turn, e);
			if (e.type === "message_end") this.persist(turn, e.message);
			await sleep(3);
		}
	}

	private async streamText(turn: Turn, text: string, ts = Date.now()): Promise<Raw> {
		const partial = this.stamp({ role: "assistant", content: [], usage, stopReason: "pending" }, ts);
		this.ev(turn, { type: "message_start", message: partial });
		this.ev(turn, { type: "message_update", usage, assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
		for (const piece of text.match(/\s*\S+/g) ?? []) {
			this.ev(turn, {
				type: "message_update",
				usage,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: piece },
			});
			await sleep(2);
		}
		this.ev(turn, {
			type: "message_update",
			usage,
			assistantMessageEvent: { type: "text_end", contentIndex: 0, content: text },
		});
		const done = { ...partial, content: [{ type: "text", text }], stopReason: "stop" };
		this.ev(turn, { type: "message_end", message: done });
		this.persist(turn, done);
		return done;
	}

	/** A long reply, slow enough to stop or steer. */
	private async slowTurn(turn: Turn) {
		const ts = Date.now();
		const partial = this.stamp({ role: "assistant", content: [], usage, stopReason: "pending" }, ts);
		this.ev(turn, { type: "message_start", message: partial });
		this.ev(turn, { type: "message_update", usage, assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
		let text = "";
		for (let i = 0; i < 400; i++) {
			if (turn.abort.signal.aborted) {
				const aborted = {
					...partial,
					content: [{ type: "text", text }],
					stopReason: "aborted",
					errorMessage: "Request was aborted",
				};
				this.ev(turn, { type: "message_end", message: aborted });
				this.persist(turn, aborted);
				return;
			}
			const steer = turn.queue.shift();
			if (steer) {
				// The message is taken at the next step: this request ends, the steered message follows, then a new request.
				const ended = { ...partial, content: [{ type: "text", text }], stopReason: "stop" };
				this.ev(turn, {
					type: "message_update",
					usage,
					assistantMessageEvent: { type: "text_end", contentIndex: 0, content: text },
				});
				this.ev(turn, { type: "message_end", message: ended });
				this.persist(turn, ended);
				const u = { role: "user", content: [{ type: "text", text: steer.text }], timestamp: Date.now() };
				this.ev(turn, { type: "message_start", message: u });
				this.persist(turn, u);
				this.ev(turn, { type: "message_end", message: u });
				await this.streamText(turn, `Got it: ${steer.text}`);
				return;
			}
			const piece = `word${i} `;
			text += piece;
			this.ev(turn, {
				type: "message_update",
				usage,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: piece },
			});
			await sleep(15);
		}
		const done = { ...partial, content: [{ type: "text", text }], stopReason: "stop" };
		this.ev(turn, { type: "message_end", message: done });
		this.persist(turn, done);
	}

	/** Smolt's permissions extension asks before a destructive command (approvals.ts request files). */
	private async approveTurn(turn: Turn) {
		// The model's request (and its tool call) has ended before the tool_call hook asks.
		await this.streamText(turn, "I'll clean up the build folder.");
		const id = `${PID}-${++this.approvalCounter}`;
		const answer = await new Promise<string>((resolve) => {
			const request = {
				id,
				tool: "bash",
				summary: "rm -rf build",
				mode: "auto",
				danger: "a recursive force delete",
				createdAt: Date.now(),
				slot: turn.slot,
				session: turn.session.path,
			};
			this.approvals.set(id, { ...request, reply: resolve });
			this.send("permission:request", request);
		});
		this.approvals.delete(id);
		this.send("permission:removed", id);
		if (answer === "deny") await this.streamText(turn, "Okay, I won't delete the build folder.");
		else await this.replayFixture(turn, "removed build/");
	}

	/** An extension dialog mid-turn (extension_ui_request confirm), answered with respondExtensionUI. */
	private async askTurn(turn: Turn) {
		const id = crypto.randomUUID();
		const answer = await new Promise<Raw>((resolve) => {
			this.uiWaits.set(id, resolve);
			this.ev(turn, {
				type: "extension_ui_request",
				id,
				method: "confirm",
				title: "Deploy now?",
				message: "This pushes to production.",
				timeout: 60000,
			});
		});
		await this.streamText(turn, answer.cancelled ? "Cancelled." : `confirmed: ${answer.confirmed === true}`);
	}
}

const NO_HANDLER = Symbol("no handler");
