import {
	checkApiPath,
	DEFAULT_VOS_URL,
	normalizeBaseUrl,
	VosClient,
	VosError,
} from "../../../coding-agent/src/extensions/vos/client.ts";
import { readVosFile, vosConfigPath, writeVosFile } from "../../../coding-agent/src/extensions/vos/config.ts";
import type { VosEvent } from "../../../coding-agent/src/extensions/vos/types.ts";

/**
 * The desktop's Vos connection, held in the main process.
 *
 * The API key is pasted once into the connect screen and handed here; from
 * then on every Vos call, the event streams and the live computer view run
 * from this process, so the key never sits in the renderer (or a browser
 * using the web server), never crosses IPC again, and is never logged.
 *
 * At rest the key is encrypted with Electron's safeStorage (DPAPI on Windows,
 * the Keychain on macOS, the Secret Service on Linux) in ~/.smolt/vos.json.
 * Where safeStorage has no real keystore (Linux falling back to plain text),
 * the key is kept for this session only and the status says so.
 */

/** What safeStorage offers, injectable so this file can be tested without Electron. */
export interface KeyCipher {
	available(): boolean;
	encrypt(plain: string): string;
	decrypt(encoded: string): string;
}

export type VosKeySource = "encrypted" | "session" | "env" | "none";

export interface VosStatus {
	connected: boolean;
	url: string;
	keySource: VosKeySource;
	/** Whether a key can be kept on disk, encrypted. */
	canPersist: boolean;
	error?: string;
}

export type VosCallResult = { ok: true; value: unknown } | { ok: false; error: string; status: number };

type Send = (channel: string, payload: unknown) => void;

interface LiveSocket {
	readonly readyState: number;
	send(data: string): void;
	close(): void;
	binaryType: string;
	onopen: ((event: unknown) => void) | null;
	onmessage: ((event: { data: unknown }) => void) | null;
	onclose: ((event: unknown) => void) | null;
	onerror: ((event: unknown) => void) | null;
}
type SocketFactory = (url: string, headers: Record<string, string>) => LiveSocket;

export interface VosServiceOptions {
	cipher: KeyCipher;
	send: Send;
	path?: string;
	fetch?: typeof fetch;
	env?: NodeJS.ProcessEnv;
	socket?: SocketFactory;
}

const METHODS = new Set(["GET", "POST", "PATCH", "PUT", "DELETE"]);
/** How long a watch or live view lasts without being renewed. */
export const LEASE_MS = 45_000;

