// The WebSocket server: JSON-RPC framing, the authentication gate, broadcasting, keep-alive.

import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { type WebSocket, WebSocketServer } from "ws";
import { NonceBook, PairingCode } from "./auth.ts";
import { type Ctx, methods, PUBLIC_METHODS } from "./methods.ts";
import { ErrorCode, RpcError } from "./protocol.ts";
import type { Hub, Source } from "./source.ts";
import type { Store } from "./store.ts";
import type { TlsIdentity } from "./tls.ts";

const MAX_FRAME = 48 * 1024 * 1024; // the spec says 40 MB; a little slack for base64 + JSON overhead
const IDLE_MS = 60_000;
export const WS_PATH = "/smolt";

/** One WebSocket connection. */
export type Conn = {
	ws: WebSocket;
	authed: boolean;
	deviceId?: string;
	subscriptions: Set<string>;
	lastActivity: number;
};

export type MobileServerOptions = {
	/** Devices, the phone's settings and uploaded files. */
	store: Store;
	/** Chats, models, settings, approvals: the Smolt desktop. */
	source: Source;
	computerName: string;
	osName: string;
	/** Plain ws:// when absent (dev mode only). */
	tls?: TlsIdentity;
	log: (s: string) => void;
	/** The pairing code changed (new, used, expired or locked out). */
	onPairingChange?: () => void;
	/** A device paired, authenticated, disconnected or was removed. */
	onDevicesChanged?: () => void;
};

export class MobileServer implements Hub {
	readonly store: Store;
	readonly source: Source;
	readonly pairing: PairingCode;
	readonly nonces = new NonceBook();
	readonly computerName: string;
	readonly osName: string;
	readonly log: (s: string) => void;
	private conns = new Set<Conn>();
	private opts: MobileServerOptions;
	private httpServer: http.Server | https.Server | undefined;
	private wss: WebSocketServer | undefined;
	private sweeper: NodeJS.Timeout | undefined;

	constructor(opts: MobileServerOptions) {
		this.opts = opts;
		this.store = opts.store;
		this.source = opts.source;
		this.computerName = opts.computerName;
		this.osName = opts.osName;
		this.log = opts.log;
		this.source.attach(this);
		this.pairing = new PairingCode(() => opts.onPairingChange?.());
	}

	/** The port it is listening on (useful when asked for port 0). */
	get port(): number {
		const address = this.httpServer?.address();
		return address && typeof address === "object" ? (address as AddressInfo).port : 0;
	}

	listen(port: number, host = "0.0.0.0"): Promise<void> {
		const onRequest: http.RequestListener = (_req, res) => {
			res.writeHead(426, { "content-type": "text/plain" });
			res.end(`Smolt Mobile server. Connect with a WebSocket to ${WS_PATH}.\n`);
		};
		const server = this.opts.tls
			? https.createServer({ cert: this.opts.tls.cert, key: this.opts.tls.key }, onRequest)
			: http.createServer(onRequest);
		this.httpServer = server;
		this.wss = new WebSocketServer({ server, path: WS_PATH, maxPayload: MAX_FRAME });
		this.wss.on("connection", (ws) => this.accept(ws));

		// The phone pings every 20 s; drop sockets that have been silent for 60 s.
		this.sweeper = setInterval(() => {
			const now = Date.now();
			for (const c of this.conns) if (now - c.lastActivity > IDLE_MS) c.ws.terminate();
		}, 15_000);
		this.sweeper.unref();

		this.pairing.renew();
		return new Promise((resolve, reject) => {
			const onError = (error: Error) => {
				this.wss?.close();
				clearInterval(this.sweeper);
				this.pairing.stop();
				reject(error);
			};
			server.once("error", onError);
			server.listen(port, host, () => {
				server.off("error", onError);
				resolve();
			});
		});
	}

	async close() {
		clearInterval(this.sweeper);
		this.pairing.stop();
		// Say goodbye, give the phones a moment to read it, then cut whatever is left.
		const sockets = [...this.conns].map((c) => c.ws);
		const goodbyes = sockets.map(
			(ws) => new Promise<void>((r) => (ws.readyState === ws.CLOSED ? r() : ws.once("close", () => r()))),
		);
		for (const ws of sockets) ws.close(1001, "Server shutting down");
		await Promise.race([Promise.all(goodbyes), new Promise((r) => setTimeout(r, 500))]);
		for (const ws of sockets) ws.terminate();
		this.conns.clear();
		this.wss?.close();
		const server = this.httpServer;
		this.httpServer = undefined;
		if (server?.listening) {
			const closed = new Promise<void>((r) => server.close(() => r()));
			server.closeAllConnections();
			await closed;
		}
		await this.source.close?.();
		this.store.flush();
	}

