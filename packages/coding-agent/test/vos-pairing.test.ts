import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { deviceName, pollPairing, startPairing, VosError } from "../src/extensions/vos/client.ts";
import { createVosExtension, pairingMessage, pairingQrLines } from "../src/extensions/vos/index.ts";
import { encodeQr, qrSvgPath, qrTerminal } from "../src/extensions/vos/qr.ts";

/** The view half of the API, which these terminal tests do not exercise. */
const viewStubs = { registerView: () => {}, onViewRequest: () => {}, postToView: () => {}, setViewBadge: () => {} };

const PAIR = {
	id: "pr_1",
	code: "c0de-secret-c0de-secret-c0de-secret",
	short: "482913",
	expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
	url: "vos://pair?s=https%3A%2F%2Fvos.test&id=pr_1&c=c0de-secret-c0de-secret-c0de-secret",
};

describe("QR encoder", () => {
	const finder = (m: boolean[][], x: number, y: number): boolean => {
		// 7x7: dark ring, light ring, 3x3 dark centre.
		for (let dy = 0; dy < 7; dy++) {
			for (let dx = 0; dx < 7; dx++) {
				const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
				if (m[y + dy]?.[x + dx] !== (ring !== 2)) return false;
			}
		}
		return true;
	};

	test("sizes follow the version the data needs; finders and timing are in place", () => {
		const small = encodeQr("hi");
		expect(small.length).toBe(21);
		const pairing = encodeQr(PAIR.url, "M");
		expect(pairing.length).toBe(4 * Math.round((pairing.length - 17) / 4) + 17);
		expect(pairing.length).toBeGreaterThan(21);
		for (const m of [small, pairing, encodeQr("A".repeat(120), "H")]) {
			const n = m.length;
			expect(finder(m, 0, 0) && finder(m, n - 7, 0) && finder(m, 0, n - 7)).toBe(true);
			for (let i = 8; i < n - 8; i++) expect(m[6]?.[i]).toBe(i % 2 === 0);
			// The dark module beside the bottom-left finder is always set.
			expect(m[n - 8]?.[8]).toBe(true);
		}
	});

	test("is deterministic and draws as SVG and terminal half blocks", () => {
		expect(encodeQr(PAIR.url)).toEqual(encodeQr(PAIR.url));
		const m = encodeQr("hi");
		const dark = m.flat().filter(Boolean).length;
		expect(qrSvgPath(m).match(/h1v1h-1z/g)?.length).toBe(dark);
		const lines = qrTerminal(m, 2);
		expect(lines.length).toBe(Math.ceil((21 + 4) / 2));
		expect(lines.every((l) => [...l].length === 25)).toBe(true);
		expect(lines[0]).toBe("█".repeat(25));
		expect(() => encodeQr("x".repeat(3000), "H")).toThrow();
	});
});

describe("pairing client", () => {
	test("start posts name and kind outside /v1; poll reads state", async () => {
		const seen: { url: string; init?: RequestInit }[] = [];
		const fetchImpl = (async (url: string, init?: RequestInit) => {
			seen.push({ url, init });
			if (url.endsWith("/pair")) return new Response(JSON.stringify(PAIR), { status: 201 });
			return new Response(JSON.stringify({ state: "pending" }));
		}) as typeof fetch;
		expect(await startPairing("vos.test/v1", "smolt on DESK", "smolt-desktop", fetchImpl)).toEqual(PAIR);
		expect(seen[0]?.url).toBe("https://vos.test/pair");
		expect(JSON.parse(String(seen[0]?.init?.body))).toEqual({ name: "smolt on DESK", kind: "smolt-desktop" });
		expect((seen[0]?.init?.headers as Record<string, string>).authorization).toBeUndefined();
		expect(await pollPairing("https://vos.test", "pr_1", "a b", fetchImpl)).toEqual({ state: "pending" });
		expect(seen[1]?.url).toBe("https://vos.test/pair/pr_1?c=a%20b");
	});

	test("a server without pairing, or rate limiting, says so; a vanished pair reads as expired", async () => {
		const answer = (status: number) => (async () => new Response("{}", { status })) as typeof fetch;
		await expect(startPairing("https://vos.test", "n", "smolt-tui", answer(404))).rejects.toThrow("cannot pair yet");
		await expect(startPairing("https://vos.test", "n", "smolt-tui", answer(429))).rejects.toBeInstanceOf(VosError);
		expect(await pollPairing("https://vos.test", "x", "y", answer(404))).toEqual({ state: "expired" });
		expect(deviceName("DESK.local", "smolt-tui")).toBe("smolt (terminal) on DESK");
	});
});

