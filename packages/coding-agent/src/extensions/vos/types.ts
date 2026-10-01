/**
 * The Vos API's shapes, as smolt reads them.
 *
 * Vos is the user's AI-teammate service: named teammates ("vos") with their
 * own cloud computers. Field names follow the server's contract (vos-backend
 * `types.ts` plus the teammates release's CONTRACT.md); the server calls a vos
 * a "dot" internally, which is why some paths and fields still say so.
 *
 * Types only: the desktop renderer imports this file too, so nothing here may
 * pull in Node.
 */

export type Mood = "idle" | "thinking" | "working" | "needsYou" | "paused" | "celebrating" | "sad";

/** The vos's character as the phone app draws it; smolt only reads `color`. */
export type Look = { shape?: string; color?: string; accessories?: unknown; pet?: string } & Record<string, unknown>;

export interface VosStatus {
	mood: Mood;
	statusLine: string;
}

export interface Dot {
	id: string;
	name: string;
	look: Look;
	isPaused: boolean;
	createdAt: string;
	personality?: string;
	job?: string;
	lastReadAt?: string;
	/** Short role tag, e.g. "Research". */
	label?: string;
	/** Standing rules in the user's words. */
	rules?: string;
	pinned?: boolean;
	hidden?: boolean;
}

/** A row of `GET /dots`: the vos plus what it is up to. */
export interface RosterDot extends Dot {
	status?: VosStatus;
	background?: unknown;
	unread?: number;
	lastMessage?: { role: Role; text: string; date: string } | null;
}

export interface Group {
	id: string;
	name: string;
	/** Vos ids; the first is the lead. */
	members: string[];
	createdAt: string;
	lastMessageAt?: string;
	unread?: number;
}

export interface Roster {
	dots: RosterDot[];
	groups: Group[];
}

export type Role = "you" | "vos";

export type LinkTarget =
	| { type: "task"; id: string }
	| { type: "computer" }
	| { type: "url"; url: string }
	| { type: "vos"; id: string };

export type Attachment =
	| { type: "approval"; id: string }
	| { type: "task"; id: string }
	| { type: "flag"; title: string; detail: string }
	| { type: "table"; headers: string[]; rows: string[][] }
	| { type: "file"; name: string; id?: string }
	| { type: "image"; url: string }
	| { type: "link"; url: string; title: string; detail?: string; image?: string }
	| { type: "safety"; id: string }
	| { type: "skill"; id: string }
	| { type: "secret"; id: string };

export interface Message {
	id: string;
	role: Role;
	text: string;
	date: string;
	viaCall?: boolean;
	reaction?: string;
	feedback?: "good" | "bad" | null;
	link?: { label: string; target: LinkTarget };
	attachment?: Attachment;
	clientId?: string;
	choices?: string[];
	fromVos?: { id: string; name: string; look: Look };
}

export type TaskStatus = "inProgress" | "waiting" | "scheduled" | "completed" | "failed" | "cancelled";

export interface Step {
	id: string;
	text: string;
	done: boolean;
	date: string;
}

export interface Task {
	id: string;
	title: string;
	prompt: string;
	status: TaskStatus;
	steps: Step[];
	progress: number;
	createdAt: string;
	finishedAt?: string;
	result?: string;
	plan?: Array<{ text: string; status: "todo" | "doing" | "done" }>;
	/** What it is doing this moment, and since when: the card's live line. */
	now?: string;
	nowAt?: string;
}

export type ActionKind =
	| "read"
	| "browse"
	| "sendMessage"
	| "purchase"
	| "shareInfo"
	| "accountChange"
	| "deleteData"
	| "calendar";

export interface Approval {
	id: string;
	taskId: string | null;
	kind: ActionKind;
	title: string;
	detail: string;
	site: string;
	amount?: string;
	handoff: boolean;
	reason: string;
	state: "pending" | "approved" | "denied" | "expired";
	createdAt: string;
	expiresAt: string;
}

export type RuleDecision = "allow" | "ask" | "block";

export interface Rule {
	id: string;
	kind: ActionKind;
	site: string;
	decision: RuleDecision;
	note: string;
	match?: string;
	/** Only for this vos; absent means every vos. */
	vos?: string;
	source?: "user" | "always-allow";
	createdAt?: string;
}

export type Trigger =
	| { type: "schedule"; rrule: string; timezone: string }
	| { type: "webhook" }
	| { type: "email"; from?: string; subject?: string; contains?: string }
	| { type: "github"; events?: string[]; repo?: string; contains?: string }
	| { type: "slack"; keyword: string; channel?: string }
	| { type: "linear" | "sentry" | "pagerduty"; contains?: string };

export type TriggerType = Trigger["type"];

export interface RoutineRun {
	id: string;
	at: string;
	cause: "schedule" | "event" | "test" | "manual";
	event?: string;
	taskId: string | null;
	status: "running" | "completed" | "failed" | "skipped";
	summary?: string;
}

export interface Routine {
	id: string;
	vos: string;
	name: string;
	instructions: string;
	skillId?: string;
	trigger: Trigger;
	enabled: boolean;
	pausedReason?: string;
	/** Secret: the key is in the URL. Shown on request, never logged. */
	hookUrl?: string;
	nextRun?: string;
	lastRunAt?: string;
	createdAt: string;
	updatedAt: string;
	runs: RoutineRun[];
}

export interface Skill {
	id: string;
	/** The "/" command: lowercase-hyphenated, unique. */
	slug: string;
	title: string;
	description: string;
	inputs?: string;
	steps: string[];
	rules?: string;
	approvals?: string;
	output?: string;
	source: "written" | "saved" | "taught" | "shared";
	draft: boolean;
	createdBy?: string;
	createdAt: string;
	updatedAt: string;
	uses: number;
	lastUsedAt?: string;
}

export interface TeachSession {
	id: string;
	goal: string;
	state: "recording" | "drafting" | "done" | "cancelled";
	startedAt: string;
	steps: number;
	skillId?: string;
	computerId?: string;
}

export interface SecretRequest {
	id: string;
	vos: string;
	label: string;
	why: string;
	site?: string;
	computerId: string;
	into: "type" | "env";
	env?: string;
	state: "pending" | "used" | "declined" | "expired";
	createdAt: string;
	expiresAt: string;
}

export interface Share {
	code: string;
	url: string;
	vos?: string;
	name?: string;
	createdAt?: string;
}

/** One vos at a computer, from `GET /screens`. */
export interface Screen {
	id: string;
	name: string;
	look: Look;
	status: VosStatus;
	pane: string;
	userInControl: boolean;
	jpegBase64?: string;
	width?: number;
	height?: number;
}

/** The slice of `GET /state` smolt uses. */
export interface VosState {
	/** Null for a group thread, which has `group` and `members` instead. */
	dot: Dot | null;
	group?: Group;
	members?: Dot[];
	status: VosStatus;
	messages: Message[];
	tasks: Task[];
	approvals: Approval[];
	/** Pending secret requests (from the thread's members, for a group). */
	secrets?: SecretRequest[];
	lastEventId: number;
}

/** One event off `GET /events`. */
export interface VosEvent {
	/** The event name: "message.created", "task.updated", "routine", "secret", "resync", … */
	event: string;
	data: unknown;
	id?: string;
}
