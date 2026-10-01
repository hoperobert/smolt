import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { checkApiPath, groupDot, normalizeBaseUrl, VosClient, VosError } from "../src/extensions/vos/client.ts";
import { readVosFile, resolveVosConfig, writeVosFile } from "../src/extensions/vos/config.ts";
import {
	describeTrigger,
	elapsed,
	filterSkills,
	insertMention,
	linkify,
	mentionQuery,
	rruleToSchedule,
	scheduleToRrule,
	slashQuery,
	sortRoster,
	unreadTotal,
	vosColor,
} from "../src/extensions/vos/format.ts";
import { createVosExtension, findThread, splitNameAndMessage } from "../src/extensions/vos/index.ts";
import { SseParser } from "../src/extensions/vos/sse.ts";
import type { Roster, RosterDot, Skill } from "../src/extensions/vos/types.ts";

const dot = (id: string, name: string, extra: Partial<RosterDot> = {}): RosterDot => ({
	id,
	name,
	look: { color: "sky" },
	isPaused: false,
	createdAt: `2026-0${id.length}-01T00:00:00Z`,
	...extra,
});

const roster: Roster = {
	dots: [
		dot("main", "Vos", { unread: 2 }),
		dot("r1", "Ada Lovelace", { label: "Research", pinned: true, unread: 1 }),
		dot("h1", "Old", { hidden: true, unread: 9 }),
	],
	groups: [{ id: "g1", name: "Launch crew", members: ["r1", "main"], createdAt: "2026-01-01T00:00:00Z", unread: 3 }],
};

describe("SseParser", () => {
	test("joins events split across chunks, CRLF pairs included", () => {
		const parser = new SseParser();
		expect(parser.push("event: message.cr")).toEqual([]);
		expect(parser.push('eated\r\ndata: {"id":"m1"}\r')).toEqual([]);
		const out = parser.push("\nid: 7\r\n\r\n: heartbeat\n\nevent: status\ndata: a\ndata: b\n\n");
		expect(out).toEqual([
			{ event: "message.created", data: '{"id":"m1"}', id: "7" },
			{ event: "status", data: "a\nb" },
		]);
		expect(parser.lastEventId).toBe("7");
	});

	test("an event with no name is a message; comments and empty blocks emit nothing", () => {
		const parser = new SseParser();
		expect(parser.push(": hi\n\n\ndata:x\n\n")).toEqual([{ event: "message", data: "x" }]);
	});
});

