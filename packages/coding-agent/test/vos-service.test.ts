import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ExtensionSecrets, SecretBackend } from "../src/core/extensions/types.ts";
import {
	InboxTracker,
	imageMime,
	LEASE_MS,
	parseLiveFrame,
	VosService,
	type VosServiceOptions,
} from "../src/extensions/vos/service.ts";
import type { InboxItem } from "../src/extensions/vos/types.ts";

/** An in-memory secret store, as the host would provide one. */
function memorySecrets(backend: SecretBackend = "keychain"): ExtensionSecrets & { values: Map<string, string> } {
	const values = new Map<string, string>();
	return {
		values,
		get: async (key) => values.get(key),
		set: async (key, value) => {
			values.set(key, value);
		},
		delete: async (key) => {
			values.delete(key);
		},
		backend: async () => backend,
	};
}

interface Seen {
	url: string;
	method: string;
	headers: Record<string, string>;
	body?: string;
}

function fakeFetch(seen: Seen[], answer: (url: URL, init: RequestInit) => Response = () => new Response("{}")) {
	return (async (input: string, init: RequestInit = {}) => {
		seen.push({
			url: input,
			method: init.method ?? "GET",
			headers: (init.headers ?? {}) as Record<string, string>,
			body: typeof init.body === "string" ? init.body : undefined,
		});
		return answer(new URL(input), init);
	}) as typeof fetch;
}

const roster = () => new Response(JSON.stringify({ dots: [{ id: "main", name: "Vos" }], groups: [] }));

