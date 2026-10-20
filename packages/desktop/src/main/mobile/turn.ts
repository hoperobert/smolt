// One live turn in Smolt, translated into protocol stream events (§5.1).
//
// Smolt's agent emits (packages/agent/src/types.ts AgentEvent + coding-agent's AgentSessionEvent,
// sent through modes/json-event.ts, which strips the cumulative `partial`):
//   agent_start
//   message_start {message: user}            the prompt (and any message steered in mid-turn)
//   message_start {message: assistant}       one per model request
//   message_update {assistantMessageEvent}   text_/thinking_/toolcall_ start|delta|end, by contentIndex
//   message_end {message: assistant}         the authoritative message, with stopReason
//   tool_execution_start|update|end          tools run after the request that called them
//   message_start/end {message: toolResult}
//   … more requests while the model calls tools …
//   agent_end, agent_settled                 the turn is over (agent_settled also after auto-retries)
//
// The phone gets one assistant Message for the whole turn, as the desktop shows it
// (packages/desktop/src/renderer/store.ts). Block indexes are the phone's: each Smolt request's
// contentIndex maps onto the next free protocol index. *_end events arrive late (Smolt ends all
// blocks of a request together), so blocks are started and stopped by index, not strictly in turn.
// A tool_use block stops once at toolcall_end (status "running") and again, with its final status,
// when the tool finishes; a tool_result block follows it.

import type { Block, BlockDelta, Message, MessageStatus, StreamEvent, ToolUseBlock } from "./protocol.ts";
import { modelOf, type Raw, readableError, statusOf, textOf, toolOutput, toolTitle } from "./transcript.ts";

const isObj = (v: unknown): v is Raw => typeof v === "object" && v !== null;

export type TurnIds = {
	/** Protocol id for the user message with this Smolt timestamp and text. */
	user(timestamp: number, text: string): string;
	/** Protocol id for the assistant message whose first request has this Smolt timestamp. */
	assistant(timestamp: number): string;
};

export type TurnSink = {
	/** A stream.event for this turn's conversation. */
	emit(messageId: string, seq: number, event: StreamEvent): void;
	/** Whether to stream this user message to the phone: yes, unless the phone shows it already (it sent it). */
	announceUser(id: string): boolean;
	/** Build the protocol user message (images become attachments). */
	userMessage(raw: Raw, id: string, parentId: string | undefined): Message;
};

export class LiveTurn {
	readonly conversationId: string;
	readonly slot: number | undefined;
	readonly path: string;
	readonly startedAt = Date.now();
	user: Message | undefined;
	assistant: Message | undefined;
	/** Id of the message the next one replies to. */
	private leaf: string | undefined;
	/** The stored transcript when the turn began (it may already hold this turn's first messages). */
	private history: Message[];
	private seq = 0;
	private ids: TurnIds;
	private sink: TurnSink;
	/** contentIndex of the current request -> protocol block index. */
	private indexOf = new Map<number, number>();
	private partialJson = new Map<number, string>();
	private thinkingStart = new Map<number, number>();
	private toolIndex = new Map<string, number>();
	private lastStop: unknown;
	private lastError: string | undefined;

	constructor(opts: {
		conversationId: string;
		slot?: number;
		path: string;
		history: Message[];
		ids: TurnIds;
		sink: TurnSink;
	}) {
		this.conversationId = opts.conversationId;
		this.slot = opts.slot;
		this.path = opts.path;
		this.history = opts.history;
		this.ids = opts.ids;
		this.sink = opts.sink;
	}

	get isOpen(): boolean {
		return this.assistant !== undefined;
	}

	/** The last seq folded into the assistant snapshot. */
	get snapshot(): Message | undefined {
		return this.assistant ? { ...structuredClone(this.assistant), seq: this.seq } : undefined;
	}

	private emit(event: StreamEvent) {
		if (!this.assistant) return;
		this.sink.emit(this.assistant.id, ++this.seq, event);
	}

	/** Feed one Smolt agent event. Returns true when the turn is over. */
	handle(ev: Raw): boolean {
		switch (ev.type) {
			case "message_start": {
				const m = isObj(ev.message) ? ev.message : {};
				if (m.role === "user") this.onUser(m);
				else if (m.role === "assistant") this.onAssistantStart(m);
				return false;
			}
			case "message_update": {
				const d = isObj(ev.assistantMessageEvent) ? ev.assistantMessageEvent : undefined;
				if (d) this.onDelta(d);
				return false;
			}
			case "message_end": {
				const m = isObj(ev.message) ? ev.message : {};
				if (m.role === "assistant") this.onAssistantEnd(m);
				return false;
			}
			case "tool_execution_end":
				this.onToolEnd(String(ev.toolCallId ?? ""), ev.result, ev.isError === true);
				return false;
			case "agent_settled":
				this.finish();
				return true;
			default:
				return false;
		}
	}