describe("VosClient", () => {
	test("normalizes the server address", () => {
		expect(normalizeBaseUrl("vos-api.vosgrau.com/")).toBe("https://vos-api.vosgrau.com");
		expect(normalizeBaseUrl("https://vos-api.vosgrau.com/v1/")).toBe("https://vos-api.vosgrau.com");
		expect(normalizeBaseUrl("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
		expect(normalizeBaseUrl("")).toBe("https://vos-api.vosgrau.com");
		expect(() => normalizeBaseUrl("ftp://x")).toThrow();
	});

	test("refuses paths that would leave the API", () => {
		expect(checkApiPath("/dots")).toBe("/dots");
		expect(checkApiPath("/messages?limit=5")).toBe("/messages?limit=5");
		for (const bad of ["dots", "//evil.com/x", "/../x", "/a/./b", "/v1/dots", "/a b", "/a\\b"]) {
			expect(() => checkApiPath(bad)).toThrow();
		}
	});

	test("sends the key and the vos header, and parses JSON", async () => {
		const calls: { url: string; init: RequestInit }[] = [];
		const client = new VosClient({
			baseUrl: "https://vos.test",
			apiKey: "k-123",
			fetch: (async (url: string, init: RequestInit) => {
				calls.push({ url, init });
				return new Response(JSON.stringify({ message: { id: "m1", role: "you", text: "hi", date: "" } }), {
					status: 202,
				});
			}) as typeof fetch,
		});
		const message = await client.send(groupDot("g1"), "hi", "c1");
		expect(message.id).toBe("m1");
		expect(calls[0]?.url).toBe("https://vos.test/v1/messages");
		const headers = calls[0]?.init.headers as Record<string, string>;
		expect(headers.authorization).toBe("Bearer k-123");
		expect(headers["x-vos-dot"]).toBe("group:g1");
		expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ text: "hi", clientId: "c1" });
	});

	test("account-wide calls send no vos header; list shapes are accepted either way", async () => {
		const seen: Record<string, string>[] = [];
		const client = new VosClient({
			baseUrl: "https://vos.test",
			apiKey: "k",
			fetch: (async (_url: string, init: RequestInit) => {
				seen.push(init.headers as Record<string, string>);
				return new Response(JSON.stringify({ skills: [{ id: "s1" }] }));
			}) as typeof fetch,
		});
		expect(await client.skills()).toEqual([{ id: "s1" }]);
		expect(seen[0]?.["x-vos-dot"]).toBeUndefined();
	});

	test("errors carry the server's message and never the request body", async () => {
		const client = new VosClient({
			baseUrl: "https://vos.test",
			apiKey: "k",
			fetch: (async () => new Response(JSON.stringify({ error: "Expired" }), { status: 409 })) as typeof fetch,
		});
		const error = await client.answerSecret("main", "s1", "hunter2").catch((e: unknown) => e);
		expect(error).toBeInstanceOf(VosError);
		expect((error as VosError).message).toBe("Expired");
		expect((error as VosError).status).toBe(409);
		expect(String((error as Error).message)).not.toContain("hunter2");

		const offline = new VosClient({
			baseUrl: "https://vos.test",
			apiKey: "k",
			fetch: (async () => {
				throw new TypeError("fetch failed: hunter2");
			}) as typeof fetch,
		});
		const down = await offline.answerSecret("main", "s1", "hunter2").catch((e: unknown) => e);
		expect(String((down as Error).message)).not.toContain("hunter2");
		expect((down as VosError).status).toBe(0);
	});

	test("a 401 without a body says the key was refused", async () => {
		const client = new VosClient({
			baseUrl: "https://vos.test",
			apiKey: "k",
			fetch: (async () => new Response("", { status: 401 })) as typeof fetch,
		});
		await expect(client.roster()).rejects.toThrow("did not accept the API key");
	});

	test("events streams parsed JSON events and reports the last id", async () => {
		const encoder = new TextEncoder();
		const chunks = [
			'event: status\ndata: {"mood":"working"}\n\n',
			'id: 4\nevent: message.created\ndata: {"id":',
			'"m2"}\n\n',
		];
		let headers: Record<string, string> = {};
		const client = new VosClient({
			baseUrl: "https://vos.test",
			apiKey: "k",
			fetch: (async (_url: string, init: RequestInit) => {
				headers = init.headers as Record<string, string>;
				return new Response(
					new ReadableStream({
						start(controller) {
							for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
							controller.close();
						},
					}),
				);
			}) as typeof fetch,
		});
		const events: unknown[] = [];
		const result = await client.events("r1", (e) => events.push(e), { lastEventId: "3" });
		expect(headers["last-event-id"]).toBe("3");
		expect(headers["x-vos-dot"]).toBe("r1");
		expect(events).toEqual([
			{ event: "status", data: { mood: "working" } },
			{ event: "message.created", data: { id: "m2" }, id: "4" },
		]);
		expect(result.lastEventId).toBe("4");
	});
});