describe("VosService", () => {
	let dir: string;
	let path: string;
	const services: VosService[] = [];
	const make = (options: Partial<VosServiceOptions> = {}) => {
		const posted: { event: string; data: unknown }[] = [];
		const secrets = (options.secrets as ReturnType<typeof memorySecrets> | undefined) ?? memorySecrets();
		const service = new VosService({
			post: (event, data) => posted.push({ event, data }),
			env: { SMOLT_VOS_CONFIG: path },
			...options,
			secrets,
		});
		services.push(service);
		return { service, posted, secrets };
	};
	/** A store that already holds a key for the test server. */
	const keyed = () => {
		const secrets = memorySecrets();
		secrets.values.set("apiKey", "k");
		writeFileSync(path, JSON.stringify({ url: "https://vos.test" }));
		return secrets;
	};

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "vos-service-"));
		path = join(dir, "vos.json");
	});
	afterEach(() => {
		for (const s of services.splice(0)) s.dispose();
		rmSync(dir, { recursive: true, force: true });
	});

	test("connect checks the key, then keeps it in the secret store, never in the file", async () => {
		const seen: Seen[] = [];
		const { service, secrets, posted } = make({ fetch: fakeFetch(seen, roster) });
		const status = await service.connect("127.0.0.1:8787/v1", "secret-key-1");
		expect(status).toMatchObject({ connected: true, keySource: "keychain", url: "https://127.0.0.1:8787" });
		expect(seen[0]?.headers.authorization).toBe("Bearer secret-key-1");
		expect(secrets.values.get("apiKey")).toBe("secret-key-1");
		const file = readFileSync(path, "utf-8");
		expect(file).not.toContain("secret-key-1");
		expect(JSON.parse(file)).toEqual({ url: "https://127.0.0.1:8787" });
		expect(posted.find((p) => p.event === "connection")?.data).toMatchObject({ connected: true });

		// A fresh process reads it back from the same store.
		const again = make({ secrets, fetch: fakeFetch(seen, roster) }).service;
		expect(await again.status()).toMatchObject({ connected: true, keySource: "keychain" });
	});

	test("a refused key is not kept, and the error says why", async () => {
		const { service, secrets } = make({
			fetch: fakeFetch(
				[],
				() => new Response(JSON.stringify({ error: "Missing or wrong API key." }), { status: 401 }),
			),
		});
		const status = await service.connect("https://vos.test", "nope");
		expect(status.connected).toBe(false);
		expect(status.error).toBe("Missing or wrong API key.");
		expect(secrets.values.size).toBe(0);
		expect(existsSync(path)).toBe(false);
	});

	test("a host without a keystore keeps the key for this process only, and says so", async () => {
		const { service } = make({ secrets: memorySecrets("memory"), fetch: fakeFetch([], roster) });
		expect(await service.connect("https://vos.test", "k")).toMatchObject({ keySource: "memory", canPersist: false });
	});

	test("the terminal's old key in vos.json moves into the secret store once", async () => {
		writeFileSync(
			path,
			JSON.stringify({ url: "https://vos.test", apiKey: "old-key", deviceName: "smolt (terminal) on X" }),
		);
		const { service, secrets } = make();
		expect(await service.status()).toMatchObject({ connected: true, deviceName: "smolt (terminal) on X" });
		expect(secrets.values.get("apiKey")).toBe("old-key");
		expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ url: "https://vos.test" });
	});

	test("VOS_API_KEY works when nothing is saved; disconnect forgets a saved key", async () => {
		expect(await make({ env: { VOS_API_KEY: "env-key", SMOLT_VOS_CONFIG: path } }).service.status()).toMatchObject({
			connected: true,
			keySource: "env",
		});
		const { service, secrets } = make({ fetch: fakeFetch([], roster) });
		await service.connect("https://vos.test", "k");
		expect(await service.disconnect()).toMatchObject({ connected: false, keySource: "none" });
		expect(secrets.values.size).toBe(0);
		expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ url: "https://vos.test" });
	});

	test("calls go by path with the vos header; paths off the API and secrets are refused", async () => {
		const seen: Seen[] = [];
		const { service } = make({
			secrets: keyed(),
			fetch: fakeFetch(seen, () => new Response(JSON.stringify([{ id: "r1" }]))),
		});
		const result = await service.call("get", "/routines", undefined, "ada");
		expect(result).toEqual({ ok: true, value: [{ id: "r1" }] });
		expect(seen.at(-1)).toMatchObject({ url: "https://vos.test/v1/routines", method: "GET" });
		expect(seen.at(-1)?.headers["x-vos-dot"]).toBe("ada");

		for (const bad of ["https://evil.test/x", "//evil.test", "/../hooks/x", "/v1/dots"]) {
			expect(await service.call("GET", bad)).toMatchObject({ ok: false });
		}
		expect(await service.call("TRACE", "/dots")).toMatchObject({ ok: false });
		const count = seen.length;
		expect(await service.call("POST", "/secrets/s1", { value: "hunter2" }, "main")).toMatchObject({ ok: false });
		expect(seen.length).toBe(count);
		// Declining is not answering: it may go through the general call.
		expect(await service.call("POST", "/secrets/s1/decline", {}, "main")).toMatchObject({ ok: true });
	});

	test("a key the server stops accepting is forgotten, with the reason on the connect screen", async () => {
		const { service, secrets, posted } = make({
			secrets: keyed(),
			fetch: fakeFetch([], () => new Response(JSON.stringify({ error: "revoked" }), { status: 401 })),
		});
		expect(await service.call("GET", "/dots")).toMatchObject({ ok: false, status: 401 });
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(secrets.values.has("apiKey")).toBe(false);
		expect(posted.at(-1)).toMatchObject({
			event: "connection",
			data: { connected: false, error: expect.any(String) },
		});
	});

	test("a secret goes through its own call, and a failure never echoes it", async () => {
		const seen: Seen[] = [];
		const { service } = make({
			secrets: keyed(),
			fetch: fakeFetch(
				seen,
				() => new Response(JSON.stringify({ error: "That request has expired." }), { status: 404 }),
			),
		});
		const result = await service.answerSecret("main", "s1", "hunter2");
		expect(JSON.parse(seen[0]?.body ?? "{}")).toEqual({ value: "hunter2" });
		expect(result).toEqual({ ok: false, error: "That request has expired.", status: 404 });
		expect(JSON.stringify(result)).not.toContain("hunter2");
		expect(await service.answerSecret("main", "s1", "")).toMatchObject({ ok: false });
	});

	test("files come back as data URLs typed by their bytes", async () => {
		const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
		const { service } = make({
			secrets: keyed(),
			fetch: fakeFetch([], () => new Response(png, { headers: { "content-type": "image/jpeg" } })),
		});
		const result = await service.file("/v1/files/abc");
		expect(result).toEqual({ ok: true, value: `data:image/png;base64,${Buffer.from(png).toString("base64")}` });
		expect(await service.file("https://elsewhere.test/x.png")).toMatchObject({ ok: false });
	});

	test("watches are leases: renewed while open, swept when they lapse", async () => {
		const { service, posted } = make({
			secrets: keyed(),
			fetch: fakeFetch([], (_url, init) => {
				const signal = init.signal as AbortSignal;
				return new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new TextEncoder().encode('id: 5\nevent: status\ndata: {"mood":"working"}\n\n'));
							signal.addEventListener("abort", () => controller.error(new Error("aborted")));
						},
					}),
				);
			}),
		});
		await service.watch("ada");
		await service.watch("ada");
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(service.watching()).toEqual(["ada"]);
		expect(posted).toContainEqual({
			event: "event",
			data: { dot: "ada", event: "status", data: { mood: "working" }, id: "5" },
		});
		expect(posted).toContainEqual({ event: "stream", data: { dot: "ada", state: "live" } });
		service.sweep(Date.now() + LEASE_MS + 1);
		expect(service.watching()).toEqual([]);
	});

	test("live frames are split and typed", () => {
		const png = [0x89, 0x50, 0x4e, 0x47];
		const frame = parseLiveFrame(Uint8Array.from([...Buffer.from('{"w":4,"h":3,"cursor":null}\n'), ...png]));
		expect(frame).toMatchObject({ w: 4, h: 3, cursor: null });
		expect(imageMime(frame?.image ?? new Uint8Array())).toBe("image/png");
		expect(imageMime(Uint8Array.from([0xff, 0xd8, 0xff]))).toBe("image/jpeg");
		expect(parseLiveFrame(Uint8Array.from([1, 2, 3]))).toBeUndefined();
	});

	test("the live view opens a socket with the key in a header and passes frames on, throttled", async () => {
		const opened: { url: string; headers: Record<string, string> }[] = [];
		const socket = {
			readyState: 1,
			binaryType: "",
			sent: [] as string[],
			send(data: string) {
				this.sent.push(data);
			},
			close() {},
			onopen: null as ((e: unknown) => void) | null,
			onmessage: null as ((e: { data: unknown }) => void) | null,
			onclose: null as ((e: unknown) => void) | null,
			onerror: null as ((e: unknown) => void) | null,
		};
		const { service, posted } = make({
			secrets: keyed(),
			socket: (url, headers) => {
				opened.push({ url, headers });
				return socket;
			},
		});
		expect(await service.liveOpen("ada")).toEqual({ ok: true, value: null });
		expect(opened[0]).toEqual({
			url: "wss://vos.test/v1/computer/live",
			headers: { authorization: "Bearer k", "x-vos-dot": "ada" },
		});
		const bytes = Uint8Array.from([...Buffer.from('{"w":2,"h":1}\n'), 0xff, 0xd8, 0xff]);
		socket.onmessage?.({ data: bytes.buffer });
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(posted.find((s) => s.event === "frame")?.data).toMatchObject({
			dot: "ada",
			w: 2,
			h: 1,
			image: expect.stringMatching(/^data:image\/jpeg;base64,/),
		});
		expect(service.liveInput("ada", { kind: "tap", x: 0.5, y: 0.5 })).toMatchObject({ ok: true });
		expect(socket.sent).toEqual(['{"kind":"tap","x":0.5,"y":0.5}']);
		service.liveClose("ada");
		expect(service.liveInput("ada", { kind: "tap" })).toMatchObject({ ok: false });
	});

	test("pairing: the view gets the QR text, the service gets the key and keeps it in the store", async () => {
		const pair = {
			id: "pr_1",
			code: "secret-code-secret-code-secret-code",
			short: "123456",
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
			url: "vos://pair?s=https%3A%2F%2Fvos.test&id=pr_1&c=secret-code-secret-code-secret-code",
		};
		const polls = [{ state: "pending" }, { state: "approved", key: "vosd_devicekey" }];
		const seen: Seen[] = [];
		const { service, posted, secrets } = make({
			pollMs: 5,
			host: "DESK",
			fetch: fakeFetch(seen, (url) =>
				url.pathname === "/pair"
					? new Response(JSON.stringify(pair), { status: 201 })
					: new Response(JSON.stringify(polls.shift() ?? { state: "pending" })),
			),
		});
		const started = await service.pairStart("https://vos.test");
		expect(started).toEqual({
			ok: true,
			value: { id: "pr_1", qr: pair.url, short: "123456", expiresAt: pair.expiresAt, name: "smolt on DESK" },
		});
		expect(JSON.parse(seen[0]?.body ?? "{}")).toEqual({ name: "smolt on DESK", kind: "smolt-desktop" });
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(posted).toContainEqual({ event: "pair", data: { id: "pr_1", state: "approved" } });
		expect(JSON.stringify(posted)).not.toContain("vosd_devicekey");
		expect(await service.status()).toMatchObject({
			connected: true,
			keySource: "keychain",
			deviceName: "smolt on DESK",
		});
		expect(secrets.values.get("apiKey")).toBe("vosd_devicekey");
		expect(readFileSync(path, "utf-8")).not.toContain("vosd_devicekey");
		// Disconnecting forgets the key and the paired name.
		expect(await service.disconnect()).toMatchObject({ connected: false });
		expect(secrets.values.size).toBe(0);
	});

	test("pairing that is declined or cancelled keeps nothing", async () => {
		const pair = {
			id: "pr_2",
			code: "c".repeat(32),
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
			url: "vos://x",
		};
		const { service, posted } = make({
			pollMs: 5,
			fetch: fakeFetch([], (url) =>
				url.pathname === "/pair"
					? new Response(JSON.stringify(pair))
					: new Response(JSON.stringify({ state: "denied" })),
			),
		});
		await service.pairStart("https://vos.test");
		await new Promise((resolve) => setTimeout(resolve, 40));
		expect(posted).toContainEqual({ event: "pair", data: { id: "pr_2", state: "denied" } });
		expect((await service.status()).connected).toBe(false);
		await service.pairStart("https://vos.test");
		service.pairCancel();
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(posted.filter((s) => s.event === "pair").length).toBe(1);
	});

	test("the inbox watcher reports the count and announces only new high-priority items", async () => {
		const item = (id: string, priority: InboxItem["priority"]): InboxItem => ({
			id,
			vos: "main",
			kind: priority === "high" ? "approval" : "finding",
			title: id,
			priority,
			state: "open",
			date: "2026-10-03T10:00:00Z",
		});
		let open = [item("a", "high"), item("b", "low")];
		const { service, posted } = make({
			secrets: keyed(),
			fetch: fakeFetch([], (url) =>
				url.pathname === "/v1/inbox/count"
					? new Response(
							JSON.stringify({ open: open.length, high: open.filter((i) => i.priority === "high").length }),
						)
					: new Response(JSON.stringify(open)),
			),
		});
		const counts: unknown[] = [];
		const news: string[] = [];
		service.watchInbox(
			(count) => counts.push(count),
			(i) => news.push(i.id),
		);
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(counts.at(-1)).toEqual({ open: 2, high: 1 });
		expect(news).toEqual([]);
		expect(posted.find((p) => p.event === "inbox")?.data).toMatchObject({ count: { open: 2 } });
		open = [...open, item("c", "high"), item("d", "normal")];
		service.pokeInbox(0);
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(news).toEqual(["c"]);
	});
});

describe("InboxTracker", () => {
	const item = (id: string, priority: InboxItem["priority"], state: InboxItem["state"] = "open"): InboxItem => ({
		id,
		vos: "main",
		kind: "approval",
		title: id,
		priority,
		state,
		date: "",
	});

	test("the first look primes; later only new open high items are news; events too", () => {
		const tracker = new InboxTracker();
		expect(tracker.fresh([item("a", "high")])).toEqual([]);
		expect(
			tracker.fresh([item("a", "high"), item("b", "high"), item("c", "normal"), item("d", "high", "done")]),
		).toEqual([item("b", "high")]);
		expect(tracker.added(item("e", "high"))).toBe(true);
		expect(tracker.added(item("e", "high"))).toBe(false);
		expect(tracker.fresh([item("e", "high")])).toEqual([]);
	});
});
