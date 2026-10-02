import type { Message, Mood, Task } from "../../../../coding-agent/src/extensions/vos/types.ts";

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

/** A task's beat older than this is no longer the server saying it runs it (it beats every 15 s). */
const BEAT_FRESH_MS = 90_000;
/** A live line older than this, with no fresh beat, is a task nobody is running. */
const STEP_FRESH_MS = 5 * 60_000;

/**
 * Whether a task's work is happening now: what keeps Stop in the composer. A fresh heartbeat is the
 * server saying it runs the task, and that holds whatever the chat shows: a vos posts quiet one-line
 * updates ("On it…") mid-task, and a group chat stays idle while a member works. Without one, a live
 * line from the last few minutes still counts (a long step goes unannounced; a server that beats
 * adopts or fails a task whose run died within a minute). Only a task from a server that never beats
 * can be read as stale from the chat: one the vos has talked past while idle.
 */
export function taskIsLive(task: Task, thread: { mood: Mood; lastVosAt: number }, now: number = Date.now()): boolean {
	if (task.status !== "inProgress" && task.status !== "waiting") return false;
	if ((task.heartbeat?.at ?? 0) > now - BEAT_FRESH_MS) return true;
	const step = Date.parse(task.nowAt ?? "") || 0;
	if (step <= now - STEP_FRESH_MS) return false;
	if (task.heartbeat) return true;
	return !(thread.mood === "idle" && thread.lastVosAt > step);
}