describe("/vos connect in the terminal", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "vos-pair-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	function harness(polls: object[]) {
		const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
		const said: string[] = [];
		const widgets: (unknown | undefined)[] = [];
		const path = join(dir, "vos.json");
		const fetchImpl = (async (url: string) => {
			if (url.endsWith("/pair")) return new Response(JSON.stringify(PAIR), { status: 201 });
			return new Response(JSON.stringify(polls.shift() ?? { state: "pending" }));
		}) as typeof fetch;
		const secrets = new Map<string, string>();
		const smolt = {
			...viewStubs,
			registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
				commands.set(name, options),
			sendMessage: (message: { content: string }) => said.push(message.content),
			on: () => {},
			secrets: {
				get: async (key: string) => secrets.get(key),
				set: async (key: string, value: string) => void secrets.set(key, value),
				delete: async (key: string) => void secrets.delete(key),
				backend: async () => "file",
			},
		} as unknown as ExtensionAPI;
		createVosExtension({ env: { SMOLT_VOS_CONFIG: path }, fetch: fetchImpl, pollMs: 5, host: "DESK" })(smolt);
		const ctx = {
			ui: {
				notify: () => {},
				setStatus: () => {},
				setWidget: (_key: string, content: unknown) => widgets.push(content),
			},
		};
		return { run: (args: string) => commands.get("vos")!.handler(args, ctx), said, widgets, path, secrets };
	}

	test("shows the QR and code, then keeps the approved device key in the secret store", async () => {
		const h = harness([{ state: "pending" }, { state: "approved", key: "vosd_abc" }]);
		await h.run("connect");
		expect(h.said[0]).toContain("482 913");
		const widget = h.widgets[0] as () => { render: () => string[] };
		expect(widget().render().length).toBeGreaterThan(10);
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(h.said.at(-1)).toContain("Connected as **smolt (terminal) on DESK**");
		expect(h.widgets.at(-1)).toBeUndefined();
		expect(h.said.at(-1)).toContain("in a file only you can read");
		expect(h.secrets.get("apiKey")).toBe("vosd_abc");
		expect(h.secrets.get("deviceName")).toBe("smolt (terminal) on DESK");
		const file = readFileSync(h.path, "utf-8");
		expect(file).not.toContain("vosd_abc");
		expect(JSON.parse(file)).toEqual({ url: "https://vos-api.vosgrau.com" });
		if (process.platform !== "win32") expect(statSync(h.path).mode & 0o777).toBe(0o600);
	});

	test("a declined pairing says so and saves nothing", async () => {
		const h = harness([{ state: "denied" }]);
		await h.run("connect");
		await new Promise((resolve) => setTimeout(resolve, 40));
		expect(h.said.at(-1)).toContain("declined");
		expect(() => readFileSync(h.path, "utf-8")).toThrow();
		expect(h.secrets.size).toBe(0);
	});

	test("the message carries the digits; the QR lines force white on black", () => {
		expect(pairingMessage(PAIR, 5)).toContain("Enter **482 913**");
		expect(pairingMessage(PAIR, 5)).not.toContain(PAIR.code);
		expect(pairingQrLines(PAIR)[0]).toMatch(/^\x1b\[38;2;255;255;255m\x1b\[48;2;0;0;0m/);
	});
});

describe("a revoked key", () => {
	test("tells the terminal to pair again", async () => {
		const notes: string[] = [];
		const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
		const smolt = {
			...viewStubs,
			registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
				commands.set(name, options),
			sendMessage: () => {},
			on: () => {},
		} as unknown as ExtensionAPI;
		const fetchImpl = (async () =>
			new Response(JSON.stringify({ error: "Missing or wrong API key." }), { status: 401 })) as typeof fetch;
		createVosExtension({
			env: { VOS_API_KEY: "vosd_gone", SMOLT_VOS_CONFIG: join(tmpdir(), "none.json") },
			fetch: fetchImpl,
		})(smolt);
		await commands.get("vos")!.handler("", { ui: { notify: (t: string) => notes.push(t), setStatus: () => {} } });
		expect(notes[0]).toContain("/vos connect");
	});
});
