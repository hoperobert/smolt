import type { ActionKind, Look, Mood, Roster, RosterDot, RuleDecision, Skill, Trigger } from "./types.ts";

/**
 * Pure helpers for showing Vos data, shared by the TUI and the desktop app.
 * No Node imports: the desktop renderer bundles this file.
 */

/** The phone app's named avatar colours, and a hex for each. */
const LOOK_COLORS: Record<string, string> = {
	sky: "#5aa9f5",
	blue: "#4c84f0",
	ocean: "#2f7fb8",
	teal: "#2bb3a3",
	mint: "#4cc78f",
	green: "#5bb15b",
	forest: "#3f8f5a",
	lime: "#a3c94a",
	lemon: "#e6c84a",
	yellow: "#e8bb3c",
	sun: "#f0a93b",
	orange: "#f08a3b",
	peach: "#f4a582",
	salmon: "#fa8072",
	coral: "#f26f5e",
	red: "#e2574c",
	rose: "#e86a92",
	pink: "#ef7fb8",
	lilac: "#b494e8",
	purple: "#9a6ae0",
	grape: "#7d5cc7",
	indigo: "#6670e0",
	sand: "#c9a77c",
	brown: "#a37552",
	slate: "#7d8794",
	gray: "#8e8e96",
	grey: "#8e8e96",
	ink: "#4a4a52",
};
const FALLBACK_COLORS = ["#5aa9f5", "#4cc78f", "#f08a3b", "#b494e8", "#e86a92", "#2bb3a3", "#e6c84a", "#fa8072"];

/** A vos's avatar colour as CSS: its look's colour by name or hex, else one picked from its id. */
export function vosColor(look: Look | undefined, seed = ""): string {
	const raw = typeof look?.color === "string" ? look.color.trim() : "";
	if (/^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(raw)) return raw;
	const named = LOOK_COLORS[raw.toLowerCase()];
	if (named) return named;
	let hash = 0;
	for (const ch of seed || raw) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
	return FALLBACK_COLORS[hash % FALLBACK_COLORS.length] ?? "#5aa9f5";
}

/** One or two letters for an avatar circle. */
export function initials(name: string): string {
	const words = name.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return "?";
	if (words.length === 1) return (words[0] ?? "?").slice(0, 1).toUpperCase();
	return `${(words[0] ?? "").slice(0, 1)}${(words[1] ?? "").slice(0, 1)}`.toUpperCase();
}

/** The roster as the server orders it: pinned first, then main, then oldest; hidden ones apart. */
export function sortRoster(dots: RosterDot[]): { shown: RosterDot[]; hidden: RosterDot[] } {
	const rank = (d: RosterDot): number => (d.pinned ? 0 : d.id === "main" ? 1 : 2);
	const sorted = [...dots].sort((a, b) => rank(a) - rank(b) || a.createdAt.localeCompare(b.createdAt));
	return { shown: sorted.filter((d) => !d.hidden), hidden: sorted.filter((d) => d.hidden) };
}

export function unreadTotal(roster: Roster): number {
	let total = 0;
	for (const d of roster.dots) if (!d.hidden) total += d.unread ?? 0;
	for (const g of roster.groups) total += g.unread ?? 0;
	return total;
}

const MOODS: Record<Mood, string> = {
	idle: "Idle",
	thinking: "Thinking",
	working: "Working",
	needsYou: "Needs you",
	paused: "Paused",
	celebrating: "Done",
	sad: "Stuck",
};

export function moodLabel(mood: Mood | undefined): string {
	return mood ? (MOODS[mood] ?? mood) : "Idle";
}

/** True for moods that mean the vos is busy right now. */
export const isBusy = (mood: Mood | undefined): boolean => mood === "thinking" || mood === "working";

const DECISIONS: Record<RuleDecision, string> = { allow: "Allow automatically", ask: "Ask first", block: "Never" };
export const decisionLabel = (decision: RuleDecision): string => DECISIONS[decision] ?? decision;

