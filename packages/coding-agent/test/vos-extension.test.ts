import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type {
	ExtensionAPI,
	ExtensionSecrets,
	ExtensionViewDefinition,
	ExtensionViewRequestHandler,
} from "../src/core/extensions/types.ts";
import {
	checkApiPath,
	groupDot,
	normalizeBaseUrl,
	readComputerState,
	VosClient,
	VosError,
} from "../src/extensions/vos/client.ts";
import { readVosFile, resolveVosConfig, writeVosFile } from "../src/extensions/vos/config.ts";
import {
	describeTrigger,
	elapsed,
	expiryFor,
	filterSkills,
	insertMention,
	linkify,
	mentionQuery,
	rosterSections,
	rruleToSchedule,
	ruleExpired,
	scheduleToRrule,
	sectionNames,
	slashQuery,
	sortInbox,
	sortRoster,
	unreadTotal,
	untilLabel,
	vosColor,
} from "../src/extensions/vos/format.ts";
import {
	createVosExtension,
	findThread,
	SETTINGS_VIEW_ID,
	splitNameAndMessage,
	VIEW_ID,
} from "../src/extensions/vos/index.ts";
import { homeItems, inboxActions } from "../src/extensions/vos/panel.ts";
import { SseParser } from "../src/extensions/vos/sse.ts";
import type { InboxItem, Roster, RosterDot, Skill } from "../src/extensions/vos/types.ts";

