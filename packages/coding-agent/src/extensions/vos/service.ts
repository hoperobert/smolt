import { hostname } from "node:os";
import type { ExtensionSecrets } from "../../core/extensions/types.ts";
import {
	checkApiPath,
	DEFAULT_VOS_URL,
	deviceName,
	normalizeBaseUrl,
	pollPairing,
	startPairing,
	VosClient,
	VosError,
} from "./client.ts";
import { resolveVosConfig, SECRET_DEVICE, SECRET_KEY, saveVosUrl } from "./config.ts";
import type {
	InboxCount,
	InboxItem,
	PairKind,
	PairPoll,
	VosCallResult,
	VosConnection,
	VosEvent,
	VosKeySource,
	VosPairing,
} from "./types.ts";

export type { VosCallResult, VosConnection, VosPairing } from "./types.ts";

/**
 * The Vos connection behind the desktop view (and the TUI panel).
 *
 * Everything that touches the key runs here, in the extension's Node side:
 * API calls, the event streams, the live computer view, pairing. The view
 * asks for these by name through `window.smolt.request` and only ever sees
 * answers; the key never reaches it, and is never logged.
 *
 * The key is kept by the host's secret store (the OS keystore in the desktop
 * app, a 0600 file in the terminal).
 */

/** What the service tells the view, by event name. */
export type Post = (event: string, data: unknown) => void;

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
export type SocketFactory = (url: string, headers: Record<string, string>) => LiveSocket;

export interface VosServiceOptions {
	secrets: ExtensionSecrets;
	post: Post;
	env?: NodeJS.ProcessEnv;
	fetch?: typeof fetch;
	socket?: SocketFactory;
	/** How often a pairing is polled; tests shorten it. */
	pollMs?: number;
	/** This machine's name, for the name the phone shows. */
	host?: string;
	/** What kind of device pairing makes this host. */
	kind?: PairKind;
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
export function isSecretAnswer(method: string, path: string): boolean {
	return method === "POST" && /^\/secrets\/[^/?]+\/?(\?.*)?$/.test(path);
}

const failure = (error: unknown): { ok: false; error: string; status: number } => ({
	ok: false,
	error: error instanceof Error ? error.message : String(error),
	status: error instanceof VosError ? error.status : 0,
});

/**
 * New high-priority inbox items, to notify about. The first look only learns
 * what is already there: a backlog at startup is not news.
 */
export class InboxTracker {
	private seen = new Set<string>();
	private primed = false;

	/** Items in `items` not seen before that deserve a notification. */
	fresh(items: InboxItem[]): InboxItem[] {
		const out: InboxItem[] = [];
		for (const item of items) {
			if (this.seen.has(item.id)) continue;
			this.seen.add(item.id);
			if (this.primed && item.state === "open" && item.priority === "high") out.push(item);
		}
		this.primed = true;
		return out;
	}

	/** One item as an event announced it: news whenever it is new and high. */
	added(item: InboxItem): boolean {
		if (!item?.id || this.seen.has(item.id)) return false;
		this.seen.add(item.id);
		return item.state === "open" && item.priority === "high";
	}

	reset(): void {
		this.seen.clear();
		this.primed = false;
	}
}

export class VosService {
	private readonly secrets: ExtensionSecrets;
	private readonly post: Post;
	private readonly env: NodeJS.ProcessEnv;
	private readonly fetchImpl: typeof fetch | undefined;
	private readonly socket: SocketFactory | undefined;
	private readonly pollMs: number;
	private readonly host: string;
	private readonly kind: PairKind;
	private key = "";
	private keySource: VosKeySource = "none";
	private canPersist = true;
	private url = DEFAULT_VOS_URL;
	private pairName: string | undefined;
	private lastError: string | undefined;
	private client: VosClient | undefined;
	private loaded: Promise<void> | undefined;
	private readonly streams = new Map<string, { until: number; controller: AbortController }>();
	private readonly lives = new Map<
		string,
		{ socket: LiveSocket; timer: ReturnType<typeof setInterval>; until: number }
	>();
	private sweeper: ReturnType<typeof setInterval> | undefined;
	private pairing: { id: string; timer: ReturnType<typeof setTimeout> } | undefined;
	private inboxTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly inbox = new InboxTracker();
	private inboxHandlers:
		| { onCount: (count: InboxCount | undefined) => void; onNews: (item: InboxItem) => void }
		| undefined;

	constructor(options: VosServiceOptions) {
		this.secrets = options.secrets;
		this.post = options.post;
		this.env = options.env ?? process.env;
		this.fetchImpl = options.fetch;
		this.socket = options.socket;
		this.pollMs = options.pollMs ?? 2000;
		this.host = options.host ?? hostname();
		this.kind = options.kind ?? "smolt-desktop";
		this.sweeper = setInterval(() => this.sweep(), 15_000);
		this.sweeper.unref?.();
	}

