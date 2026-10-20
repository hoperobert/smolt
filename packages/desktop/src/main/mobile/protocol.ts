// Types and constants of the Smolt Mobile Protocol (v1 + v1.1): the contract between
// this app and Smolt for iPhone. Keep it in step with the spec (smolt-mobile docs/PROTOCOL.md).

export const PROTOCOL_VERSION = 1;
export const SERVER_VERSION = "1.0.0";
export const AUTH_PREFIX = "smolt-auth-v1:";

export const ErrorCode = {
	ParseError: -32700,
	InvalidRequest: -32600,
	MethodNotFound: -32601,
	InvalidParams: -32602,
	NotAuthenticated: -32001,
	PairingFailed: -32002,
	NotFound: -32003,
	Busy: -32004,
	TooLarge: -32005,
	Upstream: -32006,
	RateLimited: -32007,
} as const;

/** Throw this from a method handler to send a JSON-RPC error response. */
export class RpcError extends Error {
	code: number;
	constructor(code: number, message: string) {
		super(message);
		this.code = code;
	}
}

export const notFound = (what: string) => new RpcError(ErrorCode.NotFound, `${what} not found`);
export const badParams = (message: string) => new RpcError(ErrorCode.InvalidParams, message);

// ---- Data types (§3) ----

export type Conversation = {
	id: string;
	title: string;
	projectId?: string;
	model: string;
	starred: boolean;
	createdAt: number;
	updatedAt: number;
	currentLeafId?: string;
	isGenerating: boolean;
	preview?: string;
	/** `follows_desktop`: this is the chat open on the computer right now. */
	desktopActive?: boolean;
};

export type MessageStatus = "complete" | "streaming" | "stopped" | "error";

export type Message = {
	id: string;
	parentId?: string;
	role: "user" | "assistant";
	createdAt: number;
	model?: string;
	status: MessageStatus;
	content: Block[];
	attachments: FileRef[];
	feedback?: "up" | "down";
	error?: string;
	seq?: number;
};

export type TextBlock = { type: "text"; text: string };
export type ThinkingBlock = { type: "thinking"; thinking: string; durationMs?: number };
export type ToolUseBlock = {
	type: "tool_use";
	id: string;
	name: string;
	title?: string;
	input: object;
	status: "running" | "done" | "error";
};
export type ToolResultBlock = { type: "tool_result"; toolUseId: string; isError: boolean; content: string };
export type Block = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock;

export type FileRef = {
	id: string;
	name: string;
	mimeType: string;
	size: number;
	kind: "image" | "document";
	width?: number;
	height?: number;
};

export type Project = {
	id: string;
	name: string;
	description: string;
	instructions: string;
	starred: boolean;
	createdAt: number;
	updatedAt: number;
	files: FileRef[];
	conversationCount: number;
};

export type Model = {
	id: string;
	name: string;
	description: string;
	isDefault: boolean;
	supportsThinking: boolean;
	supportsImages: boolean;
	/** v1.1: e.g. "anthropic"; `id` stays unique across providers. */
	provider?: string;
	/** v1.1: e.g. ["off", "low", "medium", "high"]; shown instead of the on/off switch. */
	thinkingLevels?: string[];
};

export type Style = { id: string; name: string; description: string };

export type Settings = {
	displayName: string;
	nickname: string;
	preferences: string;
	defaultModel: string;
	style: string;
	extendedThinking: boolean;
	webSearch: boolean;
	/** v1.1: one of the current model's thinkingLevels. */
	thinkingLevel?: string;
	/** v1.1: one of bootstrap.permissionModes[].id. */
	permissionMode?: string;
};

/** v1.1 (`permission_modes`): how much the agent may do without asking. */
export type PermissionMode = { id: string; name: string; description: string };

/** v1.1: a question an extension asks mid-reply (Smolt's confirm / select / input / editor dialogs). */
export type Prompt = {
	id: string;
	conversationId?: string;
	kind: "confirm" | "select" | "multiselect" | "input" | "editor";
	title: string;
	message?: string;
	options?: string[];
	placeholder?: string;
	initial?: string;
};

/** v1.1: the answer to a Prompt (`prompts.respond`). */
export type PromptAnswer = { id: string; value?: string; values?: string[]; confirmed?: boolean; cancelled?: boolean };

export type Decision = "allow_once" | "allow_always" | "deny";

export type Approval = {
	id: string;
	conversationId: string;
	messageId: string;
	toolName: string;
	title: string;
	detail: string;
	input: object;
	expiresAt: number;
};

// ---- Stream events (§5.1) ----

export type BlockDelta =
	| { type: "text_delta"; text: string }
	| { type: "thinking_delta"; thinking: string }
	| { type: "input_json_delta"; partial_json: string };

export type StreamEvent =
	| { type: "message_start"; message: Message }
	| { type: "block_start"; index: number; block: Block }
	| { type: "block_delta"; index: number; delta: BlockDelta }
	| { type: "block_stop"; index: number; block?: Block }
	| { type: "message_stop"; status: "complete" | "stopped" | "error"; error?: string };

/** Name, nickname and preferences have no place in Smolt; the bridge keeps them for the phone. */
export const DEFAULT_SETTINGS: Settings = {
	displayName: "",
	nickname: "",
	preferences: "",
	defaultModel: "",
	style: "normal",
	extendedThinking: false,
	webSearch: false,
};