function memorySecrets(): ExtensionSecrets & { values: Map<string, string> } {
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
		backend: async () => "file",
	};
}

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

	test("env beats the secret store; the desktop's encrypted key is not read; a file key migrates", async () => {
		const path = join(dir, "vos.json");
		writeVosFile({ url: "https://mine.example/v1", encryptedKey: "AAAA" }, path);
		const env = { SMOLT_VOS_CONFIG: path };
		const secrets = memorySecrets();
		expect(await resolveVosConfig(secrets, env)).toMatchObject({ url: "https://mine.example", keySource: "none" });
		expect((await resolveVosConfig(secrets, env)).apiKey).toBeUndefined();
		expect(await resolveVosConfig(secrets, { ...env, VOS_API_KEY: " k1 " })).toMatchObject({
			apiKey: "k1",
			keySource: "env",
		});
		writeVosFile({ ...readVosFile(path), apiKey: "k2" }, path);
		expect(await resolveVosConfig(secrets, env)).toMatchObject({ apiKey: "k2", keySource: "file" });
		expect(secrets.values.get("apiKey")).toBe("k2");
		expect(readVosFile(path).apiKey).toBeUndefined();
		expect(readVosFile(path).encryptedKey).toBe("AAAA");
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
		const notes: { text: string; options?: unknown }[] = [];
		const statuses: (string | undefined)[] = [];
		const views = new Map<string, ExtensionViewDefinition>();
		const handlers = new Map<string, ExtensionViewRequestHandler>();
		const events = new Map<string, (event: unknown, ctx: unknown) => unknown>();
		const posted: { view: string; event: string; data: unknown }[] = [];
		const badges = new Map<string, number | string | undefined>();
		const secrets = memorySecrets();
		const smolt = {
			registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
				commands.set(name, options),
			sendMessage: (message: { content: string }) => said.push(message.content),
			on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => events.set(event, handler),
			registerView: (view: ExtensionViewDefinition) => views.set(view.id, view),
			onViewRequest: (id: string, handler: ExtensionViewRequestHandler) => handlers.set(id, handler),
			postToView: (view: string, event: string, data: unknown) => posted.push({ view, event, data }),
			setViewBadge: (view: string, badge: number | string | undefined) => badges.set(view, badge),
			secrets,
		} as unknown as ExtensionAPI;
		createVosExtension({ env, fetch: fetchImpl })(smolt);
		const ctx = {
			mode: "tui",
			ui: {
				notify: (text: string, _type?: string, options?: unknown) => notes.push({ text, options }),
				setStatus: (_key: string, text: string | undefined) => statuses.push(text),
			},
		};
		return {
			run: (args: string) => commands.get("vos")!.handler(args, ctx),
			request: (method: string, params?: unknown) => handlers.get(VIEW_ID)!(method, params, ctx as never),
			attach: () => events.get("views_attached")?.({ type: "views_attached" }, ctx),
			shutdown: () => events.get("session_shutdown")?.({ type: "session_shutdown" }, ctx),
			said,
			notes,
			statuses,
			views,
			handlers,
			posted,
			badges,
			secrets,
		};
	}

	test("without a key it points at /vos connect, whose help explains the API-key way", async () => {
		const h = harness((async () => new Response("{}")) as typeof fetch, {
			SMOLT_VOS_CONFIG: join(tmpdir(), "none.json"),
		});
		await h.run("");
		expect(h.said).toEqual([]);
		expect(h.notes[0]?.text).toContain("/vos connect");
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
		expect(h.said[0]).toContain("Hidden (routines keep running): Old");

		await h.run("chat launch crew hi all");
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(h.said).toContain("**You → Launch crew:** hi all");
		expect(h.said).toContain("**Ada Lovelace:** On it.");
		expect(h.statuses).toContain("Launch crew: Reading");
		expect(h.statuses.at(-1)).toBeUndefined();
	});

	test("registers the sidebar and settings views; their requests reach the service, never the key", async () => {
		const seen: { url: string; headers: Record<string, string> }[] = [];
		const fetchImpl = (async (url: string, init: RequestInit = {}) => {
			seen.push({ url, headers: (init.headers ?? {}) as Record<string, string> });
			return new Response(JSON.stringify(roster));
		}) as typeof fetch;
		const h = harness(fetchImpl, { SMOLT_VOS_CONFIG: join(tmpdir(), `vos-none-${Date.now()}.json`) });
		expect([...h.views.keys()]).toEqual([VIEW_ID, SETTINGS_VIEW_ID]);
		expect(h.views.get(VIEW_ID)).toMatchObject({ location: "sidebar", title: "Vos" });
		expect(h.views.get(SETTINGS_VIEW_ID)).toMatchObject({ location: "settings" });
		expect(typeof h.views.get(VIEW_ID)?.html).toBe("function");
		expect(h.handlers.has(SETTINGS_VIEW_ID)).toBe(true);

		expect(await h.request("status")).toMatchObject({ connected: false, keySource: "none" });
		const status = await h.request("connect", { url: "https://vos.test", key: "secret-k" });
		expect(status).toMatchObject({ connected: true, keySource: "file" });
		expect(h.secrets.values.get("apiKey")).toBe("secret-k");
		expect(JSON.stringify(h.posted)).not.toContain("secret-k");
		const result = await h.request("call", { method: "GET", path: "/dots" });
		expect(result).toMatchObject({ ok: true, value: { dots: expect.any(Array) } });
		expect(seen.at(-1)?.headers.authorization).toBe("Bearer secret-k");
		await expect(h.request("nope")).rejects.toThrow("Unknown Vos request");
		await h.shutdown();
	});

	test("with views attached, the inbox drives the badge and a native notification for new urgent items", async () => {
		const items: InboxItem[] = [];
		const fetchImpl = (async (url: string) => {
			const path = new URL(url).pathname;
			if (path === "/v1/inbox/count")
				return new Response(JSON.stringify({ open: items.length, high: items.length }));
			if (path === "/v1/inbox") return new Response(JSON.stringify(items));
			return new Response(JSON.stringify(roster));
		}) as typeof fetch;
		const h = harness(fetchImpl, { VOS_API_KEY: "k", SMOLT_VOS_CONFIG: join(tmpdir(), "none.json") });
		h.attach();
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(h.badges.get(VIEW_ID)).toBeUndefined();
		items.push({
			id: "i1",
			vos: "r1",
			kind: "handoff",
			title: "Needs a 2FA code",
			priority: "high",
			state: "open",
			date: "2026-10-03T10:00:00Z",
		});
		await h.request("inboxRefresh");
		await new Promise((resolve) => setTimeout(resolve, 40));
		expect(h.badges.get(VIEW_ID)).toBe(1);
		expect(h.notes.at(-1)).toEqual({
			text: "Ada Lovelace: Needs a 2FA code",
			options: { native: true, title: "Ada Lovelace needs you", openView: VIEW_ID },
		});
		await h.shutdown();
	});

	test("/vos inbox, memory, connectors and code", async () => {
		const bodies: { path: string; body: unknown; dot?: string }[] = [];
		const fetchImpl = (async (url: string, init: RequestInit = {}) => {
			const path = new URL(url).pathname;
			const headers = (init.headers ?? {}) as Record<string, string>;
			if (init.body) bodies.push({ path, body: JSON.parse(String(init.body)), dot: headers["x-vos-dot"] });
			if (path === "/v1/dots") return new Response(JSON.stringify(roster));
			if (path === "/v1/inbox")
				return new Response(
					JSON.stringify([
						{
							id: "a",
							vos: "r1",
							kind: "finding",
							title: "Paper found",
							priority: "low",
							state: "open",
							date: "2026-10-03T09:00:00Z",
						},
						{
							id: "b",
							vos: "main",
							kind: "approval",
							title: "Send the invoice?",
							priority: "high",
							state: "open",
							date: "2026-10-03T08:00:00Z",
						},
					]),
				);
			if (path === "/v1/memory") return new Response(JSON.stringify([{ id: "n1", text: "Prefers mornings" }]));
			if (path === "/v1/plugins")
				return new Response(
					JSON.stringify([{ id: "gh", name: "GitHub", connected: true, account: "ada", scopes: ["repo"] }]),
				);
			if (path === "/v1/code") return new Response(JSON.stringify({ id: "t1", title: "Fix the build" }));
			return new Response("{}", { status: 404 });
		}) as typeof fetch;
		const h = harness(fetchImpl, { VOS_API_KEY: "k", SMOLT_VOS_CONFIG: join(tmpdir(), "none.json") });
		await h.run("inbox");
		expect(h.said.at(-1)).toMatch(
			/\*\*!\*\* \*\*Vos\*\* · Approval: Send the invoice\?[\s\S]*Ada Lovelace\*\* · Finding/,
		);
		await h.run("memory ada");
		expect(h.said.at(-1)).toContain("Prefers mornings");
		await h.run("connectors");
		expect(h.said.at(-1)).toContain("**GitHub**: connected as ada · repo");
		await h.run("code Ada Lovelace fix the build in acme/site");
		expect(bodies.at(-1)).toEqual({
			path: "/v1/code",
			body: { task: "fix the build in acme/site", repo: "acme/site" },
			dot: "r1",
		});
		expect(h.said.at(-1)).toContain("started a coding agent on acme/site");
	});
});

