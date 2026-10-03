import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { ExtensionAPI, ExtensionSecrets } from "../src/core/extensions/types.ts";
import {
	AgentLog,
	agentDuration,
	agentLine,
	isAgentActive,
	isAgentNews,
	parseAgentArgs,
	parseRepo,
	sortAgents,
} from "../src/extensions/vos/agents.ts";
import { VosClient, VosError } from "../src/extensions/vos/client.ts";
import { createVosExtension, VIEW_ID } from "../src/extensions/vos/index.ts";
import { agentActions, inboxActions } from "../src/extensions/vos/panel.ts";
import { InboxTracker, VosService } from "../src/extensions/vos/service.ts";
import type { AgentJob, AgentLogLine, InboxItem } from "../src/extensions/vos/types.ts";

const MOCK = fileURLToPath(new URL("../src/extensions/vos/view/mock-vos.mjs", import.meta.url));
const KEY = "dev-vos-key";

const job = (id: string, extra: Partial<AgentJob> = {}): AgentJob => ({
	id,
	vos: "main",
	repo: "acme/site",
	base: "main",
	branch: `vos/${id}`,
	task: "Fix it",
	state: "running",
	approvals: [],
	createdAt: "2026-10-03T10:00:00Z",
	...extra,
});

const line = (text: string, at = "2026-10-03T10:00:00Z"): AgentLogLine => ({ at, stream: "shell", text });

const inboxItem = (extra: Partial<InboxItem>): InboxItem => ({
	id: "i1",
	vos: "main",
	kind: "done",
	title: "PR ready on acme/site",
	priority: "low",
	state: "open",
	ref: { type: "agent", id: "ag1" },
	date: "2026-10-03T10:00:00Z",
	...extra,
});