describe("format", () => {
	test("roster order: pinned, then main, then oldest; hidden apart; unread skips hidden", () => {
		const { shown, hidden } = sortRoster(roster.dots);
		expect(shown.map((d) => d.id)).toEqual(["r1", "main"]);
		expect(hidden.map((d) => d.id)).toEqual(["h1"]);
		expect(unreadTotal(roster)).toBe(6);
	});

	test("colours: names, hex, and a stable fallback", () => {
		expect(vosColor({ color: "salmon" })).toBe("#fa8072");
		expect(vosColor({ color: "#123456" })).toBe("#123456");
		expect(vosColor({}, "abc")).toBe(vosColor({}, "abc"));
	});

	test("schedules round-trip through RRULE", () => {
		for (const s of [
			{ frequency: "daily", hour: 8, minute: 0, day: "MO" },
			{ frequency: "weekdays", hour: 17, minute: 30, day: "MO" },
			{ frequency: "weekly", hour: 9, minute: 5, day: "FR" },
		] as const) {
			expect(rruleToSchedule(scheduleToRrule(s))).toEqual(s);
		}
		expect(rruleToSchedule("FREQ=MONTHLY;BYMONTHDAY=1")).toBeNull();
		expect(
			describeTrigger({ type: "schedule", rrule: "FREQ=DAILY;BYHOUR=8;BYMINUTE=0", timezone: "Europe/London" }),
		).toBe("Every day at 08:00 (Europe/London)");
		expect(describeTrigger({ type: "slack", keyword: "deploy", channel: "#ops" })).toBe(
			'When Slack says "deploy" in #ops',
		);
		expect(describeTrigger({ type: "pagerduty" })).toBe("On a PagerDuty event");
	});

	test("bare links become markdown links; existing ones are left alone", () => {
		expect(linkify("see https://example.com/a?b=1.")).toBe(
			"see [https://example.com/a?b=1](https://example.com/a?b=1).",
		);
		expect(linkify("[report](https://x.test/r)")).toBe("[report](https://x.test/r)");
	});

	test("timer text", () => {
		const start = "2026-10-01T10:00:00Z";
		const at = Date.parse(start);
		expect(elapsed(start, at + 4_000)).toBe("4s");
		expect(elapsed(start, at + 65_000)).toBe("1:05");
		expect(elapsed(start, at + 3_723_000)).toBe("1:02:03");
		expect(elapsed(undefined, at)).toBe("");
	});

	test("composer autocomplete: / skills and @ members", () => {
		expect(slashQuery("/inv")).toBe("inv");
		expect(slashQuery("/inv x")).toBeNull();
		expect(slashQuery("hi /inv")).toBeNull();
		const skills = [
			{ slug: "weekly-report", title: "Weekly report" },
			{ slug: "invoice-chase", title: "Chase invoices" },
		] as Skill[];
		expect(filterSkills(skills, "inv").map((s) => s.slug)).toEqual(["invoice-chase"]);
		expect(filterSkills(skills, "report").map((s) => s.slug)).toEqual(["weekly-report"]);
		expect(mentionQuery("ask @Ad", 7)).toEqual({ start: 4, query: "ad" });
		expect(mentionQuery("mail@x", 6)).toBeNull();
		expect(insertMention("ask @Ad now", 4, 7, "Ada")).toEqual({ text: "ask @Ada  now", caret: 9 });
	});
});

describe("config", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "vos-config-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	test("env beats the file; a desktop-only file is reported, not read", () => {
		const path = join(dir, "vos.json");
		writeVosFile({ url: "https://mine.example/v1", encryptedKey: "AAAA" }, path);
		const env = { SMOLT_VOS_CONFIG: path };
		expect(resolveVosConfig(env)).toMatchObject({ url: "https://mine.example", desktopOnly: true });
		expect(resolveVosConfig(env).apiKey).toBeUndefined();
		expect(resolveVosConfig({ ...env, VOS_API_KEY: " k1 " })).toMatchObject({ apiKey: "k1", keySource: "env" });
		writeVosFile({ ...readVosFile(path), apiKey: "k2" }, path);
		expect(resolveVosConfig(env)).toMatchObject({ apiKey: "k2", keySource: "file" });
		if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	test("a broken file reads as empty", () => {
		const path = join(dir, "vos.json");
		writeFileSync(path, "{nope");
		expect(readVosFile(path)).toEqual({});
		expect(readFileSync(path, "utf-8")).toBe("{nope");
	});
});

