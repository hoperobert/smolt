import { describe, expect, it } from "vitest";
import { taskIsLive, threadTimeline } from "../src/extensions/vos/timeline.ts";
import type { Message, Task } from "../src/extensions/vos/types.ts";

const message = (id: string, date: string, extra: Partial<Message> = {}): Message =>
	({ id, role: "vos", text: id, date, viaCall: false, ...extra }) as Message;
const task = (id: string, createdAt: string): Task =>
	({ id, title: id, prompt: id, status: "inProgress", steps: [], progress: 0, createdAt }) as Task;

describe("threadTimeline", () => {
	it("puts a task no message carries where it started", () => {
		const items = threadTimeline(
			[message("hi", "2026-10-02T10:00:00Z"), message("continue", "2026-10-02T10:34:03Z", { role: "you" })],
			[task("locate", "2026-10-02T10:34:11Z")],
		);
		expect(items.map((i) => (i.kind === "message" ? i.message.id : `task:${i.task.id}`))).toEqual([
			"hi",
			"continue",
			"task:locate",
		]);
	});

	it("shows a carried task only with its message", () => {
		const items = threadTimeline(
			[message("on it", "2026-10-02T10:00:05Z", { attachment: { type: "task", id: "t1" } })],
			[task("t1", "2026-10-02T10:00:00Z")],
		);
		expect(items).toHaveLength(1);
		expect(items[0]?.kind).toBe("message");
	});

	it("orders tasks between messages", () => {
		const items = threadTimeline(
			[message("a", "2026-10-02T09:00:00Z"), message("c", "2026-10-02T11:00:00Z")],
			[task("b", "2026-10-02T10:00:00Z")],
		);
		expect(items.map((i) => (i.kind === "message" ? i.message.id : i.task.id))).toEqual(["a", "b", "c"]);
	});
});

describe("taskIsLive", () => {
	const now = Date.parse("2026-10-02T12:00:00Z");
	const ago = (s: number) => new Date(now - s * 1000).toISOString();
	const running = (extra: Partial<Task>): Task => ({ ...task("t", ago(600)), ...extra });
	const idle = (lastVosSecondsAgo: number) => ({ mood: "idle" as const, lastVosAt: now - lastVosSecondsAgo * 1000 });

	it("counts a task the server beats for, even after a quiet progress line in an idle thread", () => {
		// The step began 3 min ago; "On it…" came 2 min ago; the group itself is idle.
		const t = running({ nowAt: ago(180), heartbeat: { by: "a", at: now - 10_000 } });
		expect(taskIsLive(t, idle(120), now)).toBe(true);
	});

	it("counts a waiting task the server beats for", () => {
		const t = running({ status: "waiting", nowAt: ago(400), heartbeat: { by: "a", at: now - 5_000 } });
		expect(taskIsLive(t, idle(60), now)).toBe(true);
	});

	it("counts a long step from a beating server whose last beat the app saw a while ago", () => {
		const t = running({ nowAt: ago(150), heartbeat: { by: "a", at: now - 150_000 } });
		expect(taskIsLive(t, idle(100), now)).toBe(true);
	});

	it("drops a task with neither a fresh beat nor a recent step", () => {
		const t = running({ nowAt: ago(600), heartbeat: { by: "a", at: now - 600_000 } });
		expect(taskIsLive(t, { mood: "working", lastVosAt: 0 }, now)).toBe(false);
	});

	it("drops a beatless task the vos has talked past while idle", () => {
		const t = running({ nowAt: ago(120) });
		expect(taskIsLive(t, idle(30), now)).toBe(false);
		expect(taskIsLive(t, { mood: "working", lastVosAt: now - 30_000 }, now)).toBe(true);
		expect(taskIsLive(t, idle(200), now)).toBe(true);
	});

	it("never counts a finished task", () => {
		for (const status of ["completed", "failed", "cancelled", "scheduled"] as const) {
			expect(taskIsLive(running({ status, heartbeat: { by: "a", at: now } }), idle(0), now)).toBe(false);
		}
	});
});