	/** Read the key once, lazily: the secret store may be a round trip away. */
	private ready(): Promise<void> {
		this.loaded ??= this.load();
		return this.loaded;
	}

	private async load(): Promise<void> {
		try {
			const config = await resolveVosConfig(this.secrets, this.env);
			this.url = config.url;
			this.key = config.apiKey ?? "";
			this.keySource = config.keySource;
			this.pairName = config.deviceName;
		} catch (error) {
			this.lastError = `The saved Vos key could not be read: ${error instanceof Error ? error.message : String(error)}`;
		}
		this.canPersist = (await this.secrets.backend().catch(() => "memory")) !== "memory";
		this.rebuild();
	}

	private rebuild(): void {
		this.client = this.key
			? new VosClient({ baseUrl: this.url, apiKey: this.key, fetch: this.fetchImpl })
			: undefined;
	}

	/** The client, for the extension's own commands; undefined while not connected. */
	async current(): Promise<VosClient | undefined> {
		await this.ready();
		return this.client;
	}

	async status(): Promise<VosConnection> {
		await this.ready();
		return this.snapshot();
	}

	private snapshot(): VosConnection {
		return {
			connected: this.client !== undefined,
			url: this.url,
			keySource: this.keySource,
			canPersist: this.canPersist,
			...(this.pairName && this.keySource !== "env" ? { deviceName: this.pairName } : {}),
			...(this.lastError ? { error: this.lastError } : {}),
		};
	}

	/**
	 * Check the key against the server, then keep it. An empty key keeps the
	 * one already held, so the address can change without pasting it again.
	 */
	async connect(url: string, key: string): Promise<VosConnection> {
		await this.ready();
		let base: string;
		try {
			base = normalizeBaseUrl(url || DEFAULT_VOS_URL);
		} catch (error) {
			return { ...this.snapshot(), error: error instanceof Error ? error.message : String(error) };
		}
		const nextKey = key.trim() || this.key;
		if (!nextKey) return { ...this.snapshot(), error: "Paste your Vos API key." };
		const probe = new VosClient({ baseUrl: base, apiKey: nextKey, fetch: this.fetchImpl });
		try {
			await probe.roster();
		} catch (error) {
			return { ...this.snapshot(), error: error instanceof Error ? error.message : String(error) };
		}
		await this.keep(base, nextKey);
		return this.snapshot();
	}

	/** Hold a key and keep it in the secret store; `name` marks a paired device key. */
	private async keep(base: string, key: string, name?: string): Promise<void> {
		this.stopAll();
		this.url = base;
		this.key = key;
		this.lastError = undefined;
		this.pairName = name;
		saveVosUrl(base, this.env);
		try {
			await this.secrets.set(SECRET_KEY, key);
			if (name) await this.secrets.set(SECRET_DEVICE, name);
			else await this.secrets.delete(SECRET_DEVICE);
			this.keySource = await this.secrets.backend();
		} catch {
			this.keySource = "memory";
		}
		this.canPersist = this.keySource !== "memory";
		this.inbox.reset();
		this.rebuild();
		this.post("connection", this.snapshot());
		this.pokeInbox();
	}

	/**
	 * Pair with the phone: the server hands out a pairing (the QR's text and
	 * six digits), and this side polls it. On approval the poll carries the
	 * device key once; it is kept like a pasted key and never reaches the
	 * view. The view hears `pair` states.
	 */
	async pairStart(
		url: string,
	): Promise<{ ok: true; value: VosPairing } | { ok: false; error: string; status: number }> {
		await this.ready();
		this.pairCancel();
		let base: string;
		try {
			base = normalizeBaseUrl(url || DEFAULT_VOS_URL);
		} catch (error) {
			return failure(error);
		}
		const name = deviceName(this.host, this.kind);
		let started: Awaited<ReturnType<typeof startPairing>>;
		try {
			started = await startPairing(base, name, this.kind, this.fetchImpl);
		} catch (error) {
			return failure(error);
		}
		const pairing = { id: started.id, timer: setTimeout(() => {}, 0) };
		this.pairing = pairing;
		const poll = async (): Promise<void> => {
			if (this.pairing !== pairing) return;
			let result: PairPoll | null = null;
			try {
				result = await pollPairing(base, started.id, started.code, this.fetchImpl);
			} catch {
				// A dropped poll is retried; the expiry decides when to stop.
			}
			if (this.pairing !== pairing) return;
			if (result?.state === "approved" && result.key) {
				this.pairing = undefined;
				await this.keep(base, result.key, name);
				this.post("pair", { id: started.id, state: "approved" });
				return;
			}
			if (result && result.state !== "pending") {
				this.pairing = undefined;
				this.post("pair", { id: started.id, state: result.state });
				return;
			}
			if (Date.now() > Date.parse(started.expiresAt) + 5000) {
				this.pairing = undefined;
				this.post("pair", { id: started.id, state: "expired" });
				return;
			}
			pairing.timer = setTimeout(() => void poll(), this.pollMs);
		};
		pairing.timer = setTimeout(() => void poll(), this.pollMs);
		return {
			ok: true,
			value: {
				id: started.id,
				qr: started.url,
				expiresAt: started.expiresAt,
				name,
				...(started.short ? { short: started.short } : {}),
			},
		};
	}