	// ---- Hub ----

	broadcast(method: string, params: object) {
		for (const c of this.conns) if (c.authed) notify(c, method, params);
	}

	toSubscribers(conversationId: string, method: string, params: object) {
		for (const c of this.conns) if (c.authed && c.subscriptions.has(conversationId)) notify(c, method, params);
	}

	devicesChanged() {
		this.opts.onDevicesChanged?.();
	}

	/** Remove a device (from the computer, or by its own request): tell its sockets and close them with 4401. */
	revokeDevice(deviceId: string): boolean {
		const d = this.store.data;
		const before = d.devices.length;
		d.devices = d.devices.filter((x) => x.deviceId !== deviceId);
		this.store.save();
		for (const c of this.conns) {
			if (c.deviceId !== deviceId) continue;
			notify(c, "device.revoked", {});
			c.authed = false;
			c.ws.close(4401, "Device revoked");
		}
		const removed = d.devices.length < before;
		if (removed) this.devicesChanged();
		return removed;
	}

	connectedDeviceIds(): Set<string> {
		return new Set([...this.conns].flatMap((c) => (c.authed && c.deviceId ? [c.deviceId] : [])));
	}

	// ---- connections ----

	private accept(ws: WebSocket) {
		const conn: Conn = { ws, authed: false, subscriptions: new Set(), lastActivity: Date.now() };
		this.conns.add(conn);
		const touch = () => {
			conn.lastActivity = Date.now();
		};
		ws.on("ping", touch);
		ws.on("pong", touch);
		ws.on("message", (data, isBinary) => {
			touch();
			if (isBinary) {
				send(conn, {
					jsonrpc: "2.0",
					id: null,
					error: { code: ErrorCode.InvalidRequest, message: "Use text frames" },
				});
				return;
			}
			void this.handle(conn, data.toString());
		});
		const gone = () => {
			if (!this.conns.delete(conn)) return;
			// "Last seen" is when the phone was last connected, not only when it last signed in.
			const device = conn.authed ? this.store.data.devices.find((d) => d.deviceId === conn.deviceId) : undefined;
			if (device) {
				device.lastSeenAt = Date.now();
				this.store.save();
			}
			if (conn.authed) this.devicesChanged();
		};
		ws.on("close", gone);
		ws.on("error", gone);
	}

	private async handle(conn: Conn, text: string) {
		let msg: { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
		try {
			msg = JSON.parse(text);
		} catch {
			send(conn, { jsonrpc: "2.0", id: null, error: { code: ErrorCode.ParseError, message: "Parse error" } });
			return;
		}
		const id = msg && typeof msg === "object" && "id" in msg ? msg.id : undefined;
		const isNotification = id === undefined;
		const reply = (body: object) => {
			if (!isNotification) send(conn, { jsonrpc: "2.0", id, ...body });
		};

		if (
			!msg ||
			typeof msg !== "object" ||
			Array.isArray(msg) ||
			msg.jsonrpc !== "2.0" ||
			typeof msg.method !== "string"
		) {
			send(conn, {
				jsonrpc: "2.0",
				id: id ?? null,
				error: { code: ErrorCode.InvalidRequest, message: "Invalid request" },
			});
			return;
		}
		const method = msg.method;
		const handler = Object.hasOwn(methods, method) ? methods[method] : undefined;
		if (!handler) {
			reply({ error: { code: ErrorCode.MethodNotFound, message: `Unknown method ${method}` } });
			return;
		}
		if (!conn.authed && !PUBLIC_METHODS.has(method)) {
			reply({ error: { code: ErrorCode.NotAuthenticated, message: "Not authenticated" } });
			return;
		}
		const params = msg.params && typeof msg.params === "object" ? (msg.params as Record<string, unknown>) : {};

		const afterResponse: (() => void)[] = [];
		const ctx: Ctx = { app: this, conn, after: (fn) => afterResponse.push(fn) };
		let result: unknown;
		try {
			result = await handler(params, ctx);
		} catch (err) {
			if (err instanceof RpcError) {
				reply({ error: { code: err.code, message: err.message } });
				return;
			}
			// The method name only: params can carry message text and file bytes.
			this.log(`${method} failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
			reply({ error: { code: -32603, message: "Internal error" } });
			return;
		}
		reply({ result: result ?? {} });
		// Only now, with the response written, may follow-up pushes (stream events) go out.
		for (const fn of afterResponse) fn();
	}
}

function send(conn: Conn, body: object) {
	if (conn.ws.readyState === conn.ws.OPEN) conn.ws.send(JSON.stringify(body));
}

function notify(conn: Conn, method: string, params: object) {
	send(conn, { jsonrpc: "2.0", method, params });
}
