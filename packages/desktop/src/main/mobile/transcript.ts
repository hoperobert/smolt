// Smolt's transcript (AgentMessage[], packages/ai/src/types.ts) as protocol Messages.
//
// Smolt stores a turn as several messages: the user's, then one assistant message per model
// request, with a toolResult message after each tool call. The phone shows one assistant bubble
// per turn, so everything from an assistant message up to the next user message folds into one
// protocol Message: thinking/text/toolCall blocks in order, each toolResult as a tool_result block
// right after the tool calls it answers. The desktop renders it the same way
// (packages/desktop/src/renderer/store.ts: fromAgentMessage + attachToolResult).
//
// The chain is linear (Smolt shows a session's messages in file order), so parentId is simply the
// message before.

import type { Block, FileRef, Message, MessageStatus, ToolUseBlock } from "./protocol.ts";

export type Raw = Record<string, unknown>;

/** What Smolt writes in place of empty text on an image-only message (renderer/state/app.ts). */
export const IMAGE_ONLY_TEXT = "The user has provided an image with this message";
/** Tool output kept per block, like the desktop's own transcript (20 000 characters). */
const TOOL_OUTPUT_LIMIT = 20_000;

const isObj = (v: unknown): v is Raw => typeof v === "object" && v !== null;

export function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b): b is Raw => isObj(b) && b.type === "text" && typeof b.text === "string")
		.map((b) => b.text as string)
		.join("\n");
}

export function imagesOf(content: unknown): { data: string; mimeType: string }[] {
	if (!Array.isArray(content)) return [];
	return content
		.filter((b): b is Raw => isObj(b) && b.type === "image" && typeof b.data === "string" && b.data !== "")
		.map((b) => ({ data: b.data as string, mimeType: String(b.mimeType ?? "image/png") }));
}

/** "Running `ls -la`", "Reading src/app.ts": what the phone shows on a tool chip. */
export function toolTitle(name: string, args: unknown): string {
	const a = isObj(args) ? args : {};
	const first = a.command ?? a.file_path ?? a.path ?? a.pattern ?? a.query ?? a.url;
	const detail = typeof first === "string" ? first.replace(/\s+/g, " ").trim() : "";
	const short = detail.length > 80 ? `${detail.slice(0, 79)}…` : detail;
	const verbs: Record<string, string> = {
		bash: "Running",
		powershell: "Running",
		read: "Reading",
		write: "Writing",
		edit: "Editing",
		grep: "Searching for",
		find: "Finding",
		ls: "Listing",
		web_search: "Searching the web for",
		web_fetch: "Fetching",
	};
	const verb = verbs[name];
	if (verb && short) return `${verb} ${short}`;
	return short ? `${name}: ${short}` : name;
}

export function toolOutput(content: unknown): string {
	return textOf(content).slice(0, TOOL_OUTPUT_LIMIT);
}

/** The protocol status of a finished assistant message, from Smolt's stopReason. */
export function statusOf(stopReason: unknown): MessageStatus {
	if (stopReason === "aborted") return "stopped";
	if (stopReason === "error") return "error";
	return "complete";
}

/** The human sentence inside a provider's JSON error envelope, if it has one (as the desktop shows it). */
export function readableError(raw: string): string {
	if (raw === "") return "Unknown error";
	const start = raw.indexOf("{");
	if (start === -1) return raw;
	try {
		const parsed: unknown = JSON.parse(raw.slice(start));
		const inner = isObj(parsed) && typeof parsed.message === "string" ? parsed.message.trim() : "";
		if (inner === "") return raw;
		const status = raw.slice(0, start).trim().replace(/:$/, "");
		return status === "" ? inner : `${status} ${inner}`;
	} catch {
		return raw;
	}
}

export function modelOf(m: Raw): string | undefined {
	return typeof m.provider === "string" && typeof m.model === "string" ? `${m.provider}/${m.model}` : undefined;
}