describe("Vos additions", () => {
	test("sections: pinned, then named sections, then the rest; hidden left out", () => {
		const dots = [
			dot("main", "Vos"),
			dot("a", "Ada", { section: "Research" }),
			dot("b", "Bo", { section: "Clients", pinned: true }),
			dot("c", "Cy", { section: "Clients" }),
			dot("h", "Hid", { section: "Research", hidden: true }),
		];
		expect(rosterSections(dots).map((s) => [s.name, s.dots.map((d) => d.id)])).toEqual([
			["Pinned", ["b"]],
			["Clients", ["c"]],
			["Research", ["a"]],
			["Other", ["main"]],
		]);
		expect(rosterSections([dot("main", "Vos")])).toEqual([
			{ name: null, dots: [expect.objectContaining({ id: "main" })] },
		]);
		expect(sectionNames(dots)).toEqual(["Clients", "Research"]);
	});

	test("inbox order and the terminal's actions per item", () => {
		const item = (
			id: string,
			priority: InboxItem["priority"],
			date: string,
			extra: Partial<InboxItem> = {},
		): InboxItem => ({
			id,
			vos: "main",
			kind: "question",
			title: id,
			priority,
			state: "open",
			date,
			...extra,
		});
		const sorted = sortInbox([
			item("low", "low", "2026-10-03T12:00:00Z"),
			item("old-high", "high", "2026-10-01T00:00:00Z"),
			item("new-high", "high", "2026-10-02T00:00:00Z"),
			item("done", "high", "2026-10-04T00:00:00Z", { state: "done" }),
		]);
		expect(sorted.map((i) => i.id)).toEqual(["new-high", "old-high", "low", "done"]);
		const approval = item("ap", "high", "", { kind: "approval", ref: { type: "approval", id: "a1" } });
		expect(inboxActions(approval).map((a) => a.value)).toEqual([
			"approve:once",
			"approve:1h",
			"approve:today",
			"deny",
			"done",
			"dismiss",
			"vos:main",
			"\0back",
		]);
		expect(inboxActions(item("q", "normal", "", { state: "done" })).map((a) => a.value)).toEqual([
			"vos:main",
			"\0back",
		]);
		// A purchase or account change is approved on the phone, with Face ID: here it can only be denied.
		expect(inboxActions(approval, true).map((a) => a.value)).toEqual([
			"deny",
			"done",
			"dismiss",
			"vos:main",
			"\0back",
		]);
		expect(homeItems(roster, 2).map((i) => i.value)).toEqual(["inbox", "vos:r1", "vos:main", "group:g1"]);
	});

	test("approve-in-advance expiries", () => {
		const now = new Date(2026, 9, 3, 10, 15).getTime();
		expect(expiryFor("1h", now)).toBe(new Date(now + 3_600_000).toISOString());
		expect(new Date(expiryFor("today", now) ?? "").getHours()).toBe(23);
		expect(expiryFor("always", now)).toBeUndefined();
		expect(expiryFor("once", now)).toBeUndefined();
		expect(ruleExpired({ expiresAt: new Date(now - 1).toISOString() }, now)).toBe(true);
		expect(ruleExpired({}, now)).toBe(false);
		expect(untilLabel(new Date(2026, 9, 3, 14, 30).toISOString(), now)).toBe("until 14:30");
		expect(untilLabel(new Date(2026, 9, 4, 9, 0).toISOString(), now)).toBe("until tomorrow 09:00");
	});

	test("client: memory, inbox, approvals with remember, connectors, computer, code", async () => {
		const calls: { method: string; url: string; body?: unknown; dot?: string }[] = [];
		const answers: Record<string, unknown> = {
			"GET /v1/memory": { memory: [{ id: "n1", text: "t" }] },
			"PATCH /v1/memory/n1": { note: { id: "n1", text: "u" } },
			"GET /v1/inbox": [{ id: "i1" }],
			"GET /v1/inbox/count": { open: 3, high: 1 },
			"GET /v1/computer": { userInControl: false, handoff: { approvalId: "ap9", reason: "2FA code" } },
			"POST /v1/plugins/gh/connect": { url: "https://github.com/login/oauth" },
			"POST /v1/plugins/email/connect": { authUrl: "https://vos.test/connect/email?t=1", expiresAt: "" },
		};
		const client = new VosClient({
			baseUrl: "https://vos.test",
			apiKey: "k",
			fetch: (async (url: string, init: RequestInit = {}) => {
				const parsed = new URL(url);
				const method = init.method ?? "GET";
				calls.push({
					method,
					url: `${parsed.pathname}${parsed.search}`,
					body: init.body ? JSON.parse(String(init.body)) : undefined,
					dot: (init.headers as Record<string, string>)["x-vos-dot"],
				});
				return new Response(JSON.stringify(answers[`${method} ${parsed.pathname}`] ?? {}));
			}) as typeof fetch,
		});
		expect(await client.memory("ada")).toEqual([{ id: "n1", text: "t" }]);
		expect(await client.editMemory("ada", "n1", "u")).toEqual({ id: "n1", text: "u" });
		expect(calls.at(-1)).toMatchObject({ method: "PATCH", body: { text: "u" }, dot: "ada" });
		expect(await client.inbox({ state: "all", vos: "ada" })).toEqual([{ id: "i1" }]);
		expect(calls.at(-1)?.url).toBe("/v1/inbox?state=all&vos=ada");
		expect(calls.at(-1)?.dot).toBeUndefined();
		expect(await client.inboxCount()).toEqual({ open: 3, high: 1 });
		await client.answerApproval("ada", "ap1", "approve", "1h");
		expect(calls.at(-1)).toMatchObject({ url: "/v1/approvals/ap1", body: { decision: "approve", remember: "1h" } });
		await client.answerApproval("ada", "ap1", "deny", "1h");
		expect(calls.at(-1)?.body).toEqual({ decision: "deny" });
		expect(await client.connectPlugin("gh")).toEqual({ url: "https://github.com/login/oauth" });
		// The server names the sign-in page authUrl (what the phone app reads); either works.
		expect(await client.connectPlugin("email")).toEqual({ url: "https://vos.test/connect/email?t=1" });
		expect(await client.computer("ada")).toEqual({
			userInControl: false,
			handoffApprovalId: "ap9",
			handoffReason: "2FA code",
		});
		await client.startCoding("ada", "fix it", "acme/site");
		expect(calls.at(-1)).toMatchObject({
			method: "POST",
			url: "/v1/code",
			body: { task: "fix it", repo: "acme/site" },
		});
		expect(readComputerState({ userInControl: true, pendingHandoff: "ap2" })).toEqual({
			userInControl: true,
			handoffApprovalId: "ap2",
		});
		expect(readComputerState(null)).toEqual({ userInControl: false });
	});
});