describe("/vos command", () => {
	test("finds threads by name, prefix, and multi-word names", () => {
		expect(findThread(roster, "ada")).toMatchObject({ kind: "vos", vos: { id: "r1" } });
		expect(findThread(roster, "launch crew")).toMatchObject({ kind: "group", group: { id: "g1" } });
		expect(splitNameAndMessage(roster, "Ada Lovelace find the paper")).toEqual({
			name: "Ada Lovelace",
			message: "find the paper",
		});
		expect(splitNameAndMessage(roster, "vos hi")).toEqual({ name: "vos", message: "hi" });
	});

	function harness(fetchImpl: typeof fetch, env: NodeJS.ProcessEnv) {
		const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
		const said: string[] = [];
		const notes: string[] = [];
		const statuses: (string | undefined)[] = [];
		const smolt = {
			registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
				commands.set(name, options),
			sendMessage: (message: { content: string }) => said.push(message.content),
			on: () => {},
		} as unknown as ExtensionAPI;
		createVosExtension({ env, fetch: fetchImpl })(smolt);
		const ctx = {
			ui: {
				notify: (text: string) => notes.push(text),
				setStatus: (_key: string, text: string | undefined) => statuses.push(text),
			},
		};
		return { run: (args: string) => commands.get("vos")!.handler(args, ctx), said, notes, statuses };
	}

	test("without a key it points at /vos connect, whose help explains the API-key way", async () => {
		const h = harness((async () => new Response("{}")) as typeof fetch, {
			SMOLT_VOS_CONFIG: join(tmpdir(), "none.json"),
		});
		await h.run("");
		expect(h.said).toEqual([]);
		expect(h.notes[0]).toContain("/vos connect");
		await h.run("connect help");
		expect(h.said[0]).toContain("VOS_API_KEY");
	});

	test("roster, then a chat whose reply streams in", async () => {
		const encoder = new TextEncoder();
		const fetchImpl = (async (url: string, init: RequestInit) => {
			const path = new URL(url).pathname;
			if (path === "/v1/dots") return new Response(JSON.stringify(roster));
			if (path === "/v1/messages" && init.method === "POST") {
				return new Response(JSON.stringify({ message: { id: "u1", role: "you", text: "hi", date: "" } }), {
					status: 202,
				});
			}
			if (path === "/v1/events") {
				return new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(
								encoder.encode('event: status\ndata: {"mood":"working","statusLine":"Reading"}\n\n'),
							);
							controller.enqueue(
								encoder.encode(
									'event: message.created\ndata: {"id":"v1","role":"vos","text":"On it.","date":"","fromVos":{"id":"r1","name":"Ada Lovelace","look":{}}}\n\n',
								),
							);
							controller.enqueue(encoder.encode('event: status\ndata: {"mood":"idle","statusLine":""}\n\n'));
							controller.close();
						},
					}),
				);
			}
			return new Response("{}", { status: 404 });
		}) as typeof fetch;
		const h = harness(fetchImpl, { VOS_API_KEY: "k", SMOLT_VOS_CONFIG: join(tmpdir(), "none.json") });
		await h.run("");
		expect(h.said[0]).toContain("Your vos (6 unread)");
		expect(h.said[0]).toContain("**Ada Lovelace** (Research) [pinned]");
		expect(h.said[0]).toContain("Hidden: Old");

		await h.run("chat launch crew hi all");
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(h.said).toContain("**You → Launch crew:** hi all");
		expect(h.said).toContain("**Ada Lovelace:** On it.");
		expect(h.statuses).toContain("Launch crew: Reading");
		expect(h.statuses.at(-1)).toBeUndefined();
	});
});