	private onUser(m: Raw) {
		// A message steered in mid-turn starts a new exchange: close the reply it interrupted.
		if (this.assistant) this.closeAssistant("complete");
		const ts = typeof m.timestamp === "number" ? m.timestamp : Date.now();
		const user = this.sink.userMessage(m, this.ids.user(ts, textOf(m.content)), this.leaf ?? this.parentBefore(ts));
		this.user = user;
		this.leaf = user.id;
		if (this.sink.announceUser(user.id)) {
			// Not sent from this phone: show it like a reply that arrives complete at once.
			this.sink.emit(user.id, 1, { type: "message_start", message: structuredClone(user) });
			this.sink.emit(user.id, 2, { type: "message_stop", status: "complete" });
		}
	}

	/** The last stored message older than `ts`: what a message of this turn replies to. */
	private parentBefore(ts: number): string | undefined {
		for (let i = this.history.length - 1; i >= 0; i--) if (this.history[i].createdAt < ts) return this.history[i].id;
		return undefined;
	}

	private ensureAssistant(m: Raw) {
		if (this.assistant) return;
		const ts = typeof m.timestamp === "number" ? m.timestamp : Date.now();
		const parentId = this.leaf ?? this.parentBefore(ts);
		this.assistant = {
			id: this.ids.assistant(ts),
			...(parentId ? { parentId } : {}),
			role: "assistant",
			createdAt: ts,
			model: modelOf(m),
			status: "streaming",
			content: [],
			attachments: [],
		};
		this.leaf = this.assistant.id;
		this.seq = 0;
		this.emit({ type: "message_start", message: structuredClone(this.assistant) });
	}

	private onAssistantStart(m: Raw) {
		this.ensureAssistant(m);
		// A new request numbers its content from 0 again. (Its initial content is ignored: the
		// deltas that follow repeat it.)
		this.indexOf = new Map();
		this.partialJson = new Map();
		this.thinkingStart = new Map();
	}

	private startBlock(ci: number, block: Block): number {
		const a = this.assistant!;
		const index = a.content.length;
		a.content.push(structuredClone(block));
		this.indexOf.set(ci, index);
		this.emit({ type: "block_start", index, block });
		return index;
	}

	/** The protocol index for a contentIndex, starting a block of the right kind if none is open. */
	private blockFor(ci: number, make: () => Block): number {
		const index = this.indexOf.get(ci);
		if (index !== undefined && this.assistant!.content[index]?.type === make().type) return index;
		return this.startBlock(ci, make());
	}

	private delta(index: number, delta: BlockDelta) {
		this.emit({ type: "block_delta", index, delta });
	}

	private stopBlock(index: number) {
		this.emit({ type: "block_stop", index, block: structuredClone(this.assistant!.content[index]) });
	}