/** The image type from the bytes themselves: the live line names none, and /screens says "jpeg" for all. */
export function imageMime(bytes: Uint8Array): string {
	if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
	if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
	if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
	if (bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
	return "application/octet-stream";
}

/** Split a live-line frame: one line of JSON, a newline, then the image. */
export function parseLiveFrame(
	bytes: Uint8Array,
): { w: number; h: number; cursor: unknown; image: Uint8Array } | undefined {
	const newline = bytes.indexOf(0x0a);
	if (newline <= 0 || newline > 4096) return undefined;
	try {
		const head = JSON.parse(new TextDecoder().decode(bytes.subarray(0, newline))) as {
			w?: number;
			h?: number;
			cursor?: unknown;
		};
		return {
			w: Number(head.w ?? 0),
			h: Number(head.h ?? 0),
			cursor: head.cursor ?? null,
			image: bytes.subarray(newline + 1),
		};
	} catch {
		return undefined;
	}
}

/** Generic calls may not carry a secret: that has its own path, so there is one place it travels. */
function isSecretAnswer(method: string, path: string): boolean {
	return method === "POST" && /^\/secrets\/[^/?]+\/?(\?.*)?$/.test(path);
}

export class VosService {
	private readonly cipher: KeyCipher;
	private readonly send: Send;
	private readonly path: string;
	private readonly fetchImpl: typeof fetch | undefined;
	private readonly env: NodeJS.ProcessEnv;
	private readonly socket: SocketFactory | undefined;
	private key = "";
	private keySource: VosKeySource = "none";
	private url = DEFAULT_VOS_URL;
	private lastError: string | undefined;
	private client: VosClient | undefined;
	private readonly streams = new Map<string, { until: number; controller: AbortController }>();
	private readonly lives = new Map<
		string,
		{ socket: LiveSocket; timer: ReturnType<typeof setInterval>; until: number }
	>();
	private sweeper: ReturnType<typeof setInterval> | undefined;

	constructor(options: VosServiceOptions) {
		this.cipher = options.cipher;
		this.send = options.send;
		this.path = options.path ?? vosConfigPath(options.env);
		this.fetchImpl = options.fetch;
		this.env = options.env ?? process.env;
		this.socket = options.socket;
		this.load();
		this.sweeper = setInterval(() => this.sweep(), 15_000);
		this.sweeper.unref?.();
	}

	private load(): void {
		const file = readVosFile(this.path);
		try {
			this.url = normalizeBaseUrl(file.url ?? this.env.VOS_URL ?? DEFAULT_VOS_URL);
		} catch {
			this.url = DEFAULT_VOS_URL;
		}
		if (file.encryptedKey && this.cipher.available()) {
			try {
				this.key = this.cipher.decrypt(file.encryptedKey);
				this.keySource = "encrypted";
			} catch {
				this.lastError = "The saved Vos key could not be decrypted on this account. Connect again.";
			}
		}
		if (!this.key && this.env.VOS_API_KEY?.trim()) {
			this.key = this.env.VOS_API_KEY.trim();
			this.keySource = "env";
		}
		this.rebuild();
	}

	private rebuild(): void {
		this.client = this.key
			? new VosClient({ baseUrl: this.url, apiKey: this.key, fetch: this.fetchImpl })
			: undefined;
	}

	status(): VosStatus {
		return {
			connected: this.client !== undefined,
			url: this.url,
			keySource: this.keySource,
			canPersist: this.cipher.available(),
			...(this.lastError ? { error: this.lastError } : {}),
		};
	}

	/**
	 * Check the key against the server, then keep it. An empty key keeps the
	 * one already held, so the address can change without pasting it again.
	 */
	async connect(url: string, key: string): Promise<VosStatus> {
		let base: string;
		try {
			base = normalizeBaseUrl(url || DEFAULT_VOS_URL);
		} catch (error) {
			return { ...this.status(), error: error instanceof Error ? error.message : String(error) };
		}
		const nextKey = key.trim() || this.key;
		if (!nextKey) return { ...this.status(), error: "Paste your Vos API key." };
		const probe = new VosClient({ baseUrl: base, apiKey: nextKey, fetch: this.fetchImpl });
		try {
			await probe.roster();
		} catch (error) {
			return { ...this.status(), error: error instanceof Error ? error.message : String(error) };
		}
		this.stopAll();
		this.url = base;
		this.key = nextKey;
		this.lastError = undefined;
		const file = readVosFile(this.path);
		delete file.encryptedKey;
		file.url = base;
		if (this.cipher.available()) {
			file.encryptedKey = this.cipher.encrypt(nextKey);
			this.keySource = "encrypted";
		} else {
			this.keySource = "session";
		}
		writeVosFile(file, this.path);
		this.rebuild();
		return this.status();
	}

	disconnect(): VosStatus {
		this.stopAll();
		const file = readVosFile(this.path);
		if (file.encryptedKey) {
			delete file.encryptedKey;
			writeVosFile(file, this.path);
		}
		this.key = "";
		this.keySource = "none";
		this.lastError = undefined;
		this.rebuild();
		return this.status();
	}

	private need(): VosClient {
		if (!this.client) throw new VosError("Vos is not connected.", 0);
		return this.client;
	}

	/** One API call on the renderer's behalf, by path. Answers rather than throws. */
	async call(method: string, path: string, body?: unknown, dot?: string): Promise<VosCallResult> {
		const verb = String(method).toUpperCase();
		try {
			if (!METHODS.has(verb)) throw new VosError(`Unsupported method ${verb}`, 0);
			checkApiPath(String(path));
			if (isSecretAnswer(verb, String(path))) throw new VosError("Secrets go through their own call.", 0);
			const value = await this.need().request(verb, String(path), {
				...(dot ? { dot: String(dot) } : {}),
				...(body !== undefined && body !== null ? { body } : {}),
			});
			return { ok: true, value: value ?? null };
		} catch (error) {
			return {
				ok: false,
				error: error instanceof Error ? error.message : String(error),
				status: error instanceof VosError ? error.status : 0,
			};
		}
	}

	/** Answer a secret request. The value goes straight to the server and nowhere else. */
	async answerSecret(dot: string, id: string, value: string): Promise<VosCallResult> {
		try {
			if (typeof value !== "string" || value === "") throw new VosError("Enter the secret first.", 0);
			await this.need().answerSecret(String(dot), String(id), value);
			return { ok: true, value: null };
		} catch (error) {
			return {
				ok: false,
				error: error instanceof Error ? error.message : String(error),
				status: error instanceof VosError ? error.status : 0,
			};
		}
	}

	/** A file the API serves, as a data URL the page can show without the key. */
	async file(path: string): Promise<VosCallResult> {
		try {
			const { bytes, contentType } = await this.need().file(String(path));
			const type = contentType.startsWith("image/") ? imageMime(bytes) : contentType;
			return {
				ok: true,
				value: `data:${type === "application/octet-stream" ? contentType : type};base64,${Buffer.from(bytes).toString("base64")}`,
			};
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error), status: 0 };
		}
	}

	// ------------------------------------------------------------ live event streams

	/**
	 * Follow a thread's events. A watch is a lease: the page renews it while
	 * the thread is on screen, and a lease nobody renews lapses. That covers
	 * what an explicit unwatch cannot: a reload, a crashed renderer, a closed
	 * browser tab, and two windows (the app and a browser) on one thread.
	 */
	watch(dot: string): void {
		this.sweep();
		const existing = this.streams.get(dot);
		if (existing) {
			existing.until = Date.now() + LEASE_MS;
			return;
		}
		const controller = new AbortController();
		this.streams.set(dot, { until: Date.now() + LEASE_MS, controller });
		void this.pump(dot, controller.signal);
	}

	unwatch(dot: string): void {
		const entry = this.streams.get(dot);
		if (!entry) return;
		entry.controller.abort();
		this.streams.delete(dot);
	}

	/** Drop streams and live views whose lease ran out. */
	sweep(now: number = Date.now()): void {
		for (const [dot, entry] of this.streams) if (entry.until < now) this.unwatch(dot);
		for (const [dot, live] of this.lives) if (live.until < now) this.liveClose(dot);
	}

	/** Which threads are being followed, for tests and diagnostics. */
	watching(): string[] {
		return [...this.streams.keys()];
	}

	private async pump(dot: string, signal: AbortSignal): Promise<void> {
		let lastEventId: string | undefined;
		let delay = 1000;
		while (!signal.aborted) {
			const client = this.client;
			if (!client) return;
			this.send("vos:stream", { dot, state: "connecting" });
			try {
				let opened = false;
				const result = await client.events(
					dot,
					(event: VosEvent) => {
						if (!opened) {
							opened = true;
							delay = 1000;
							this.send("vos:stream", { dot, state: "live" });
						}
						this.send("vos:event", { dot, ...event });
					},
					{ signal, ...(lastEventId ? { lastEventId } : {}) },
				);
				lastEventId = result.lastEventId ?? lastEventId;
			} catch (error) {
				if (signal.aborted) return;
				this.send("vos:stream", {
					dot,
					state: "error",
					error: error instanceof Error ? error.message : String(error),
				});
				// A refused key will not get better by asking again.
				if (error instanceof VosError && error.status === 401) return;
			}
			if (signal.aborted) return;
			await new Promise((resolve) => setTimeout(resolve, delay));
			delay = Math.min(delay * 2, 30_000);
		}
	}

	// ------------------------------------------------------------ the live computer view

	/**
	 * Open (or renew the lease on) the live line to a vos's computer. Frames are passed on at most
	 * four a second, newest wins. When the socket cannot open (no WebSocket
	 * with headers here, or the server refuses), the renderer is told and
	 * falls back to the /screens snapshots.
	 */
	liveOpen(dot: string): VosCallResult {
		this.sweep();
		const open = this.lives.get(dot);
		if (open) {
			open.until = Date.now() + LEASE_MS;
			return { ok: true, value: null };
		}
		const client = this.client;
		if (!client) return { ok: false, error: "Vos is not connected.", status: 0 };
		const factory = this.socket ?? defaultSocketFactory();
		if (!factory) return { ok: false, error: "This build has no WebSocket client.", status: 0 };
		const url = `${client.baseUrl.replace(/^http/, "ws")}/v1/computer/live`;
		let socket: LiveSocket;
		try {
			socket = factory(url, { authorization: `Bearer ${this.key}`, "x-vos-dot": dot });
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error), status: 0 };
		}
		socket.binaryType = "arraybuffer";
		let latest: { w: number; h: number; cursor: unknown; image: Uint8Array } | undefined;
		const timer = setInterval(() => {
			if (!latest) return;
			const frame = latest;
			latest = undefined;
			this.send("vos:frame", {
				dot,
				w: frame.w,
				h: frame.h,
				cursor: frame.cursor,
				image: `data:${imageMime(frame.image)};base64,${Buffer.from(frame.image).toString("base64")}`,
			});
		}, 250);
		socket.onopen = () => this.send("vos:live", { dot, state: "open" });
		socket.onmessage = (event) => {
			if (event.data instanceof ArrayBuffer) latest = parseLiveFrame(new Uint8Array(event.data)) ?? latest;
		};
		const end = (state: string) => () => {
			if (this.lives.get(dot)?.socket !== socket) return;
			clearInterval(timer);
			this.lives.delete(dot);
			this.send("vos:live", { dot, state });
		};
		socket.onclose = end("closed");
		socket.onerror = end("unavailable");
		this.lives.set(dot, { socket, timer, until: Date.now() + LEASE_MS });
		return { ok: true, value: null };
	}

	/** Pointer and keys for a computer the user has taken over; same fields as POST /computer/input. */
	liveInput(dot: string, input: unknown): VosCallResult {
		const live = this.lives.get(dot);
		if (!live || live.socket.readyState !== 1) return { ok: false, error: "The live view is not open.", status: 0 };
		live.socket.send(JSON.stringify(input));
		return { ok: true, value: null };
	}

	liveClose(dot: string): void {
		const live = this.lives.get(dot);
		if (!live) return;
		clearInterval(live.timer);
		this.lives.delete(dot);
		try {
			live.socket.close();
		} catch {
			// Already gone.
		}
	}

	/** Stop everything, for good: tests and app shutdown. */
	dispose(): void {
		this.stopAll();
		if (this.sweeper) clearInterval(this.sweeper);
	}

	stopAll(): void {
		for (const entry of this.streams.values()) entry.controller.abort();
		this.streams.clear();
		for (const dot of [...this.lives.keys()]) this.liveClose(dot);
	}
}

/**
 * Node's WebSocket (undici) takes request headers in its non-standard init
 * argument, which is what lets the key ride in the Authorization header as
 * the server expects rather than in the URL.
 */
function defaultSocketFactory(): SocketFactory | undefined {
	const Ctor = (globalThis as { WebSocket?: new (url: string, init?: unknown) => LiveSocket }).WebSocket;
	if (!Ctor) return undefined;
	return (url, headers) => new Ctor(url, { headers });
}
