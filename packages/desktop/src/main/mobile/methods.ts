// Every JSON-RPC method of the protocol (§2.2 and §4), one function each.

import { importDeviceKey, verifyDeviceSignature } from "./auth.ts";
import { newId } from "./ids.ts";
import { imageSize } from "./images.ts";
import { bool, req, str } from "./params.ts";
import {
	badParams,
	type Decision,
	ErrorCode,
	notFound,
	type PromptAnswer,
	RpcError,
	SERVER_VERSION,
} from "./protocol.ts";
import type { Conn, MobileServer } from "./server.ts";
import type { Params, ProjectsApi } from "./source.ts";

export type Ctx = {
	app: MobileServer;
	conn: Conn;
	/** Run `fn` after the JSON-RPC response has been written (used to start streaming). */
	after(fn: () => void): void;
};

export type Handler = (params: Params, ctx: Ctx) => unknown;

/** Methods a socket may call before it has authenticated. */
export const PUBLIC_METHODS = new Set(["pair.request", "auth.challenge", "auth.verify"]);

const MB = 1024 * 1024;
const IMAGE_LIMIT = 10 * MB;
const DOCUMENT_LIMIT = 30 * MB;

function projectsOf(app: MobileServer): ProjectsApi {
	if (app.source.projects) return app.source.projects;
	throw new RpcError(ErrorCode.MethodNotFound, "Projects aren't available on this computer");
}

function noArtifacts(): never {
	throw new RpcError(ErrorCode.MethodNotFound, "Artifacts aren't available on this computer");
}

function limitOf(p: Params): number {
	return Math.min(Math.max(Number(p.limit ?? 30) || 30, 1), 200);
}

// ---- methods ----

