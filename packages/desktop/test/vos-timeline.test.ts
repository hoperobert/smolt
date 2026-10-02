import { describe, expect, it } from "vitest";
import type { Message, Task } from "../../coding-agent/src/extensions/vos/types.ts";
import { threadTimeline } from "../src/renderer/state/vos-timeline.ts";

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