export type MapOptions = {
	/** Protocol id for a Smolt message: role initial + its timestamp, unless the bridge assigned one. */
	idFor(role: "u" | "a", timestamp: number): string;
	/** Store an image so the phone can download it; returns its FileRef. */
	fileFor(image: { data: string; mimeType: string }): FileRef;
	/** The conversation is still generating: its last turn's tool calls are running, not cut off. */
	tailRunning?: boolean;
};

/** A user message as the protocol shows it: its text, and its images as attachments. */
export function userMessage(m: Raw, id: string, parentId: string | undefined, opts: MapOptions): Message {
	const images = imagesOf(m.content);
	let text = textOf(m.content);
	if (images.length > 0 && text.trim() === IMAGE_ONLY_TEXT) text = "";
	return {
		id,
		...(parentId ? { parentId } : {}),
		role: "user",
		createdAt: typeof m.timestamp === "number" ? m.timestamp : Date.now(),
		status: "complete",
		content: text ? [{ type: "text", text }] : [],
		attachments: images.map((img) => opts.fileFor(img)),
	};
}

/** The blocks of one finished assistant message, in order. */
export function assistantBlocks(m: Raw): Block[] {
	const out: Block[] = [];
	for (const raw of Array.isArray(m.content) ? m.content : []) {
		if (!isObj(raw)) continue;
		if (raw.type === "text" && typeof raw.text === "string" && raw.text.trim() !== "") {
			out.push({ type: "text", text: raw.text });
		} else if (raw.type === "thinking" && typeof raw.thinking === "string" && raw.thinking.trim() !== "") {
			out.push({ type: "thinking", thinking: raw.thinking });
		} else if (raw.type === "toolCall") {
			const name = String(raw.name ?? "tool");
			const input = isObj(raw.arguments) ? raw.arguments : {};
			out.push({
				type: "tool_use",
				id: String(raw.id ?? ""),
				name,
				title: toolTitle(name, input),
				input,
				status: "running",
			});
		}
	}
	return out;
}

/** Map a stored transcript (oldest first) to protocol messages. */
export function mapTranscript(raw: Raw[], opts: MapOptions): Message[] {
	const out: Message[] = [];
	const used = new Set<string>();
	let group: Message | undefined;
	let prev: string | undefined;
	const unique = (id: string) => {
		let candidate = id;
		for (let n = 2; used.has(candidate); n++) candidate = `${id}_${n}`;
		used.add(candidate);
		return candidate;
	};
	const closeGroup = (last = false) => {
		if (!group) return;
		if (last && opts.tailRunning) return;
		// A call with no result was cut off: Smolt shows it as interrupted.
		for (const b of group.content) if (b.type === "tool_use" && b.status === "running") b.status = "error";
		group = undefined;
	};

	for (const m of raw) {
		const ts = typeof m.timestamp === "number" ? m.timestamp : 0;
		if (m.role === "user") {
			closeGroup();
			const msg = userMessage(m, unique(opts.idFor("u", ts)), prev, opts);
			out.push(msg);
			prev = msg.id;
		} else if (m.role === "assistant") {
			if (!group) {
				group = {
					id: unique(opts.idFor("a", ts)),
					...(prev ? { parentId: prev } : {}),
					role: "assistant",
					createdAt: ts || Date.now(),
					model: modelOf(m),
					status: "complete",
					content: [],
					attachments: [],
				};
				out.push(group);
				prev = group.id;
			}
			group.content.push(...assistantBlocks(m));
			group.model = modelOf(m) ?? group.model;
			// The last request of the turn says how it ended.
			group.status = statusOf(m.stopReason);
			if (group.status === "error") group.error = readableError(String(m.errorMessage ?? ""));
			else delete group.error;
		} else if (m.role === "toolResult" && group) {
			const id = String(m.toolCallId ?? "");
			const use = group.content.find((b): b is ToolUseBlock => b.type === "tool_use" && b.id === id);
			const isError = m.isError === true;
			if (use) use.status = isError ? "error" : "done";
			group.content.push({ type: "tool_result", toolUseId: id, isError, content: toolOutput(m.content) });
		}
		// custom / bashExecution / compactionSummary / branchSummary: not part of the chat on the phone
	}
	closeGroup(true);
	return out;
}