const KINDS: Record<ActionKind, string> = {
	read: "Read",
	browse: "Browse",
	sendMessage: "Send messages",
	purchase: "Buy things",
	shareInfo: "Share information",
	accountChange: "Change account settings",
	deleteData: "Delete data",
	calendar: "Calendar changes",
};
export const ACTION_KINDS = Object.keys(KINDS) as ActionKind[];
export const kindLabel = (kind: ActionKind): string => KINDS[kind] ?? kind;

/** "4s", "1:05", "1:02:03": how long since `fromIso`, for the live line's timer. */
export function elapsed(fromIso: string | undefined, now: number = Date.now()): string {
	const start = fromIso ? Date.parse(fromIso) : Number.NaN;
	if (!Number.isFinite(start)) return "";
	const total = Math.max(0, Math.floor((now - start) / 1000));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
	if (m > 0) return `${m}:${String(s).padStart(2, "0")}`;
	return `${s}s`;
}

/** "just now", "5m ago", "3h ago", "2d ago". */
export function ago(iso: string | undefined, now: number = Date.now()): string {
	const at = iso ? Date.parse(iso) : Number.NaN;
	if (!Number.isFinite(at)) return "";
	const seconds = Math.round((now - at) / 1000);
	if (seconds < 45) return "just now";
	if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
	if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
	return `${Math.round(seconds / 86_400)}d ago`;
}

// ---------------------------------------------------------------- schedules

export type ScheduleFrequency = "hourly" | "daily" | "weekdays" | "weekly";

export interface SimpleSchedule {
	frequency: ScheduleFrequency;
	/** 0-23; ignored for hourly. */
	hour: number;
	minute: number;
	/** For weekly: MO, TU, WE, TH, FR, SA, SU. */
	day: string;
}

const DAY_NAMES: Record<string, string> = {
	MO: "Monday",
	TU: "Tuesday",
	WE: "Wednesday",
	TH: "Thursday",
	FR: "Friday",
	SA: "Saturday",
	SU: "Sunday",
};
export const WEEK_DAYS = Object.keys(DAY_NAMES);

export function scheduleToRrule(s: SimpleSchedule): string {
	const minute = `BYMINUTE=${s.minute}`;
	switch (s.frequency) {
		case "hourly":
			return `FREQ=HOURLY;${minute}`;
		case "weekdays":
			return `FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=${s.hour};${minute}`;
		case "weekly":
			return `FREQ=WEEKLY;BYDAY=${s.day};BYHOUR=${s.hour};${minute}`;
		default:
			return `FREQ=DAILY;BYHOUR=${s.hour};${minute}`;
	}
}

/** The simple form of an RRULE, or null when it says more than the simple form can. */
export function rruleToSchedule(rrule: string): SimpleSchedule | null {
	const parts = new Map<string, string>();
	for (const piece of rrule.replace(/^RRULE:/i, "").split(";")) {
		const [k, v] = piece.split("=");
		if (k && v !== undefined) parts.set(k.toUpperCase(), v.toUpperCase());
	}
	const known = new Set(["FREQ", "BYHOUR", "BYMINUTE", "BYDAY"]);
	if ([...parts.keys()].some((k) => !known.has(k))) return null;
	const hour = Number(parts.get("BYHOUR") ?? 9);
	const minute = Number(parts.get("BYMINUTE") ?? 0);
	if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
	const freq = parts.get("FREQ");
	const byday = parts.get("BYDAY");
	if (freq === "HOURLY" && !byday) return { frequency: "hourly", hour: 0, minute, day: "MO" };
	if (freq === "DAILY" && !byday) return { frequency: "daily", hour, minute, day: "MO" };
	if (freq === "WEEKLY" && byday === "MO,TU,WE,TH,FR") return { frequency: "weekdays", hour, minute, day: "MO" };
	if (freq === "WEEKLY" && byday && DAY_NAMES[byday]) return { frequency: "weekly", hour, minute, day: byday };
	return null;
}

