import type { Message, Task } from "../../../../coding-agent/src/extensions/vos/types.ts";

export type TimelineItem = { kind: "message"; message: Message } | { kind: "task"; task: Task };

const dateOf = (item: TimelineItem) => (item.kind === "message" ? item.message.date : item.task.createdAt);

/**
 * A thread as the chat shows it: its messages, and every task where it started, as on the phone.
 * A task a message carries (an attachment) shows with that message; the rest get a row of their
 * own. In a group chat that is the usual case: a member starts work without saying a word first.
 */
export function threadTimeline(messages: readonly Message[], tasks: Iterable<Task>): TimelineItem[] {
	const carried = new Set(messages.flatMap((m) => (m.attachment?.type === "task" ? [m.attachment.id] : [])));
	const items: TimelineItem[] = messages.map((message) => ({ kind: "message", message }));
	for (const task of tasks) if (!carried.has(task.id)) items.push({ kind: "task", task });
	return items.sort((a, b) => dateOf(a).localeCompare(dateOf(b)));
}
