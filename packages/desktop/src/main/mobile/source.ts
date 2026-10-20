// The seam between the protocol (methods.ts) and what owns the chats: the Smolt desktop itself,
// through desktop-source.ts. Pairing, authentication, devices and uploaded files stay in the
// server (store.ts).

import type {
	Approval,
	Conversation,
	Decision,
	Message,
	Model,
	PermissionMode,
	Project,
	Prompt,
	PromptAnswer,
	Settings,
	Style,
} from "./protocol.ts";
import type { Conn } from "./server.ts";

export type Params = Record<string, any>;

/** What a source needs from the WebSocket server. Implemented by MobileServer. */
export interface Hub {
	/** Send to every authenticated connection. */
	broadcast(method: string, params: object): void;
	/** Send to connections subscribed to this conversation. */
	toSubscribers(conversationId: string, method: string, params: object): void;
	log(s: string): void;
}

/** Per-call context for methods that act for one connection. */
export type CallCtx = {
	conn: Conn;
	/** Run `fn` after the JSON-RPC response has been written (used to start streaming). */
	after(fn: () => void): void;
};

export type ConversationDetail = { conversation: Conversation; messages: Message[]; artifacts: never[] };
export type SendResult = { conversationId: string; userMessageId: string; assistantMessageId: string };
/** `conversationId` is set when the retry landed in another conversation (Smolt forks to retry). */
export type RetryResult = { assistantMessageId: string; conversationId?: string };

/** §4.4 projects, for sources that have them. Methods a source can't do throw -32601. */
export interface ProjectsApi {
	list(): Promise<Project[]>;
	get(id: unknown): Promise<Project>;
	create(p: Params): Promise<Project>;
	update(id: unknown, p: Params): Promise<Project>;
	delete(id: unknown): Promise<void>;
	addFile(projectId: unknown, fileId: unknown): Promise<Project>;
	removeFile(projectId: unknown, fileId: unknown): Promise<Project>;
}

export interface Source {
	readonly name: string;
	/** Called once by the server before it starts listening. */
	attach(hub: Hub): void;
	start?(): Promise<void>;
	close?(): Promise<void>;

	// §4.1 Session
	features(): string[];
	styles(): Style[];
	models(): Promise<Model[]>;
	settings(): Promise<Settings>;
	updateSettings(patch: Params): Promise<Settings>;
	pendingApprovals(): Approval[];
	pendingPrompts(): Prompt[];
	/** v1.1 `permission_modes`: what bootstrap lists; Settings.permissionMode picks one. */
	permissionModes?(): PermissionMode[];
	/** §4.4 projects, when the source has them (feature `projects`). */
	readonly projects?: ProjectsApi;

	// §4.2 Conversations
	listConversations(q: { offset: number; limit: number; projectId?: string; starred?: boolean }): Promise<{
		items: Conversation[];
		nextCursor?: string;
	}>;
	searchConversations(query: string, limit: number): Promise<{ conversation: Conversation; snippet: string }[]>;
	getConversation(id: unknown): Promise<ConversationDetail>;
	updateConversation(id: unknown, patch: Params): Promise<Conversation>;
	deleteConversation(id: unknown): Promise<void>;
	setLeaf(id: unknown, leafId: unknown): Promise<Conversation>;
	/** conversations.subscribe: throws -32003 for an unknown id. Returns the canonical id. */
	openConversation(id: unknown): Promise<string>;

	// §4.3 Chat
	send(p: Params, ctx: CallCtx): Promise<SendResult>;
	retry(p: Params, ctx: CallCtx): Promise<RetryResult>;
	stop(conversationId: unknown): Promise<void>;
	feedback(p: Params): Promise<void>;

	// §4.5 / §4.6
	respondPrompt(answer: PromptAnswer): Promise<boolean>;
	respondApproval(id: string, decision: Decision): Promise<boolean>;
}