function memorySecrets(): ExtensionSecrets {
	const values = new Map<string, string>();
	return {
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

describe("cloud agents: helpers", () => {
	test("active states, durations and order", () => {
		expect(isAgentActive("waiting")).toBe(true);
		expect(isAgentActive("done")).toBe(false);
		const start = Date.parse("2026-10-03T10:00:00Z");
		expect(agentDuration(job("a", { startedAt: "2026-10-03T10:00:00Z" }), start + 45_000)).toBe("45s");
		expect(
			agentDuration(job("a", { startedAt: "2026-10-03T10:00:00Z", finishedAt: "2026-10-03T11:05:30Z" }), start),
		).toBe("1h 05m");
		const sorted = sortAgents([
			job("old-done", { state: "done", createdAt: "2026-10-01T00:00:00Z" }),
			job("new-done", { state: "failed", createdAt: "2026-10-03T00:00:00Z" }),
			job("old-run", { createdAt: "2026-09-01T00:00:00Z" }),
		]);
		expect(sorted.map((j) => j.id)).toEqual(["old-run", "new-done", "old-done"]);
	});

	test("repo and /vos agent arguments", () => {
		expect(parseRepo("https://github.com/acme/site.git")).toBe("acme/site");
		expect(parseRepo("acme")).toBeUndefined();
		expect(parseAgentArgs("acme/site@develop fix the  flaky test")).toEqual({
			repo: "acme/site",
			base: "develop",
			task: "fix the flaky test",
		});
		expect(parseAgentArgs("acme/site fix it")).toEqual({ repo: "acme/site", task: "fix it" });
		expect(parseAgentArgs("acme/site")).toBeUndefined();
		expect(parseAgentArgs("fix it please")).toBeUndefined();
	});

	test("a terminal line: state, repo, branch, PR with checks, what it is doing", () => {
		const now = Date.parse("2026-10-03T10:02:00Z");
		expect(agentLine(job("a", { step: "Running npm test" }), now)).toBe(
			"**Running** acme/site `vos/a` · 2m · Running npm test",
		);
		expect(
			agentLine(
				job("b", {
					state: "done",
					finishedAt: "2026-10-03T10:01:00Z",
					summary: "Fixed.",
					pr: { number: 7, url: "https://x", title: "t", checks: "passing" },
				}),
				now,
			),
		).toBe("**Done** acme/site `vos/b` · PR #7 (checks pass) · 1m · Fixed.");
	});

	test("the log: events show at once, a fetch is the record and drops what it covers", () => {
		const log = new AgentLog();
		log.merge({ lines: [line("a"), line("b")], next: 2 });
		log.push(line("c", "t3"));
		log.push(line("e", "t5"));
		expect(log.lines.map((l) => l.text)).toEqual(["a", "b", "c", "e"]);
		// The stream dropped "d"; the next fetch carries c, d and e.
		log.merge({ lines: [line("c", "t3"), line("d", "t4"), line("e", "t5")], next: 5 });
		expect(log.lines.map((l) => l.text)).toEqual(["a", "b", "c", "d", "e"]);
		expect(log.next).toBe(5);
		const small = new AgentLog(3);
		small.merge({ lines: [line("1"), line("2"), line("3"), line("4")], next: 4 });
		expect(small.lines.map((l) => l.text)).toEqual(["2", "3", "4"]);
	});

	test("agent inbox items are news when done or failed; the panel offers to open the job", () => {
		expect(isAgentNews(inboxItem({}))).toBe(true);
		expect(isAgentNews(inboxItem({ kind: "failed", priority: "normal" }))).toBe(true);
		expect(isAgentNews(inboxItem({ ref: { type: "task", id: "t" } }))).toBe(false);
		expect(isAgentNews(inboxItem({ state: "dismissed" }))).toBe(false);
		const tracker = new InboxTracker();
		expect(tracker.fresh([])).toEqual([]);
		expect(tracker.fresh([inboxItem({}), inboxItem({ id: "i2", ref: { type: "message", id: "m" } })])).toEqual([
			inboxItem({}),
		]);
		expect(tracker.added(inboxItem({ id: "i3", kind: "failed" }))).toBe(true);
		expect(inboxActions(inboxItem({})).map((a) => a.value)).toContain("agent:ag1");
		expect(agentActions(job("a")).map((a) => a.value)).toEqual(["log", "message", "cancel", "refresh", "\0back"]);
		expect(agentActions(job("a", { state: "failed" })).map((a) => a.value)).toEqual([
			"log",
			"retry",
			"refresh",
			"\0back",
		]);
	});
});

/** The mock Vos server on a free port, jobs ten times faster. */
async function startMock(env: Record<string, string> = {}): Promise<{ url: string; child: ChildProcess }> {
	const port = await new Promise<number>((resolve) => {
		const probe = createServer();
		probe.listen(0, "127.0.0.1", () => {
			const address = probe.address();
			probe.close(() => resolve(typeof address === "object" && address ? address.port : 0));
		});
	});
	const child = spawn(process.execPath, [MOCK], {
		env: { ...process.env, MOCK_VOS_PORT: String(port), MOCK_VOS_SPEED: "10", ...env },
		stdio: ["ignore", "pipe", "inherit"],
	});
	await new Promise<void>((resolve, reject) => {
		child.stdout?.on("data", (chunk: Buffer) => {
			if (chunk.toString().includes("mock vos:")) resolve();
		});
		child.on("exit", (code) => reject(new Error(`mock exited ${code}`)));
	});
	return { url: `http://127.0.0.1:${port}`, child };
}

const until = async (check: () => Promise<boolean>, ms = 5000): Promise<void> => {
	const end = Date.now() + ms;
	while (!(await check())) {
		if (Date.now() > end) throw new Error("timed out");
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
};

describe("cloud agents against the mock server", () => {
	let mock: { url: string; child: ChildProcess };
	let client: VosClient;
	beforeAll(async () => {
		mock = await startMock();
		client = new VosClient({ baseUrl: mock.url, apiKey: KEY });
	});
	afterAll(() => {
		mock?.child.kill();
	});

	test("GitHub status, and a repo without the app is refused with where to install it", async () => {
		const github = await client.github();
		expect(github).toMatchObject({ configured: true, repos: expect.arrayContaining(["acme/site"]) });
		const error = await client.startAgent("main", { repo: "nobody/else", task: "x" }).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(VosError);
		expect((error as VosError).status).toBe(409);
		expect((error as VosError).installUrl).toMatch(/^https:\/\/github\.com\/apps\//);
	});

	test("start, follow the log to a PR, retry; message and cancel a running one", async () => {
		const started = await client.startAgent("main", { repo: "acme/site", task: "Add a footer", base: "main" });
		expect(started).toMatchObject({ state: "queued", repo: "acme/site", vos: "main" });
		expect((await client.agents({ state: "active" })).map((j) => j.id)).toContain(started.id);
		const log = new AgentLog();
		await until(async () => {
			log.merge(await client.agentLog(started.id, log.next));
			return (await client.agent(started.id)).pr?.checks === "passing";
		});
		const done = await client.agent(started.id);
		expect(done).toMatchObject({ state: "done", pr: { number: expect.any(Number) } });
		expect(log.lines.some((l) => l.text.startsWith("Opened PR"))).toBe(true);
		expect((await client.agents({ state: "all" }))[0]?.id).toBe(started.id);

		const again = await client.retryAgent(started.id);
		expect(again).toMatchObject({ repo: "acme/site", task: "Add a footer", state: "queued" });
		await client.messageAgent(again.id, "also update the README");
		expect((await client.agentLog(again.id)).lines.map((l) => l.text)).toContain("Follow-up: also update the README");
		const cancelled = await client.cancelAgent(again.id);
		expect(cancelled.state).toBe("cancelled");
		await expect(client.messageAgent(again.id, "more")).rejects.toThrow("Already cancelled");
	});

	test("a failing task ends failed, with its error", async () => {
		const started = await client.startAgent("ada", { repo: "acme/api", task: "Make the tests fail" });
		await until(async () => !isAgentActive((await client.agent(started.id)).state));
		expect(await client.agent(started.id)).toMatchObject({ state: "failed", error: expect.any(String), vos: "ada" });
	});

	test("the service passes installUrl back to the view and opens an agent's live line", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vos-agents-"));
		const opened: string[] = [];
		const service = new VosService({
			secrets: memorySecrets(),
			post: () => {},
			env: { SMOLT_VOS_CONFIG: join(dir, "vos.json"), VOS_API_KEY: KEY, VOS_URL: mock.url },
			socket: (url) => {
				opened.push(url);
				return {
					readyState: 0,
					binaryType: "",
					send() {},
					close() {},
					onopen: null,
					onmessage: null,
					onclose: null,
					onerror: null,
				};
			},
		});
		try {
			expect(await service.call("POST", "/agents", { repo: "x/y", task: "t" }, "main")).toMatchObject({
				ok: false,
				status: 409,
				installUrl: expect.stringContaining("github.com/apps"),
			});
			expect(await service.agentLiveOpen("ag-live")).toEqual({ ok: true, value: null });
			expect(opened).toEqual([`${mock.url.replace("http", "ws")}/v1/agents/ag-live/live`]);
		} finally {
			service.dispose();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("/vos agents and /vos agent, and a native notification when a job finishes", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vos-agents-"));
		const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
		const events = new Map<string, (event: unknown, ctx: unknown) => unknown>();
		const said: string[] = [];
		const notes: { text: string; type?: string; options?: unknown }[] = [];
		const handlers = new Map<string, (method: string, params: unknown, ctx: unknown) => unknown>();
		const smolt = {
			registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
				commands.set(name, options),
			sendMessage: (message: { content: string }) => said.push(message.content),
			on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => events.set(event, handler),
			registerView: () => {},
			onViewRequest: (id: string, handler: (method: string, params: unknown, ctx: unknown) => unknown) =>
				handlers.set(id, handler),
			postToView: () => {},
			setViewBadge: () => {},
			secrets: memorySecrets(),
		} as unknown as ExtensionAPI;
		createVosExtension({ env: { SMOLT_VOS_CONFIG: join(dir, "vos.json"), VOS_API_KEY: KEY, VOS_URL: mock.url } })(
			smolt,
		);
		const ctx = {
			mode: "tui",
			ui: {
				notify: (text: string, type?: string, options?: unknown) => notes.push({ text, type, options }),
				setStatus: () => {},
			},
		};
		const run = (args: string) => commands.get("vos")!.handler(args, ctx);
		try {
			await run("agents");
			expect(said.at(-1)).toContain("## Cloud agents");
			expect(said.at(-1)).toContain("**Running** hoperobert/smolt `vos/fix-flaky-session-test-a1b2`");
			expect(said.at(-1)).toContain("https://github.com/acme/site/pull/42");

			await run("agent nobody/else do a thing");
			expect(said.at(-1)).toMatch(
				/isn't installed on nobody\/else\. Install the GitHub App: https:\/\/github\.com\/apps\//,
			);
			await run("agent acme/site");
			expect(notes.at(-1)?.text).toContain("Usage: /vos agent");

			events.get("views_attached")?.({ type: "views_attached" }, ctx);
			await new Promise((resolve) => setTimeout(resolve, 300));
			await run("agent acme/site@main add a footer");
			expect(said.at(-1)).toMatch(/^Cloud agent queued on \*\*acme\/site\*\* `vos\/add-a-footer-/);
			// The job lands in the inbox as done; the next look at the inbox notifies.
			const started = (await client.agents({ state: "all" }))[0];
			expect(started?.task).toBe("add a footer");
			await until(async () => (await client.inbox({ state: "open" })).some((i) => i.ref?.id === started?.id));
			await handlers.get(VIEW_ID)?.("inboxRefresh", {}, ctx);
			const doneNote = () =>
				notes.find((n) => (n.options as { title?: string } | undefined)?.title === "Cloud agent done");
			await until(async () => doneNote() !== undefined);
			expect(doneNote()).toEqual({
				text: "PR ready on acme/site",
				type: "info",
				options: { native: true, title: "Cloud agent done", openView: VIEW_ID },
			});
		} finally {
			await events.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
			rmSync(dir, { recursive: true, force: true });
		}
	}, 15_000);
});
