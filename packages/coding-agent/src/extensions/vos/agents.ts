import type { AgentJob, AgentJobState, AgentLogLine, InboxItem } from "./types.ts";

/**
 * Cloud agents, shown: pure helpers shared by the TUI and the view (no Node
 * imports). A cloud agent is a job on the Vos server that runs smolt in a
 * fresh VM on one repo and ends in a pull request.
 */

const STATES: Record<AgentJobState, string> = {
	queued: "Queued",
	provisioning: "Starting VM",
	running: "Running",
	testing: "Testing",
	pushing: "Pushing",
	waiting: "Waiting on you",
	done: "Done",
	failed: "Failed",
	cancelled: "Cancelled",
};
export const agentStateLabel = (state: AgentJobState): string => STATES[state] ?? state;

const FINISHED: readonly AgentJobState[] = ["done", "failed", "cancelled"];
/** Still going: it can be messaged and cancelled. */
export const isAgentActive = (state: AgentJobState): boolean => !FINISHED.includes(state);

export type AgentTone = "busy" | "warn" | "ok" | "bad" | "quiet";
export function agentTone(state: AgentJobState): AgentTone {
	if (state === "done") return "ok";
	if (state === "failed") return "bad";
	if (state === "cancelled") return "quiet";
	if (state === "waiting") return "warn";
	return "busy";
}

const CHECKS = { pending: "Checks running", passing: "Checks pass", failing: "Checks fail" } as const;
export const checksLabel = (checks: NonNullable<AgentJob["pr"]>["checks"]): string => (checks ? CHECKS[checks] : "");

/** "45s", "12m", "1h 05m": how long it ran (or has run so far). */
export function agentDuration(job: Pick<AgentJob, "createdAt" | "startedAt" | "finishedAt">, now = Date.now()): string {
	const start = Date.parse(job.startedAt ?? job.createdAt);
	const end = job.finishedAt ? Date.parse(job.finishedAt) : now;
	if (!Number.isFinite(start) || !Number.isFinite(end)) return "";
	const seconds = Math.max(0, Math.round((end - start) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** Active first, then newest first. */
export function sortAgents(jobs: AgentJob[]): AgentJob[] {
	return [...jobs].sort(
		(a, b) =>
			Number(isAgentActive(b.state)) - Number(isAgentActive(a.state)) || b.createdAt.localeCompare(a.createdAt),
	);
}

/** "owner/name" from what the user typed: the slug itself or a GitHub URL. */
export function parseRepo(input: string): string | undefined {
	const trimmed = input
		.trim()
		.replace(/^https?:\/\/(www\.)?github\.com\//i, "")
		.replace(/\.git$/i, "")
		.replace(/\/+$/, "");
	return /^[\w.-]+\/[\w.-]+$/.test(trimmed) ? trimmed : undefined;
}

/** `/vos agent owner/repo[@base] task…` split into its parts; undefined when the repo or task is missing. */
export function parseAgentArgs(rest: string): { repo: string; base?: string; task: string } | undefined {
	const [first = "", ...words] = rest.trim().split(/\s+/);
	const at = first.lastIndexOf("@");
	const repo = parseRepo(at > 0 ? first.slice(0, at) : first);
	const base = at > 0 ? first.slice(at + 1) : "";
	const task = words.join(" ").trim();
	if (!repo || !task) return undefined;
	return { repo, ...(base ? { base } : {}), task };
}

/** One job as a terminal line. */
export function agentLine(job: AgentJob, now = Date.now()): string {
	const pr = job.pr
		? ` · PR #${job.pr.number}${job.pr.checks ? ` (${checksLabel(job.pr.checks).toLowerCase()})` : ""}`
		: "";
	const what = isAgentActive(job.state) ? (job.step ?? "") : (job.error ?? job.summary ?? "");
	return `**${agentStateLabel(job.state)}** ${job.repo} \`${job.branch}\`${pr} · ${agentDuration(job, now)}${what ? ` · ${what}` : ""}`;
}

/** An inbox item about a cloud agent that finished or failed: worth a notification. */
export const isAgentNews = (item: InboxItem): boolean =>
	item.ref?.type === "agent" && (item.kind === "done" || item.kind === "failed") && item.state === "open";

const lineKey = (line: AgentLogLine): string => `${line.at}\u0000${line.stream}\u0000${line.text}`;

/**
 * A job's log as the client holds it. `/log?after=` is the record; live
 * `agent.log` events show lines sooner but may drop some, so they sit in a
 * tail until the next fetch covers them.
 */
export class AgentLog {
	/** Lines from `/log`, in order. */
	fetched: AgentLogLine[] = [];
	/** Lines from events not yet covered by a fetch. */
	tail: AgentLogLine[] = [];
	/** The cursor for the next fetch. */
	next = 0;
	/** At most this many lines are kept; the oldest go first. */
	private readonly limit: number;

	constructor(limit = 2000) {
		this.limit = limit;
	}

	get lines(): AgentLogLine[] {
		return [...this.fetched, ...this.tail];
	}

	/** A line from an event. */
	push(line: AgentLogLine): void {
		if (!line || typeof line.text !== "string") return;
		this.tail.push(line);
		this.trim();
	}

	/** A `/log?after=<next>` answer. */
	merge(result: { lines?: AgentLogLine[]; next?: number }): void {
		const lines = Array.isArray(result?.lines) ? result.lines : [];
		const seen = new Set(lines.map(lineKey));
		this.fetched.push(...lines);
		this.tail = this.tail.filter((line) => !seen.has(lineKey(line)));
		if (typeof result?.next === "number" && result.next >= this.next) this.next = result.next;
		this.trim();
	}

	private trim(): void {
		const over = this.fetched.length + this.tail.length - this.limit;
		if (over > 0) this.fetched.splice(0, Math.min(over, this.fetched.length));
	}
}