	pairCancel(): void {
		if (!this.pairing) return;
		clearTimeout(this.pairing.timer);
		this.pairing = undefined;
	}

	async disconnect(): Promise<VosConnection> {
		await this.ready();
		this.stopAll();
		await this.secrets.delete(SECRET_KEY).catch(() => {});
		await this.secrets.delete(SECRET_DEVICE).catch(() => {});
		this.pairName = undefined;
		this.key = "";
		this.keySource = "none";
		this.lastError = undefined;
		this.inbox.reset();
		this.rebuild();
		this.inboxHandlers?.onCount(undefined);
		this.post("connection", this.snapshot());
		return this.snapshot();
	}

	private need(): VosClient {
		if (!this.client) throw new VosError("Vos is not connected.", 0);
		return this.client;
	}

	/** One API call on the view's behalf, by path. Answers rather than throws. */
	async call(method: string, path: string, body?: unknown, dot?: string): Promise<VosCallResult> {
		await this.ready();
		const verb = String(method).toUpperCase();
		try {
			if (!METHODS.has(verb)) throw new VosError(`Unsupported method ${verb}`, 0);
			checkApiPath(String(path));
			if (isSecretAnswer(verb, String(path))) throw new VosError("Secrets go through their own call.", 0);
			const value = await this.need().request(verb, String(path), {
				...(dot ? { dot: String(dot) } : {}),
				...(body !== undefined && body !== null ? { body } : {}),
			});
			// Changes to the inbox show on the badge straight away.
			if (verb !== "GET" && /^\/(inbox|approvals|secrets)\b/.test(String(path))) this.pokeInbox();
			return { ok: true, value: value ?? null };
		} catch (error) {
			if (error instanceof VosError && error.status === 401) this.keyRefused();
			return failure(error);
		}
	}

	/**
	 * The server stopped accepting this key (revoked on the phone, or the
	 * server's keys changed). Holding on to it only fails every call, so
	 * forget it and say why on the connect screen.
	 */
	private keyRefused(): void {
		if (!this.client || this.keySource === "env") return;
		const paired = !!this.pairName;
		void this.disconnect().then(() => {
			this.lastError = paired
				? "This computer's key was revoked in the Vos app. Pair again to reconnect."
				: "The Vos server no longer accepts this API key. Connect again.";
			this.post("connection", this.snapshot());
		});
	}

	/** Answer a secret request. The value goes straight to the server and nowhere else. */
	async answerSecret(dot: string, id: string, value: string): Promise<VosCallResult> {
		await this.ready();
		try {
			if (typeof value !== "string" || value === "") throw new VosError("Enter the secret first.", 0);
			await this.need().answerSecret(String(dot), String(id), value);
			this.pokeInbox();
			return { ok: true, value: null };
		} catch (error) {
			return failure(error);
		}
	}

	/** A file the API serves, as a data URL the view can show without the key. */
	async file(path: string): Promise<VosCallResult> {
		await this.ready();
		try {
			const { bytes, contentType } = await this.need().file(String(path));
			const type = contentType.startsWith("image/") ? imageMime(bytes) : contentType;
			return {
				ok: true,
				value: `data:${type === "application/octet-stream" ? contentType : type};base64,${Buffer.from(bytes).toString("base64")}`,
			};
		} catch (error) {
			return failure(error);
		}
	}

	// ------------------------------------------------------------ live event streams

