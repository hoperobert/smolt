/**
 * The Vos API's shapes, as smolt reads them.
 *
 * Vos is the user's AI-teammate service: named teammates ("vos") with their
 * own cloud computers. Field names follow the server's contract (vos-backend
 * `types.ts` plus the teammates release's CONTRACT.md); the server calls a vos
 * a "dot" internally, which is why some paths and fields still say so.
 *
 * Types, and one constant: the view bundle imports this file too, so nothing
 * here may pull in Node.
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
	/** Folded away in the roster; its routines keep running. */
	hidden?: boolean;
	/** The roster section (sidebar group) it is filed under; absent means none. */
	section?: string;
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
	/** The server process running it, and when it last said so (every 15 s while it runs). */
	heartbeat?: { by: string; at: number };
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
	/** An approve-in-advance rule lapses here; the server ignores and then drops it. */
	expiresAt?: string;
}

/**
 * How long a yes to an approval holds: this once, or as an allow rule (for that vos) for an hour, today,
 * or always. Purchases, deletions and account changes always ask, so they only ever get "once".
 */
export type ApprovalRemember = "once" | "1h" | "today" | "always";

/** Kinds the server always asks about: a remembered yes would change nothing. */
export const ALWAYS_ASK_KINDS: readonly ActionKind[] = ["purchase", "deleteData", "accountChange"];

/** Kinds only the phone can approve, with Face ID; anywhere else they can only be denied. */
export const FACE_ID_KINDS: readonly ActionKind[] = ["purchase", "accountChange"];

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

/** A pairing in progress, from `POST /pair` (outside /v1, no key). */
export interface PairStart {
	id: string;
	/** Secret: it is what lets this pair's poll receive the key. Only ever shown inside the QR. */
	code: string;
	/** Six digits to type into the phone instead of scanning. */
	short?: string;
	expiresAt: string;
	/** `vos://pair?s=…&id=…&c=…`: what the QR encodes. */
	url: string;
}

export type PairKind = "smolt-desktop" | "smolt-tui";

/** `GET /pair/:id?c=` while waiting; `key` comes exactly once, on the first poll after approval. */
export interface PairPoll {
	state: "pending" | "approved" | "denied" | "expired";
	key?: string;
	server?: string;
}

/** A device key as the phone lists them (`GET /v1/keys`). */
export interface DeviceKey {
	id: string;
	name: string;
	kind: string;
	createdAt: string;
	lastUsedAt?: string;
}

/** Something a vos remembers about the user (`GET /memory`). */
export interface MemoryNote {
	id: string;
	text: string;
	/** When it was noted. */
	date?: string;
	createdAt?: string;
	updatedAt?: string;
	/** Which vos wrote it down, when the server says. */
	vos?: string;
	source?: string;
}

export type InboxKind = "approval" | "secret" | "safety" | "handoff" | "question" | "finding" | "failed" | "done";
export type InboxPriority = "high" | "normal" | "low";

/** One row of the triage inbox across all vos (`GET /inbox`). */
export interface InboxItem {
	id: string;
	/** The vos it is about. */
	vos: string;
	kind: InboxKind;
	title: string;
	detail?: string;
	priority: InboxPriority;
	state: "open" | "done" | "dismissed";
	ref?: { type: "approval" | "secret" | "safety" | "task" | "message" | "routine" | "agent"; id: string };
	date: string;
}

export type AgentJobState =
	| "queued"
	| "provisioning"
	| "running"
	| "testing"
	| "pushing"
	| "waiting"
	| "done"
	| "failed"
	| "cancelled";

/** A cloud agent: smolt run headless in a fresh VM on one repo, ending in a PR (`GET /agents`). */
export interface AgentJob {
	id: string;
	/** The owning vos. */
	vos: string;
	/** "owner/name". */
	repo: string;
	base: string;
	/** The work branch it pushes. */
	branch: string;
	task: string;
	state: AgentJobState;
	/** What it is doing this moment. */
	step?: string;
	vm?: { id: string; node: string; name: string } | null;
	pr?: { number: number; url: string; title: string; checks?: "pending" | "passing" | "failing" } | null;
	summary?: string;
	error?: string;
	/** Approval ids this job raised. */
	approvals: string[];
	createdAt: string;
	startedAt?: string;
	finishedAt?: string;
	costSeconds?: number;
}

export interface AgentLogLine {
	at: string;
	stream: "agent" | "tool" | "shell" | "system";
	text: string;
}

/** `GET /github`: whether the GitHub App is set up, and the repos it can reach. */
export interface GithubStatus {
	configured: boolean;
	/** The GitHub App, or the user's own account connected in Vos Connect. */
	source?: "app" | "connect";
	appSlug?: string;
	login?: string;
	/** Where to set GitHub up: the App's install page, or the server's connectUrl. */
	installUrl?: string;
	connectUrl?: string;
	repos: string[];
}

/** `GET /inbox/count`. */
export interface InboxCount {
	open: number;
	high: number;
	unread?: number;
}

/** A connector (plugin) a vos can use: an app it signs in to. */
export interface Plugin {
	id: string;
	name: string;
	description?: string;
	connected: boolean;
	enabled?: boolean;
	/** What the connection is allowed to do. */
	scopes?: string[];
	/** Scopes the connector offers, when the server lists them. */
	availableScopes?: string[];
	/** Who it is signed in as. */
	account?: string;
	/** The account is known but its sign-in lapsed. */
	needsSignIn?: boolean;
	icon?: string;
}

/** `GET /computer`: whether the user is driving, and a handoff that waits for them. */
export interface ComputerState {
	id?: string;
	userInControl: boolean;
	/** The pending handoff approval's id: the vos needs the user to take over. */
	handoffApprovalId?: string;
	/** Why, in the vos's words (password, 2FA, CAPTCHA). */
	handoffReason?: string;
}

/** Where this host's key came from (VOS_API_KEY, the OS keystore, a 0600 file, this process only) or none. */
export type VosKeySource = "env" | "keychain" | "file" | "memory" | "none";

/** The connection as the view shows it. Never carries the key. */
export interface VosConnection {
	connected: boolean;
	url: string;
	keySource: VosKeySource;
	/** Whether a key can be kept beyond this process. */
	canPersist: boolean;
	/** The name this host was paired as, when its key came from the phone. */
	deviceName?: string;
	error?: string;
}

/** A pairing as the connect screen shows it. The QR text carries the pairing's code, never a key. */
export interface VosPairing {
	id: string;
	qr: string;
	short?: string;
	expiresAt: string;
	name: string;
}

/** A view request's answer: the value, or the server's error and status. */
export type VosCallResult =
	| { ok: true; value: unknown }
	| {
			ok: false;
			error: string;
			status: number /** Where to install the GitHub App, when that is what failed. */;
			installUrl?: string;
	  };