	private onDelta(d: Raw) {
		if (!this.assistant) this.ensureAssistant({});
		const a = this.assistant!;
		const ci = typeof d.contentIndex === "number" ? d.contentIndex : this.indexOf.size;
		switch (d.type) {
			case "text_start":
				this.blockFor(ci, () => ({ type: "text", text: "" }));
				return;
			case "text_delta": {
				const i = this.blockFor(ci, () => ({ type: "text", text: "" }));
				const text = String(d.delta ?? "");
				(a.content[i] as { text: string }).text += text;
				this.delta(i, { type: "text_delta", text });
				return;
			}
			case "text_end": {
				const i = this.blockFor(ci, () => ({ type: "text", text: "" }));
				if (typeof d.content === "string") (a.content[i] as { text: string }).text = d.content;
				this.stopBlock(i);
				return;
			}
			case "thinking_start":
				this.thinkingStart.set(ci, Date.now());
				this.blockFor(ci, () => ({ type: "thinking", thinking: "" }));
				return;
			case "thinking_delta": {
				if (!this.thinkingStart.has(ci)) this.thinkingStart.set(ci, Date.now());
				const i = this.blockFor(ci, () => ({ type: "thinking", thinking: "" }));
				const thinking = String(d.delta ?? "");
				(a.content[i] as { thinking: string }).thinking += thinking;
				this.delta(i, { type: "thinking_delta", thinking });
				return;
			}
			case "thinking_end": {
				const i = this.blockFor(ci, () => ({ type: "thinking", thinking: "" }));
				const b = a.content[i] as { thinking: string; durationMs?: number };
				if (typeof d.content === "string") b.thinking = d.content;
				const started = this.thinkingStart.get(ci);
				if (started !== undefined) b.durationMs = Date.now() - started;
				this.stopBlock(i);
				return;
			}
			case "toolcall_start": {
				const name = String(d.toolName ?? "tool");
				const id = String(d.id ?? "");
				const i = this.startBlock(ci, {
					type: "tool_use",
					id,
					name,
					title: toolTitle(name, {}),
					input: {},
					status: "running",
				});
				if (id) this.toolIndex.set(id, i);
				return;
			}
			case "toolcall_delta": {
				const i = this.blockFor(ci, () => ({
					type: "tool_use",
					id: "",
					name: "tool",
					input: {},
					status: "running",
				}));
				const piece = String(d.delta ?? "");
				if (piece === "") return;
				const json = (this.partialJson.get(i) ?? "") + piece;
				this.partialJson.set(i, json);
				try {
					(a.content[i] as ToolUseBlock).input = JSON.parse(json);
				} catch {
					// not complete JSON yet
				}
				this.delta(i, { type: "input_json_delta", partial_json: piece });
				return;
			}
			case "toolcall_end": {
				const i = this.blockFor(ci, () => ({
					type: "tool_use",
					id: "",
					name: "tool",
					input: {},
					status: "running",
				}));
				const call = isObj(d.toolCall) ? d.toolCall : {};
				const b = a.content[i] as ToolUseBlock;
				b.id = String(call.id ?? b.id);
				b.name = String(call.name ?? b.name);
				b.input = isObj(call.arguments) ? call.arguments : b.input;
				b.title = toolTitle(b.name, b.input);
				if (b.id) this.toolIndex.set(b.id, i);
				this.stopBlock(i);
				return;
			}
			default:
				return; // start / done / error carry nothing the phone needs
		}
	}

	private onAssistantEnd(m: Raw) {
		if (!this.assistant) this.ensureAssistant(m);
		const a = this.assistant!;
		a.model = modelOf(m) ?? a.model;
		this.lastStop = m.stopReason;
		this.lastError = m.stopReason === "error" ? readableError(String(m.errorMessage ?? "")) : undefined;
		// Anything the deltas never delivered (a provider that sends whole blocks) arrives here.
		const content = Array.isArray(m.content) ? m.content : [];
		content.forEach((raw, ci) => {
			if (!isObj(raw) || this.indexOf.has(ci)) return;
			if (raw.type === "text" && typeof raw.text === "string" && raw.text.trim() !== "") {
				this.stopBlock(this.startBlock(ci, { type: "text", text: raw.text }));
			} else if (raw.type === "thinking" && typeof raw.thinking === "string" && raw.thinking.trim() !== "") {
				this.stopBlock(this.startBlock(ci, { type: "thinking", thinking: raw.thinking }));
			} else if (raw.type === "toolCall") {
				const name = String(raw.name ?? "tool");
				const input = isObj(raw.arguments) ? raw.arguments : {};
				const id = String(raw.id ?? "");
				const i = this.startBlock(ci, {
					type: "tool_use",
					id,
					name,
					title: toolTitle(name, input),
					input,
					status: "running",
				});
				this.toolIndex.set(id, i);
				this.stopBlock(i);
			}
		});
	}

	private onToolEnd(toolCallId: string, result: unknown, isError: boolean) {
		if (!this.assistant) return;
		const a = this.assistant;
		const i = this.toolIndex.get(toolCallId);
		if (i !== undefined) {
			const b = a.content[i] as ToolUseBlock;
			b.status = isError ? "error" : "done";
			this.stopBlock(i);
		}
		const content = toolOutput(isObj(result) ? result.content : undefined);
		const block: Block = { type: "tool_result", toolUseId: toolCallId, isError, content };
		const index = a.content.length;
		a.content.push(block);
		this.emit({ type: "block_start", index, block });
		this.emit({ type: "block_stop", index, block });
	}

	private closeAssistant(status: MessageStatus, error?: string) {
		const a = this.assistant;
		if (!a) return;
		for (const b of a.content)
			if (b.type === "tool_use" && b.status === "running") b.status = status === "complete" ? "done" : "error";
		a.status = status;
		if (error) a.error = error;
		this.emit({
			type: "message_stop",
			status: status === "streaming" ? "complete" : status,
			...(error ? { error } : {}),
		});
		this.assistant = undefined;
	}

	/** The turn is over: say how it ended. */
	finish(override?: { status: MessageStatus; error?: string }) {
		if (override) return this.closeAssistant(override.status, override.error);
		const status = statusOf(this.lastStop);
		this.closeAssistant(status, status === "error" ? (this.lastError ?? "Something went wrong") : undefined);
	}
}