export const methods: Record<string, Handler> = {
	// §2.2 Pairing and authentication

	"pair.request"(p, { app, conn }) {
		const publicKey = req(p, "publicKey");
		try {
			importDeviceKey(publicKey);
		} catch (e) {
			throw badParams((e as Error).message);
		}
		if (!app.pairing.attempt(p.code))
			throw new RpcError(ErrorCode.PairingFailed, "Pairing code wrong, used or expired");
		const now = Date.now();
		const device = {
			deviceId: newId("dev"),
			deviceName: str(p, "deviceName", { optional: true }) ?? "iPhone",
			deviceModel: str(p, "deviceModel", { optional: true }) ?? "",
			publicKey,
			pairedAt: now,
			lastSeenAt: now,
		};
		app.store.data.devices.push(device);
		app.store.save();
		conn.deviceId = device.deviceId;
		conn.authed = true;
		app.log(`paired ${device.deviceName} (${device.deviceId})`);
		app.devicesChanged();
		return { deviceId: device.deviceId, computerName: app.computerName, serverVersion: SERVER_VERSION };
	},

	"auth.challenge"(p, { app }) {
		const deviceId = req(p, "deviceId");
		if (!app.store.data.devices.some((d) => d.deviceId === deviceId)) {
			throw new RpcError(ErrorCode.NotAuthenticated, "Unknown device: it was removed or never paired");
		}
		return { nonce: app.nonces.issue(deviceId) };
	},

	"auth.verify"(p, { app, conn }) {
		const deviceId = req(p, "deviceId");
		const signature = req(p, "signature");
		const device = app.store.data.devices.find((d) => d.deviceId === deviceId);
		const nonce = app.nonces.take(deviceId);
		if (!device || !nonce || !verifyDeviceSignature(device.publicKey, nonce, signature)) {
			throw new RpcError(ErrorCode.NotAuthenticated, "Authentication failed");
		}
		device.lastSeenAt = Date.now();
		app.store.save();
		conn.deviceId = deviceId;
		conn.authed = true;
		app.devicesChanged();
		return { computerName: app.computerName, serverVersion: SERVER_VERSION, features: app.source.features() };
	},

	// §4.1 Session

	async bootstrap(_p, { app }) {
		const source = app.source;
		const [settings, models] = await Promise.all([source.settings(), source.models()]);
		return {
			computer: { name: app.computerName, os: app.osName },
			settings,
			models,
			styles: source.styles(),
			features: source.features(),
			pendingApprovals: source.pendingApprovals(),
			pendingPrompts: source.pendingPrompts(),
			...(source.permissionModes ? { permissionModes: source.permissionModes() } : {}),
		};
	},

	"settings.update"(p, { app }) {
		return app.source.updateSettings(p);
	},

	"device.unpair"(_p, { app, conn, after }) {
		const deviceId = conn.deviceId!;
		after(() => app.revokeDevice(deviceId));
		return {};
	},

	// §4.2 Conversations

	"conversations.list"(p, { app }) {
		const limit = limitOf(p);
		const offset = p.cursor ? Number.parseInt(String(p.cursor), 10) || 0 : 0;
		return app.source.listConversations({
			offset,
			limit,
			projectId: str(p, "projectId", { optional: true }),
			starred: bool(p, "starred"),
		});
	},

	async "conversations.search"(p, { app }) {
		const query = req(p, "query").trim().toLowerCase();
		return { items: await app.source.searchConversations(query, limitOf(p)) };
	},

	"conversations.get"(p, { app }) {
		return app.source.getConversation(p.id);
	},

	"conversations.update"(p, { app }) {
		return app.source.updateConversation(p.id, p);
	},

	async "conversations.delete"(p, { app }) {
		await app.source.deleteConversation(p.id);
		return {};
	},

	"conversations.setLeaf"(p, { app }) {
		return app.source.setLeaf(p.id, p.leafId);
	},

	async "conversations.subscribe"(p, { app, conn }) {
		conn.subscriptions.add(await app.source.openConversation(p.id));
		return {};
	},

	"conversations.unsubscribe"(p, { conn }) {
		conn.subscriptions.delete(String(p.id));
		return {};
	},

	// §4.3 Chat

	"chat.send"(p, { app, conn, after }) {
		return app.source.send(p, { conn, after });
	},

	"chat.retry"(p, { app, conn, after }) {
		return app.source.retry(p, { conn, after });
	},

	async "chat.stop"(p, { app }) {
		await app.source.stop(p.conversationId);
		return {};
	},

	async "messages.feedback"(p, { app }) {
		await app.source.feedback(p);
		return {};
	},

	// §4.4 Files, artifacts and projects

	"files.upload"(p, { app }) {
		const name = req(p, "name");
		const mimeType = req(p, "mimeType");
		const data = str(p, "data", { allowEmpty: true }) as string;
		const bytes = Buffer.from(data, "base64");
		const kind = mimeType.startsWith("image/") ? "image" : "document";
		const limit = kind === "image" ? IMAGE_LIMIT : DOCUMENT_LIMIT;
		if (bytes.length > limit) {
			throw new RpcError(
				ErrorCode.TooLarge,
				`${kind === "image" ? "Images" : "Documents"} can be up to ${limit / MB} MB`,
			);
		}
		const size = kind === "image" ? imageSize(bytes) : undefined;
		const file = {
			id: newId("fil"),
			name,
			mimeType,
			size: bytes.length,
			kind,
			...size,
			createdAt: Date.now(),
		} as const;
		app.store.writeBlob(file.id, bytes);
		app.store.data.files.push(file);
		app.store.save();
		return app.store.fileRef(file);
	},

	"files.download"(p, { app }) {
		const f = app.store.fileMeta(p.id);
		// Thumbnails: there is no image resizer here (no native deps), so it returns the original.
		return { mimeType: f.mimeType, data: app.store.readBlob(f.id).toString("base64") };
	},

	"artifacts.list"() {
		return noArtifacts();
	},

	"artifacts.get"() {
		return noArtifacts();
	},

	async "projects.list"(_p, { app }) {
		return { items: await projectsOf(app).list() };
	},

	"projects.get"(p, { app }) {
		return projectsOf(app).get(p.id);
	},

	"projects.create"(p, { app }) {
		return projectsOf(app).create(p);
	},

	"projects.update"(p, { app }) {
		return projectsOf(app).update(p.id, p);
	},

	async "projects.delete"(p, { app }) {
		await projectsOf(app).delete(p.id);
		return {};
	},

	"projects.addFile"(p, { app }) {
		return projectsOf(app).addFile(p.projectId, p.fileId);
	},

	"projects.removeFile"(p, { app }) {
		return projectsOf(app).removeFile(p.projectId, p.fileId);
	},

	// §4.5 Prompts (v1.1)

	async "prompts.respond"(p, { app }) {
		const answer: PromptAnswer = { id: req(p, "id") };
		const value = str(p, "value", { optional: true, allowEmpty: true });
		if (value !== undefined) answer.value = value;
		if (Array.isArray(p.values)) answer.values = p.values.map(String);
		const confirmed = bool(p, "confirmed");
		if (confirmed !== undefined) answer.confirmed = confirmed;
		if (bool(p, "cancelled")) answer.cancelled = true;
		if (!(await app.source.respondPrompt(answer))) throw notFound("Prompt");
		return {};
	},

	// §4.6 Approvals

	async "approvals.respond"(p, { app }) {
		const decision = p.decision as Decision;
		if (!["allow_once", "allow_always", "deny"].includes(decision)) {
			throw badParams('decision must be "allow_once", "allow_always" or "deny"');
		}
		if (!(await app.source.respondApproval(req(p, "id"), decision))) throw notFound("Approval");
		return {};
	},
};