	/**
	 * Follow a thread's events. A watch is a lease: the view renews it while
	 * the thread is on screen, and a lease nobody renews lapses. That covers
	 * what an explicit unwatch cannot: a reload, a closed browser tab, and two
	 * windows (the app and a browser) on one thread.
	 */
	async watch(dot: string): Promise<void> {
		await this.ready();
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
			this.post("stream", { dot, state: "connecting" });
			try {
				let opened = false;
				const result = await client.events(
					dot,
					(event: VosEvent) => {
						if (!opened) {
							opened = true;
							delay = 1000;
							this.post("stream", { dot, state: "live" });
						}
						this.onStreamEvent(event);
						this.post("event", { dot, ...event });
					},
					{ signal, ...(lastEventId ? { lastEventId } : {}) },
				);
				lastEventId = result.lastEventId ?? lastEventId;
			} catch (error) {
				if (signal.aborted) return;
				this.post("stream", {
					dot,
					state: "error",
					error: error instanceof Error ? error.message : String(error),
				});
				// A refused key will not get better by asking again.
				if (error instanceof VosError && error.status === 401) {
					this.keyRefused();
					return;
				}
			}
			if (signal.aborted) return;
			await new Promise((resolve) => setTimeout(resolve, delay));
			delay = Math.min(delay * 2, 30_000);
		}
	}

	/** Inbox news can arrive on any thread's stream: notify at once rather than at the next poll. */
	private onStreamEvent(event: VosEvent): void {
		if (event.event !== "inbox.added" && event.event !== "inbox.updated") return;
		const item = (event.data as { item?: InboxItem } | null)?.item ?? (event.data as InboxItem | null);
		if (item && event.event === "inbox.added" && this.inbox.added(item)) this.inboxHandlers?.onNews(item);
		this.pokeInbox();
	}

	// ------------------------------------------------------------ the inbox, in the background

	/**
	 * Keep the inbox's count current and announce new high-priority items
	 * (approvals, secrets, safety checks, handoffs). Polled every 20 seconds:
	 * the event bus is per thread, and only the open thread is followed.
	 */
	watchInbox(onCount: (count: InboxCount | undefined) => void, onNews: (item: InboxItem) => void): void {
		this.inboxHandlers = { onCount, onNews };
		this.pokeInbox(0);
	}

	/** Check the inbox soon (at once when asked to), coalescing repeated pokes. */
	pokeInbox(delayMs = 400): void {
		if (!this.inboxHandlers) return;
		if (this.inboxTimer) clearTimeout(this.inboxTimer);
		this.inboxTimer = setTimeout(() => void this.pollInbox(), delayMs);
		this.inboxTimer.unref?.();
	}

	private async pollInbox(): Promise<void> {
		const handlers = this.inboxHandlers;
		if (!handlers) return;
		try {
			await this.ready();
			const client = this.client;
			if (!client) {
				handlers.onCount(undefined);
				return;
			}
			const [count, items] = await Promise.all([client.inboxCount(), client.inbox({ state: "open" })]);
			handlers.onCount(count);
			this.post("inbox", { count, items });
			for (const item of this.inbox.fresh(items)) handlers.onNews(item);
		} catch {
			// An older server has no inbox; the next poll tries again.
		} finally {
			if (this.inboxHandlers === handlers) {
				if (this.inboxTimer) clearTimeout(this.inboxTimer);
				this.inboxTimer = setTimeout(() => void this.pollInbox(), 20_000);
				this.inboxTimer.unref?.();
			}
		}
	}

	// ------------------------------------------------------------ the live computer view

	/**
	 * Open (or renew the lease on) the live line to a vos's computer. Frames
	 * are passed on at most four a second, newest wins. When the socket cannot
	 * open (no WebSocket with headers here, or the server refuses), the view
	 * is told and falls back to the /screens snapshots.
	 */
	async liveOpen(dot: string): Promise<VosCallResult> {
		await this.ready();
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
			return failure(error);
		}
		socket.binaryType = "arraybuffer";
		let latest: { w: number; h: number; cursor: unknown; image: Uint8Array } | undefined;
		const timer = setInterval(() => {
			if (!latest) return;
			const frame = latest;
			latest = undefined;
			this.post("frame", {
				dot,
				w: frame.w,
				h: frame.h,
				cursor: frame.cursor,
				image: `data:${imageMime(frame.image)};base64,${Buffer.from(frame.image).toString("base64")}`,
			});
		}, 250);
		socket.onopen = () => this.post("live", { dot, state: "open" });
		socket.onmessage = (event) => {
			if (event.data instanceof ArrayBuffer) latest = parseLiveFrame(new Uint8Array(event.data)) ?? latest;
		};
		const end = (state: string) => () => {
			if (this.lives.get(dot)?.socket !== socket) return;
			clearInterval(timer);
			this.lives.delete(dot);
			this.post("live", { dot, state });
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

	/** Stop everything, for good: session shutdown and tests. */
	dispose(): void {
		this.pairCancel();
		this.stopAll();
		this.inboxHandlers = undefined;
		if (this.inboxTimer) clearTimeout(this.inboxTimer);
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