const clock = (hour: number, minute: number): string =>
	`${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;

/** A trigger in a sentence: "Every day at 08:00 (Europe/London)", "When an email arrives from …". */
export function describeTrigger(trigger: Trigger): string {
	switch (trigger.type) {
		case "schedule": {
			const s = rruleToSchedule(trigger.rrule);
			const zone = trigger.timezone ? ` (${trigger.timezone})` : "";
			if (!s) return `On schedule ${trigger.rrule}${zone}`;
			if (s.frequency === "hourly") return `Every hour at :${String(s.minute).padStart(2, "0")}${zone}`;
			if (s.frequency === "weekdays") return `Weekdays at ${clock(s.hour, s.minute)}${zone}`;
			if (s.frequency === "weekly") return `Every ${DAY_NAMES[s.day]} at ${clock(s.hour, s.minute)}${zone}`;
			return `Every day at ${clock(s.hour, s.minute)}${zone}`;
		}
		case "webhook":
			return "When its webhook is called";
		case "email": {
			const bits = [
				trigger.from ? `from ${trigger.from}` : "",
				trigger.subject ? `about "${trigger.subject}"` : "",
				trigger.contains ? `mentioning "${trigger.contains}"` : "",
			].filter(Boolean);
			return `When an email arrives${bits.length ? ` ${bits.join(", ")}` : ""}`;
		}
		case "github": {
			const what = trigger.events?.length ? trigger.events.join(", ") : "activity";
			return `On GitHub ${what}${trigger.repo ? ` in ${trigger.repo}` : ""}${trigger.contains ? ` mentioning "${trigger.contains}"` : ""}`;
		}
		case "slack":
			return `When Slack says "${trigger.keyword}"${trigger.channel ? ` in ${trigger.channel}` : ""}`;
		default: {
			const name = trigger.type.charAt(0).toUpperCase() + trigger.type.slice(1);
			const contains = "contains" in trigger && trigger.contains ? ` mentioning "${trigger.contains}"` : "";
			return name === "Pagerduty" ? `On a PagerDuty event${contains}` : `On a ${name} event${contains}`;
		}
	}
}

// ---------------------------------------------------------------- composer autocomplete

/** The skill name being typed, when the message so far is `/name` with no space yet. */
export function slashQuery(text: string): string | null {
	const match = /^\/([a-z0-9-]*)$/i.exec(text);
	return match ? (match[1] ?? "").toLowerCase() : null;
}

/** The `@name` being typed at the caret, with where it starts, or null. */
export function mentionQuery(text: string, caret: number = text.length): { start: number; query: string } | null {
	const before = text.slice(0, caret);
	const match = /(^|\s)@([\p{L}\p{N}_-]*)$/u.exec(before);
	if (!match) return null;
	return { start: caret - (match[2] ?? "").length - 1, query: (match[2] ?? "").toLowerCase() };
}

export function filterSkills(skills: Skill[], query: string, limit = 8): Skill[] {
	const q = query.toLowerCase();
	const starts = skills.filter((s) => s.slug.startsWith(q));
	const rest = skills.filter(
		(s) => !s.slug.startsWith(q) && (s.slug.includes(q) || s.title.toLowerCase().includes(q)),
	);
	return [...starts, ...rest].slice(0, limit);
}

export function filterMembers<T extends { name: string }>(members: T[], query: string, limit = 8): T[] {
	const q = query.toLowerCase();
	return members.filter((m) => m.name.toLowerCase().startsWith(q)).slice(0, limit);
}

/** Replace the `@query` at `start` with `@Name ` and say where the caret goes. */
export function insertMention(
	text: string,
	start: number,
	caret: number,
	name: string,
): { text: string; caret: number } {
	const inserted = `@${name} `;
	return { text: text.slice(0, start) + inserted + text.slice(caret), caret: start + inserted.length };
}

/** Bare URLs as markdown links, so a vos's "see https://…" is clickable once rendered. */
export function linkify(text: string): string {
	// Only after whitespace or at the start: a URL already inside "[label](url)" follows "(" and is left alone.
	return text.replace(/(^|\s)(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g, (_m, lead: string, url: string) => {
		return `${lead}[${url}](${url})`;
	});
}
