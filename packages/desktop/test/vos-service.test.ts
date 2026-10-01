import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { imageMime, type KeyCipher, LEASE_MS, parseLiveFrame, VosService } from "../src/main/vos.ts";

/** A stand-in for safeStorage: reversible, and obviously not the plain key. */
const cipher = (available = true): KeyCipher => ({
	available: () => available,
	encrypt: (plain) => Buffer.from(`enc:${plain}`).toString("base64"),
	decrypt: (encoded) => Buffer.from(encoded, "base64").toString().replace(/^enc:/, ""),
});

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
	const make = (options: Partial<ConstructorParameters<typeof VosService>[0]> = {}) => {
		const sent: { channel: string; payload: unknown }[] = [];
		const service = new VosService({
			cipher: cipher(),
			send: (channel, payload) => sent.push({ channel, payload }),
			path,
			env: {},
			...options,
		});
		services.push(service);
		return { service, sent };
	};

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "vos-service-"));
		path = join(dir, "vos.json");
	});
	afterEach(() => {
		for (const s of services.splice(0)) s.dispose();
		rmSync(dir, { recursive: true, force: true });
	});

	test("connect checks the key, then keeps it encrypted, never in plain text", async () => {
		const seen: Seen[] = [];
		const { service } = make({ fetch: fakeFetch(seen, roster) });
		const status = await service.connect("127.0.0.1:8787/v1", "secret-key-1");
		expect(status).toMatchObject({ connected: true, keySource: "encrypted", url: "https://127.0.0.1:8787" });
		expect(seen[0]?.headers.authorization).toBe("Bearer secret-key-1");
		const file = readFileSync(path, "utf-8");
		expect(file).not.toContain("secret-key-1");
		expect(JSON.parse(file)).toMatchObject({ url: "https://127.0.0.1:8787", encryptedKey: expect.any(String) });

		// A fresh process reads it back.
		const again = make({ fetch: fakeFetch(seen, roster) }).service;
		expect(again.status()).toMatchObject({ connected: true, keySource: "encrypted" });
	});

	test("a refused key is not kept, and the error says why", async () => {
		const { service } = make({
			fetch: fakeFetch(
				[],
				() => new Response(JSON.stringify({ error: "Missing or wrong API key." }), { status: 401 }),
			),
		});
		const status = await service.connect("https://vos.test", "nope");
		expect(status.connected).toBe(false);
		expect(status.error).toBe("Missing or wrong API key.");
		expect(() => readFileSync(path, "utf-8")).toThrow();
	});

	test("without a keystore the key lives for the session only", async () => {
		const { service } = make({ cipher: cipher(false), fetch: fakeFetch([], roster) });
		expect((await service.connect("https://vos.test", "k")).keySource).toBe("session");
		expect(JSON.parse(readFileSync(path, "utf-8")).encryptedKey).toBeUndefined();
	});

	test("VOS_API_KEY works when nothing is saved; disconnect forgets a saved key", async () => {
		expect(make({ env: { VOS_API_KEY: "env-key" } }).service.status()).toMatchObject({
			connected: true,
			keySource: "env",
		});
		const { service } = make({ fetch: fakeFetch([], roster) });
		await service.connect("https://vos.test", "k");
		expect(service.disconnect()).toMatchObject({ connected: false, keySource: "none" });
		expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ url: "https://vos.test" });
	});

	test("calls go by path with the vos header; paths off the API and secrets are refused", async () => {
		const seen: Seen[] = [];
		const { service } = make({ fetch: fakeFetch(seen, () => new Response(JSON.stringify([{ id: "r1" }]))) });
		writeFileSync(path, JSON.stringify({ url: "https://vos.test", encryptedKey: cipher().encrypt("k") }));
		const fresh = make({ fetch: fakeFetch(seen, () => new Response(JSON.stringify([{ id: "r1" }]))) }).service;
		expect(service.status().connected).toBe(false);
		const result = await fresh.call("get", "/routines", undefined, "ada");
		expect(result).toEqual({ ok: true, value: [{ id: "r1" }] });
		expect(seen.at(-1)).toMatchObject({ url: "https://vos.test/v1/routines", method: "GET" });
		expect(seen.at(-1)?.headers["x-vos-dot"]).toBe("ada");

		for (const bad of ["https://evil.test/x", "//evil.test", "/../hooks/x", "/v1/dots"]) {
			expect(await fresh.call("GET", bad)).toMatchObject({ ok: false });
		}
		expect(await fresh.call("TRACE", "/dots")).toMatchObject({ ok: false });
		const count = seen.length;
		expect(await fresh.call("POST", "/secrets/s1", { value: "hunter2" }, "main")).toMatchObject({ ok: false });
		expect(seen.length).toBe(count);
		// Declining is not answering: it may go through the general call.
		expect(await fresh.call("POST", "/secrets/s1/decline", {}, "main")).toMatchObject({ ok: true });
	});

	test("a secret goes through its own call, and a failure never echoes it", async () => {
		const seen: Seen[] = [];
		writeFileSync(path, JSON.stringify({ url: "https://vos.test", encryptedKey: cipher().encrypt("k") }));
		const { service } = make({
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
		writeFileSync(path, JSON.stringify({ url: "https://vos.test", encryptedKey: cipher().encrypt("k") }));
		const { service } = make({
			fetch: fakeFetch([], () => new Response(png, { headers: { "content-type": "image/jpeg" } })),
		});
		const result = await service.file("/v1/files/abc");
		expect(result).toEqual({ ok: true, value: `data:image/png;base64,${Buffer.from(png).toString("base64")}` });
		expect(await service.file("https://elsewhere.test/x.png")).toMatchObject({ ok: false });
	});

	test("watches are leases: renewed while open, swept when they lapse", async () => {
		writeFileSync(path, JSON.stringify({ url: "https://vos.test", encryptedKey: cipher().encrypt("k") }));
		const { service, sent } = make({
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
		service.watch("ada");
		service.watch("ada");
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(service.watching()).toEqual(["ada"]);
		expect(sent).toContainEqual({
			channel: "vos:event",
			payload: { dot: "ada", event: "status", data: { mood: "working" }, id: "5" },
		});
		expect(sent).toContainEqual({ channel: "vos:stream", payload: { dot: "ada", state: "live" } });
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
		writeFileSync(path, JSON.stringify({ url: "https://vos.test", encryptedKey: cipher().encrypt("k") }));
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
		const { service, sent } = make({
			socket: (url, headers) => {
				opened.push({ url, headers });
				return socket;
			},
		});
		expect(service.liveOpen("ada")).toEqual({ ok: true, value: null });
		expect(opened[0]).toEqual({
			url: "wss://vos.test/v1/computer/live",
			headers: { authorization: "Bearer k", "x-vos-dot": "ada" },
		});
		const bytes = Uint8Array.from([...Buffer.from('{"w":2,"h":1}\n'), 0xff, 0xd8, 0xff]);
		socket.onmessage?.({ data: bytes.buffer });
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(sent.find((s) => s.channel === "vos:frame")?.payload).toMatchObject({
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
});
