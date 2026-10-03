#!/usr/bin/env node
/**
 * A mock Vos API for developing smolt's Vos view without a real server.
 *
 *   node packages/coding-agent/src/extensions/vos/view/mock-vos.mjs# http://127.0.0.1:8787, key "dev-vos-key"
 *   MOCK_VOS_PORT=9000 MOCK_VOS_KEY=other node …/mock-vos.mjs
 *
 * Serves the endpoints of the teammates contract with fake, in-memory data:
 * a few vos, a group chat, routines, skills, auto-review rules, a pending
 * secret request, share links, Teach a task, the screens gallery, the SSE
 * stream at /v1/events and a minimal /v1/computer/live WebSocket that sends
 * generated PNG frames. Sending a message makes the vos "work" on a task for
 * a few seconds (steps, the live "now" line) and answer; say "slowly" in it
 * and the vos thinks for 25 s first, with no task card yet.
 *
 * The seeded threads show every state a task card has: Rex works on one that
 * never ends (its heartbeat and live line keep moving), Penny's waits on your
 * OK, Ada has a finished and a failed one, and in the group chat Ada works on
 * a task no message carries, with a quiet progress line after its last step.
 *
 * Dev only: nothing here is shipped, and the key is a placeholder.
 */
import { createHash, randomUUID } from "node:crypto";
import http from "node:http";
import { crc32, deflateSync } from "node:zlib";

const PORT = Number(process.env.MOCK_VOS_PORT ?? 8787);
const KEY = process.env.MOCK_VOS_KEY ?? "dev-vos-key";
const BASE = `http://127.0.0.1:${PORT}`;

const now = () => new Date().toISOString();
const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();
const uuid = () => randomUUID().slice(0, 8);

// ---------------------------------------------------------------- images

/** A PNG from an RGB painter, using only zlib. */
function png(width, height, paint) {
	const raw = Buffer.alloc((width * 3 + 1) * height);
	for (let y = 0; y < height; y++) {
		const row = y * (width * 3 + 1);
		raw[row] = 0;
		for (let x = 0; x < width; x++) {
			const [r, g, b] = paint(x, y);
			raw[row + 1 + x * 3] = r;
			raw[row + 2 + x * 3] = g;
			raw[row + 3 + x * 3] = b;
		}
	}
	const chunk = (type, data) => {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(data.length);
		const body = Buffer.concat([Buffer.from(type), data]);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(body) >>> 0);
		return Buffer.concat([len, body, crc]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 2;
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw, { level: 1 })),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

/** A fake desktop: a browser window with a page, and a pointer that moves with `t`. */
function desktopFrame(t, hue = 0) {
	const W = 480;
	const H = 300;
	const cx = 60 + ((t * 37) % 360);
	const cy = 80 + ((t * 23) % 180);
	return {
		w: W,
		h: H,
		cursor: { x: cx / W, y: cy / H },
		png: png(W, H, (x, y) => {
			if (Math.abs(x - cx) < 4 && Math.abs(y - cy) < 4) return [250, 128, 114];
			if (y < 22) return [38, 38, 44];
			if (y < 26) return [60, 60, 68];
			if (x < 20 || x > W - 20 || y > H - 16) return [30 + hue, 34, 48];
			if (y > 50 && y < 58 && x > 40 && x < 300) return [70, 70, 80];
			if (y > 70 && y < 74 && x > 40 && x < 420) return [200, 200, 205];
			if (y > 82 && y < 86 && x > 40 && x < 380) return [200, 200, 205];
			if (y > 110 && y < 200 && x > 40 && x < 220) return [90 + hue, 140, 220];
			return [246, 246, 244];
		}),
	};
}

const sampleImage = png(320, 180, (x, y) => [40 + (x % 64) * 2, 90 + (y % 45) * 3, 160 + ((x + y) % 80)]);

// ---------------------------------------------------------------- data

const look = (color, shape = "round") => ({ shape, color, accessories: [], pet: "none" });
const dots = new Map(
	[
		{ id: "main", name: "Vos", look: look("sky"), label: "Chief of staff", isPaused: false, createdAt: minutesAgo(90_000), personality: "Calm, brief, a little dry.", job: "Runs my inbox, calendar and errands.", rules: "Never book anything before 9am.", lastReadAt: minutesAgo(30) },
		{ id: "ada", name: "Ada", look: look("coral"), label: "Research", pinned: true, section: "Work", isPaused: false, createdAt: minutesAgo(50_000), personality: "Curious and thorough; cites sources.", job: "Digs into papers, markets and competitors.", rules: "", lastReadAt: minutesAgo(200) },
		{ id: "penny", name: "Penny", look: look("mint"), label: "Finance", section: "Work", isPaused: false, createdAt: minutesAgo(40_000), personality: "Precise. Hates surprises.", job: "Chases invoices and reconciles the books.", rules: "Ask before paying anything over £200.", lastReadAt: minutesAgo(5) },
		{ id: "rex", name: "Rex", look: look("lilac", "square"), label: "Ops", section: "Side project", isPaused: false, createdAt: minutesAgo(20_000), personality: "Fast and practical.", job: "Keeps the servers and deploys healthy.", rules: "", lastReadAt: minutesAgo(1) },
		{ id: "intern", name: "Old intern", look: look("sand"), label: "Archive", hidden: true, isPaused: true, createdAt: minutesAgo(100_000), personality: "", job: "Retired.", rules: "", lastReadAt: minutesAgo(10_000) },
	].map((d) => [d.id, d]),
);
const status = new Map([
	["main", { mood: "idle", statusLine: "" }],
	["ada", { mood: "idle", statusLine: "" }],
	["penny", { mood: "needsYou", statusLine: "Waiting for your OK" }],
	["rex", { mood: "working", statusLine: "Checking the deploy" }],
	["intern", { mood: "paused", statusLine: "Paused" }],
]);
// The dots-parity additions: memory, the inbox, connectors, the computer's handoff.
const memory = new Map([
	["main", [
		{ id: "n1", text: "Prefers meetings after 10am, never on Fridays.", source: "chat", date: minutesAgo(3000) },
		{ id: "n2", text: "Dentist is Dr Okafor on Elm Street.", source: "task", date: minutesAgo(78) },
		{ id: "n3", text: "Partner's birthday is 14 March; likes Japanese food.", source: "you", date: minutesAgo(9000) },
	]],
	["ada", [{ id: "n4", text: "Cite primary sources; summaries under 300 words.", source: "you", date: minutesAgo(400) }]],
]);
const inbox = new Map(
	[
		{ id: "i1", vos: "penny", kind: "approval", title: "Pay the AWS invoice (£212.40)?", detail: "Over your £200 limit, so it waits for you.", priority: "high", state: "open", ref: { type: "approval", id: "ap-penny" }, date: minutesAgo(4) },
		{ id: "i2", vos: "main", kind: "secret", title: "GitHub token for the staging deploy", detail: "Goes into GITHUB_TOKEN on its computer.", priority: "high", state: "open", ref: { type: "secret", id: "sec-1" }, date: minutesAgo(3) },
		{ id: "i3", vos: "rex", kind: "handoff", title: "Needs a 2FA code to sign in to the registrar", detail: "Take over the computer, type the code, hand it back.", priority: "high", state: "open", ref: { type: "approval", id: "ap-rex-2fa" }, date: minutesAgo(2) },
		{ id: "i4", vos: "ada", kind: "finding", title: "Two competitors cut prices this week", detail: "Read-only research while idle.", priority: "low", state: "open", ref: { type: "message", id: "m-find" }, date: minutesAgo(55) },
		{ id: "i5", vos: "main", kind: "done", title: "Morning briefing sent", priority: "low", state: "open", ref: { type: "routine", id: "r-brief" }, date: minutesAgo(240) },
		{ id: "i6", vos: "ada", kind: "question", title: "Which market should the report cover: UK or EU?", priority: "normal", state: "open", ref: { type: "message", id: "m-q" }, date: minutesAgo(30) },
	].map((i) => [i.id, i]),
);
let inboxReadAt = minutesAgo(60);
const plugins = new Map(
	[
		{ id: "gmail", name: "Gmail", description: "Read, draft and send email.", connected: true, enabled: true, account: "rob@example.com", scopes: ["read", "send"], availableScopes: ["read", "send"] },
		{ id: "calendar", name: "Google Calendar", description: "See and change your calendar.", connected: true, enabled: true, account: "rob@example.com", scopes: ["read"], availableScopes: ["read", "write"] },
		{ id: "github", name: "GitHub", description: "Issues, pull requests and code.", connected: false, enabled: false, scopes: [], availableScopes: ["read", "write"] },
		{ id: "slack", name: "Slack", description: "Messages in your workspace.", connected: false, enabled: false, scopes: [], availableScopes: ["read", "send"] },
	].map((p) => [p.id, p]),
);
const computers = new Map([["rex", { userInControl: false, handoffApprovalId: "ap-rex-2fa", handoffReason: "Type the 2FA code from your phone to sign in to the registrar." }]]);

const groups = new Map([
	["launch", { id: "launch", name: "Launch crew", members: ["ada", "main", "rex"], createdAt: minutesAgo(9000), lastMessageAt: minutesAgo(12) }],
]);

/** Threads: a vos id or group:<id>, each with messages, tasks and approvals. */
const threads = new Map();
const thread = (id) => {
	let t = threads.get(id);
	if (!t) threads.set(id, (t = { messages: [], tasks: new Map(), approvals: new Map(), lastReadAt: minutesAgo(60) }));
	return t;
};
const msg = (role, text, extra = {}, at = now()) => ({ id: uuid(), role, text, date: at, viaCall: false, ...extra });
const fromVos = (id) => {
	const d = dots.get(id);
	return { id: d.id, name: d.name, look: d.look };
};
const beat = () => ({ by: "mock", at: Date.now() });
/** Seeded tasks that stay running: [thread, task, live lines to cycle through (none: the line stays put)]. */
const seededLive = [];

{
	const t = thread("main");
	t.messages.push(
		msg("you", "Can you find me a dentist appointment next week?", {}, minutesAgo(80)),
		msg("vos", "Booked Thursday 10:30 with Dr Okafor. I put it in your calendar.", { link: { label: "Open booking", target: { type: "url", url: "https://example.com/booking/123" } } }, minutesAgo(78)),
		msg("vos", "Here's the clinic's map so you know where to go.", { attachment: { type: "image", url: "/v1/files/map" } }, minutesAgo(77)),
		msg("vos", "To deploy the staging site I need a GitHub token. Paste it below: it goes straight to my computer and is never saved.", { attachment: { type: "secret", id: "sec-1" } }, minutesAgo(3)),
	);
	const a = thread("ada");
	const task = {
		id: "task-ada-1",
		title: "Compare vector databases",
		prompt: "Compare the top vector databases for our use",
		status: "completed",
		steps: [],
		plan: [
			{ text: "List candidates", status: "done" },
			{ text: "Read each one's docs and pricing", status: "done" },
			{ text: "Write the comparison", status: "done" },
		],
		progress: 1,
		createdAt: minutesAgo(240),
		finishedAt: minutesAgo(220),
		result: "pgvector wins for us: no new service, good enough recall.",
	};
	a.tasks.set(task.id, task);
	a.messages.push(
		msg("you", "Compare the top vector databases for our use", {}, minutesAgo(241)),
		msg("vos", "Starting on it.", { attachment: { type: "task", id: task.id } }, minutesAgo(240)),
		msg("vos", "**pgvector** wins for us: no new service to run, and recall is fine at our size. Full table:", { attachment: { type: "table", headers: ["Option", "Cost", "Fit"], rows: [["pgvector", "£0", "Good"], ["Pinecone", "£70/mo", "Great"], ["Qdrant", "£25/mo", "Great"]] } }, minutesAgo(220)),
		msg("vos", "Report", { attachment: { type: "link", url: "https://example.com/report", title: "Vector DB comparison", detail: "6 pages, with sources" } }, minutesAgo(219)),
	);
	const failed = {
		id: "task-ada-2",
		title: "Get Pinecone's enterprise pricing",
		prompt: "Can you get Pinecone's enterprise pricing too?",
		status: "failed",
		steps: [],
		plan: [
			{ text: "Open Pinecone's pricing page", status: "done" },
			{ text: "Sign in to see the enterprise tier", status: "doing" },
			{ text: "Add it to the comparison", status: "todo" },
		],
		progress: 0.4,
		createdAt: minutesAgo(50),
		finishedAt: minutesAgo(46),
		result: "Couldn't sign in: Pinecone sent a code to your phone. Send it to me and I'll pick up where I stopped.",
	};
	a.tasks.set(failed.id, failed);
	a.messages.push(
		msg("you", "Can you get Pinecone's enterprise pricing too?", {}, minutesAgo(51)),
		msg("vos", "Trying now.", { attachment: { type: "task", id: failed.id } }, minutesAgo(50)),
	);
	const p = thread("penny");
	const pay = {
		id: "task-penny-1",
		title: "Pay this month's hosting invoice",
		prompt: "Pay this month's hosting invoice",
		status: "waiting",
		steps: [],
		plan: [
			{ text: "Find Acme's invoice in your email", status: "done" },
			{ text: "Check it against last month's", status: "done" },
			{ text: "Pay it by card", status: "doing" },
			{ text: "File the receipt", status: "todo" },
		],
		progress: 0.6,
		createdAt: minutesAgo(9),
		now: "Waiting for your OK on £240.00",
		nowAt: minutesAgo(6),
		heartbeat: beat(),
	};
	p.tasks.set(pay.id, pay);
	seededLive.push(["penny", pay, []]);
	p.messages.push(msg("you", "Pay this month's hosting invoice", {}, minutesAgo(10)));
	const approval = {
		id: "appr-1",
		taskId: pay.id,
		kind: "purchase",
		title: "Pay invoice #4411 from Acme Hosting",
		detail: "£240.00 by card ending 4242",
		site: "acme.example",
		amount: "£240.00",
		handoff: false,
		reason: "Over your £200 rule",
		state: "pending",
		createdAt: minutesAgo(6),
		expiresAt: new Date(Date.now() + 3600_000).toISOString(),
	};
	p.approvals.set(approval.id, approval);
	p.messages.push(
		msg("vos", "Acme's invoice is £240, over your £200 line. Pay it?", { attachment: { type: "approval", id: approval.id }, choices: ["Approve", "Deny", "Always allow"] }, minutesAgo(6)),
	);
	const r = thread("rex");
	const live = {
		id: "task-rex-1",
		title: "Check the staging deploy",
		prompt: "Check the staging deploy",
		status: "inProgress",
		steps: [
			{ id: "s1", text: "Opened the deploy dashboard", done: true, date: minutesAgo(3) },
			{ id: "s2", text: "Reading the build log", done: false, date: minutesAgo(1) },
		],
		progress: 0.5,
		createdAt: minutesAgo(4),
		now: "Reading the build log",
		nowAt: minutesAgo(1),
		heartbeat: beat(),
	};
	r.tasks.set(live.id, live);
	seededLive.push(["rex", live, ["Reading the build log", "Checking the health endpoint", "Comparing with yesterday's deploy"]]);
	r.messages.push(msg("you", "Is staging healthy?", {}, minutesAgo(5)), msg("vos", "Looking now.", { attachment: { type: "task", id: live.id } }, minutesAgo(4)));
	const g = thread("group:launch");
	g.messages.push(
		msg("you", "Launch is Friday. Who's doing what?", {}, minutesAgo(30)),
		msg("vos", "I'll take the announcement draft and the press list.", { fromVos: fromVos("main") }, minutesAgo(29)),
		msg("vos", "@Ada can you pull three comparable launches for the post?", { fromVos: fromVos("main") }, minutesAgo(28)),
		msg("vos", "On it: Linear, Raycast and Arc, with what worked for each.", { fromVos: fromVos("ada") }, minutesAgo(27)),
		msg("vos", "Deploy freeze is set for Thursday 18:00.", { fromVos: fromVos("rex") }, minutesAgo(12)),
	);
	// Ada's work for the group: no message carries it, and her quiet progress line comes after its last
	// step (a long one), as the server's "On it…" lines do. The group itself stays idle.
	const comps = {
		id: "task-group-1",
		title: "Pull three comparable launches",
		prompt: "@Ada can you pull three comparable launches for the post?",
		status: "inProgress",
		steps: [],
		plan: [
			{ text: "Find the launch posts for Linear, Raycast and Arc", status: "done" },
			{ text: "Note what worked for each", status: "doing" },
			{ text: "Write it up for the post", status: "todo" },
		],
		progress: 0.45,
		createdAt: minutesAgo(26.5),
		now: "Reading Arc's launch thread",
		nowAt: minutesAgo(3),
		heartbeat: beat(),
	};
	g.tasks.set(comps.id, comps);
	seededLive.push(["group:launch", comps, []]);
	g.messages.push(msg("vos", "Linear and Raycast done; Arc next.", { fromVos: fromVos("ada") }, minutesAgo(2)));
}

// Seeded running tasks keep beating every 15 s, as the server's do, and Rex's moves on a step now and then.
let liveTick = 0;
setInterval(() => {
	liveTick++;
	for (const [threadId, task, lines] of seededLive) {
		if (task.status !== "inProgress" && task.status !== "waiting") continue;
		task.heartbeat = beat();
		if (lines.length && liveTick % 3 === 0) {
			task.now = lines[(lines.indexOf(task.now) + 1) % lines.length];
			task.nowAt = now();
			const step = task.steps.at(-1);
			if (step && !step.done) step.text = task.now;
		}
		emit(threadId, "task.updated", task);
	}
}, 15_000).unref();

const routines = new Map([
	["rt-1", { id: "rt-1", vos: "main", name: "Morning briefing", instructions: "Summarise my calendar, unread email and anything due today.", trigger: { type: "schedule", rrule: "FREQ=DAILY;BYHOUR=8;BYMINUTE=0", timezone: "Europe/London" }, enabled: true, nextRun: new Date(Date.now() + 9 * 3600_000).toISOString(), lastRunAt: minutesAgo(900), createdAt: minutesAgo(20_000), updatedAt: minutesAgo(900), runs: [{ id: "run-1", at: minutesAgo(900), cause: "schedule", taskId: null, status: "completed", summary: "3 meetings, 2 emails need you." }] }],
	["rt-2", { id: "rt-2", vos: "main", name: "Invoice from email", instructions: "When an invoice arrives, file it and tell Penny.", trigger: { type: "email", subject: "invoice" }, enabled: true, createdAt: minutesAgo(15_000), updatedAt: minutesAgo(15_000), runs: [] }],
	["rt-3", { id: "rt-3", vos: "main", name: "Triage GitHub issues", instructions: "Label new issues and flag anything security-related.", trigger: { type: "github", events: ["issues"], repo: "reghope/smolt" }, enabled: false, pausedReason: "Failed 5 times in a row", hookUrl: `${BASE}/hooks/rt-3/k3y-${uuid()}`, createdAt: minutesAgo(12_000), updatedAt: minutesAgo(400), runs: [{ id: "run-2", at: minutesAgo(400), cause: "event", event: "issues.opened #812 by octocat", taskId: null, status: "failed", summary: "Could not reach GitHub." }] }],
	["rt-4", { id: "rt-4", vos: "ada", name: "Weekly competitor scan", instructions: "Every Monday, check what competitors shipped.", trigger: { type: "schedule", rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0", timezone: "Europe/London" }, enabled: true, nextRun: new Date(Date.now() + 3 * 86400_000).toISOString(), createdAt: minutesAgo(8000), updatedAt: minutesAgo(8000), runs: [] }],
	["rt-5", { id: "rt-5", vos: "rex", name: "Deploy alerts", instructions: "When Sentry fires, look at the error and tell me if it's real.", trigger: { type: "sentry", contains: "production" }, enabled: true, hookUrl: `${BASE}/hooks/rt-5/k3y-${uuid()}`, createdAt: minutesAgo(6000), updatedAt: minutesAgo(6000), runs: [{ id: "run-3", at: minutesAgo(70), cause: "event", event: "TypeError in checkout.ts", taskId: null, status: "completed", summary: "Real: a null cart. Filed a fix." }] }],
]);

const skills = new Map(
	[
		{ id: "sk-1", slug: "weekly-report", title: "Weekly report", description: "Summarise the week's work from email, calendar and tasks.", steps: ["Read the week's sent mail", "List meetings held", "Write five bullets"], source: "written", draft: false, uses: 12, lastUsedAt: minutesAgo(3000) },
		{ id: "sk-2", slug: "chase-invoice", title: "Chase an invoice", description: "Politely chase an unpaid invoice by email.", inputs: "Who, which invoice", steps: ["Find the invoice", "Draft a friendly reminder", "Send after approval"], approvals: "Ask before sending", source: "saved", draft: false, uses: 4, createdBy: "penny" },
		{ id: "sk-3", slug: "book-travel", title: "Book travel", description: "Find and book trains or flights within policy.", steps: ["Search options", "Pick the cheapest within policy", "Ask before paying"], rules: "Economy only.", source: "taught", draft: true, uses: 0, createdBy: "main" },
		{ id: "sk-4", slug: "competitor-scan", title: "Competitor scan", description: "Check competitors' changelogs and pricing pages.", steps: ["Open each changelog", "Note changes", "Summarise"], source: "shared", draft: false, uses: 7 },
	].map((s) => [s.id, { createdAt: minutesAgo(20_000), updatedAt: minutesAgo(1000), ...s }]),
);

const rules = new Map(
	[
		{ id: "ru-1", kind: "read", site: "", decision: "allow", note: "Reading is always fine", source: "user" },
		{ id: "ru-2", kind: "sendMessage", site: "gmail.com", decision: "ask", note: "", match: "only to people already in the thread", source: "user" },
		{ id: "ru-3", kind: "purchase", site: "", decision: "block", note: "No buying without me", vos: "ada", source: "user" },
		{ id: "ru-4", kind: "calendar", site: "calendar.google.com", decision: "allow", note: "Added when you chose Always", source: "always-allow" },
	].map((r) => [r.id, { createdAt: minutesAgo(5000), ...r }]),
);

const secrets = new Map([
	["sec-1", { id: "sec-1", vos: "main", label: "GitHub token", why: "To deploy the staging site", site: "github.com", computerId: "pc-main", into: "env", env: "GITHUB_TOKEN", state: "pending", createdAt: minutesAgo(3), expiresAt: new Date(Date.now() + 12 * 60_000).toISOString() }],
]);
const shares = new Map();
/** Pairings by id, and the device keys approvals minted (key -> record). */
const pairs = new Map();
const deviceKeys = new Map();
const authorised = (header) => header === `Bearer ${KEY}` || deviceKeys.has(String(header ?? "").replace(/^Bearer\s+/i, ""));
const pairView = (p) => ({ id: p.id, name: p.name, kind: p.kind, createdAt: p.createdAt, expiresAt: p.expiresAt, state: pairState(p) });
const pairState = (p) => (p.state === "pending" && Date.parse(p.expiresAt) < Date.now() ? "expired" : p.state);
const teaches = new Map();

// ---------------------------------------------------------------- events

let seq = 100;
const subscribers = new Set();
function emit(threadId, event, data) {
	const id = ++seq;
	for (const s of subscribers) {
		const accountWide = ["routine", "skill", "rule", "group", "dot", "secret"].includes(event);
		if (s.thread !== threadId && !accountWide) continue;
		s.res.write(`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
	}
}
function setStatus(threadId, mood, statusLine = "") {
	if (dots.has(threadId)) status.set(threadId, { mood, statusLine });
	emit(threadId, "status", { mood, statusLine });
}
function addMessage(threadId, m) {
	thread(threadId).messages.push(m);
	if (threadId.startsWith("group:")) {
		const g = groups.get(threadId.slice(6));
		if (g) g.lastMessageAt = m.date;
	}
	emit(threadId, "message.created", m);
	return m;
}

// ---------------------------------------------------------------- a vos at work

const running = new Map();
function work(threadId, text) {
	const isGroup = threadId.startsWith("group:");
	const group = isGroup ? groups.get(threadId.slice(6)) : null;
	const mentioned = group ? group.members.find((id) => new RegExp(`@${dots.get(id)?.name}\\b`, "i").test(text)) : null;
	const who = group ? (mentioned ?? group.members[0]) : threadId;
	const skill = text.startsWith("/") ? [...skills.values()].find((s) => text.slice(1).startsWith(s.slug)) : null;
	const extra = isGroup ? { fromVos: fromVos(who) } : {};
	const t = thread(threadId);
	const task = {
		id: `task-${uuid()}`,
		title: skill ? skill.title : text.length > 48 ? `${text.slice(0, 45)}…` : text,
		prompt: text,
		status: "inProgress",
		steps: [],
		plan: (skill?.steps ?? ["Read what you asked", "Do the work on my computer", "Write it up"]).map((s, i) => ({ text: s, status: i === 0 ? "doing" : "todo" })),
		progress: 0,
		createdAt: now(),
		now: "Thinking",
		nowAt: now(),
		heartbeat: beat(),
	};
	const timers = [];
	// "slowly" holds the thinking phase (no task card yet) long enough to look at.
	const hold = /\bslowly\b/i.test(text) ? 25_000 : 0;
	const at = (ms, fn) => timers.push(setTimeout(fn, hold + ms));
	running.set(threadId, { timers, task });
	setStatus(threadId, "thinking", hold ? "Looking through your inbox" : "Thinking");
	at(700, () => {
		task.createdAt = now();
		task.nowAt = now();
		task.heartbeat = beat();
		t.tasks.set(task.id, task);
		emit(threadId, "task.created", task);
		addMessage(threadId, msg("vos", skill ? `Running /${skill.slug}.` : "On it.", { ...extra, attachment: { type: "task", id: task.id } }));
		setStatus(threadId, "working", "Opening the browser");
	});
	const nows = ["Opening the browser", "Reading the page", "Comparing options", "Writing it up"];
	nows.forEach((line, i) =>
		at(1500 + i * 1800, () => {
			task.now = line;
			task.nowAt = now();
			task.progress = (i + 1) / (nows.length + 1);
			const doing = Math.min(task.plan.length - 1, Math.floor((i * task.plan.length) / nows.length));
			task.plan = task.plan.map((p, j) => ({ ...p, status: j < doing ? "done" : j === doing ? "doing" : "todo" }));
			task.steps.push({ id: uuid(), text: line, done: true, date: now() });
			task.heartbeat = beat();
			emit(threadId, "task.updated", task);
			setStatus(threadId, "working", line);
		}),
	);
	at(1500 + nows.length * 1800, () => {
		task.status = "completed";
		task.progress = 1;
		task.plan = task.plan.map((p) => ({ ...p, status: "done" }));
		task.finishedAt = now();
		delete task.now;
		emit(threadId, "task.updated", task);
		addMessage(threadId, msg("vos", `Done. Here's what I found about "${text.replace(/^\/\S+\s*/, "") || task.title}": three options, the second is cheapest. Details: https://example.com/result`, extra));
		setStatus(threadId, "idle", "");
		running.delete(threadId);
	});
}

// ---------------------------------------------------------------- http

const json = (res, code, body) => {
	res.writeHead(code, { "content-type": "application/json" });
	res.end(body === undefined ? "" : JSON.stringify(body));
};
const readBody = (req) =>
	new Promise((resolve) => {
		let data = "";
		req.on("data", (c) => (data += c));
		req.on("end", () => {
			try {
				resolve(data ? JSON.parse(data) : {});
			} catch {
				resolve({});
			}
		});
	});

function rosterRow(d) {
	const t = thread(d.id);
	const last = t.messages.at(-1);
	const unread = t.messages.filter((m) => m.role === "vos" && m.date > (d.lastReadAt ?? d.createdAt)).length;
	return { ...d, status: status.get(d.id), unread, lastMessage: last ? { role: last.role, text: last.text.slice(0, 140), date: last.date } : null };
}
function groupRow(g) {
	const t = thread(`group:${g.id}`);
	return { ...g, unread: t.messages.filter((m) => m.role === "vos" && m.date > t.lastReadAt).length };
}
const sortedDots = () => [...dots.values()].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (a.id === "main" ? -1 : b.id === "main" ? 1 : 0) || a.createdAt.localeCompare(b.createdAt));

const server = http.createServer(async (req, res) => {
	const url = new URL(req.url ?? "/", BASE);
	const path = url.pathname;
	const method = req.method ?? "GET";
	if (path === "/" || path === "/healthz") return json(res, 200, { name: "vos-api (mock)", ok: true });
	if (path.startsWith("/share/")) {
		const share = shares.get(path.slice(7));
		if (!share) return json(res, 404, { error: "No such share" });
		return json(res, 200, share.snapshot);
	}
	// Pairing: public, outside /v1. The QR carries the code; the poll gets the device key once.
	if (path === "/pair" && req.method === "POST") {
		const b = await readBody(req);
		const id = `pr_${uuid()}`;
		const code = randomUUID().replace(/-/g, "") + uuid();
		const short = String(Math.floor(100000 + Math.random() * 900000));
		const pair = { id, code, short, name: String(b.name ?? "smolt"), kind: String(b.kind ?? "smolt-desktop"), state: "pending", createdAt: now(), expiresAt: new Date(Date.now() + (Number(process.env.MOCK_PAIR_SECONDS) || 300) * 1000).toISOString() };
		pairs.set(id, pair);
		console.log(`pair ${id} (${pair.name}): approve with  curl -X POST -H "Authorization: Bearer ${KEY}" -H "Content-Type: application/json" -d '{"c":"${code}"}' ${BASE}/v1/pair/${id}/approve`);
		return json(res, 201, { id, code, short, expiresAt: pair.expiresAt, url: `vos://pair?s=${encodeURIComponent(BASE)}&id=${id}&c=${code}` });
	}
	if (path.startsWith("/pair/") && req.method === "GET") {
		const pair = pairs.get(path.slice(6));
		if (!pair || url.searchParams.get("c") !== pair.code) return json(res, 404, { error: "No such pairing" });
		const state = pairState(pair);
		if (state === "approved" && pair.key) {
			const key = pair.key;
			pairs.delete(pair.id);
			return json(res, 200, { state, key, server: BASE });
		}
		return json(res, 200, { state });
	}
	if (!path.startsWith("/v1/")) return json(res, 404, { error: "Not found" });
	if (!authorised(req.headers.authorization)) return json(res, 401, { error: "Missing or wrong API key." });
	const isMasterKey = req.headers.authorization === `Bearer ${KEY}`;
	const threadId = (req.headers["x-vos-dot"] ?? url.searchParams.get("dot") ?? "main").toString();
	const vosId = threadId.startsWith("group:") ? (groups.get(threadId.slice(6))?.members[0] ?? "main") : threadId;
	const p = path.slice(3);
	const seg = p.split("/").filter(Boolean);
	const body = method === "GET" || method === "DELETE" ? {} : await readBody(req);
	const t = thread(threadId);

	// events
	if (p === "/events") {
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		res.write(": connected\n\n");
		const sub = { res, thread: threadId };
		subscribers.add(sub);
		const s = threadId.startsWith("group:") ? { mood: running.has(threadId) ? "working" : "idle", statusLine: "" } : (status.get(threadId) ?? { mood: "idle", statusLine: "" });
		res.write(`event: status\ndata: ${JSON.stringify(s)}\n\n`);
		const beat = setInterval(() => res.write(": heartbeat\n\n"), 15_000);
		req.on("close", () => {
			clearInterval(beat);
			subscribers.delete(sub);
		});
		return;
	}

	// roster and profile
	if (p === "/dots" && method === "GET") return json(res, 200, { dots: sortedDots().map(rosterRow), groups: [...groups.values()].map(groupRow) });
	if (seg[0] === "dots" && seg[1] === "import" && method === "POST") {
		const code = body.code ?? String(body.url ?? "").split("/share/")[1];
		const share = shares.get(code);
		if (!share) return json(res, 404, { error: "That share link doesn't exist or was revoked." });
		const d = { ...share.snapshot, id: `v-${uuid()}`, createdAt: now(), isPaused: false, pinned: false, hidden: false };
		dots.set(d.id, d);
		status.set(d.id, { mood: "idle", statusLine: "" });
		emit(d.id, "dot", d);
		return json(res, 201, d);
	}
	if (seg[0] === "dots" && seg[1]) {
		const d = dots.get(seg[1]);
		if (!d) return json(res, 404, { error: "No such vos" });
		if (!seg[2] && method === "PATCH") {
			for (const k of ["name", "label", "personality", "job", "rules", "look", "pinned", "hidden", "section"]) if (body[k] !== undefined) d[k] = body[k] ?? undefined;
			emit(d.id, "dot", d);
			return json(res, 200, d);
		}
		if (!seg[2] && method === "DELETE") {
			if (d.id === "main") return json(res, 409, { error: "The main vos can't be deleted; reset it instead." });
			dots.delete(d.id);
			emit(d.id, "dot", { id: d.id, deleted: true });
			return json(res, 200, { ok: true });
		}
		if (seg[2] === "duplicate" && method === "POST") {
			const copy = { ...d, id: `v-${uuid()}`, name: body.name || `${d.name} copy`, pinned: false, hidden: false, createdAt: now() };
			dots.set(copy.id, copy);
			status.set(copy.id, { mood: "idle", statusLine: "" });
			emit(copy.id, "dot", copy);
			return json(res, 201, copy);
		}
		if (seg[2] === "share" && method === "POST") {
			const code = uuid() + uuid();
			const share = { code, url: `${BASE}/share/${code}`, vos: d.id, name: d.name, createdAt: now(), snapshot: { name: d.name, label: d.label, look: d.look, personality: d.personality, job: d.job, rules: d.rules } };
			shares.set(code, share);
			return json(res, 201, { code, url: share.url });
		}
	}
	if (p === "/shares" && method === "GET") return json(res, 200, [...shares.values()].map(({ snapshot, ...s }) => s));
	if (seg[0] === "shares" && seg[1] && method === "DELETE") return shares.delete(seg[1]) ? json(res, 200, { ok: true }) : json(res, 404, { error: "No such share" });

	// chat
	if (p === "/state") {
		const d = dots.get(threadId);
		if (d) d.lastReadAt = now();
		else t.lastReadAt = now();
		const group = threadId.startsWith("group:") ? groups.get(threadId.slice(6)) : undefined;
		const memberIds = group ? group.members : [threadId];
		return json(res, 200, {
			dot: d ?? null,
			...(group ? { group: groupRow(group), members: group.members.map((id) => dots.get(id)).filter(Boolean), memory: [] } : {}),
			status: status.get(threadId) ?? { mood: running.has(threadId) ? "working" : "idle", statusLine: "" },
			messages: t.messages.slice(-100),
			tasks: [...t.tasks.values()],
			approvals: [...t.approvals.values()].filter((a) => a.state === "pending"),
			secrets: [...secrets.values()].filter((s) => s.state === "pending" && memberIds.includes(s.vos)),
			lastEventId: seq,
		});
	}
	if (p === "/messages" && method === "GET") return json(res, 200, t.messages.slice(-(Number(url.searchParams.get("limit")) || 50)));
	if (p === "/messages" && method === "POST") {
		const text = String(body.text ?? "").trim();
		if (!text) return json(res, 400, { error: "Say something" });
		const existing = body.clientId && t.messages.find((m) => m.clientId === body.clientId);
		if (existing) return json(res, 202, { message: existing, duplicate: true });
		const m = addMessage(threadId, msg("you", text, body.clientId ? { clientId: body.clientId } : {}));
		work(threadId, text);
		return json(res, 202, { message: m });
	}
	if (p === "/stop" && method === "POST") {
		const r = running.get(threadId);
		if (r) {
			for (const timer of r.timers) clearTimeout(timer);
			r.task.status = "cancelled";
			delete r.task.now;
			emit(threadId, "task.updated", r.task);
			running.delete(threadId);
		}
		const seeded = seededLive.filter(([id, task]) => id === threadId && (task.status === "inProgress" || task.status === "waiting"));
		for (const [, task] of seeded) {
			task.status = "cancelled";
			task.finishedAt = now();
			delete task.now;
			emit(threadId, "task.updated", task);
		}
		const stopped = (r ? 1 : 0) + seeded.length;
		addMessage(threadId, msg("vos", stopped ? "Stopped." : "Stopped. Nothing else is running.", threadId.startsWith("group:") ? { fromVos: fromVos(vosId) } : {}));
		setStatus(threadId, "idle", "");
		return json(res, 200, { ok: true, stopped });
	}
	if (seg[0] === "approvals" && seg[1] && method === "POST") {
		const a = t.approvals.get(seg[1]);
		if (!a) return json(res, 404, { error: "No such approval" });
		if (a.state !== "pending") return json(res, 409, { error: `Already ${a.state}` });
		a.state = body.decision === "deny" ? "denied" : "approved";
		emit(threadId, "approval.resolved", a);
		if (body.decision === "always") {
			const r = { id: `ru-${uuid()}`, kind: a.kind, site: a.site, decision: "allow", note: `Added when you chose Always for “${a.title}”`, source: "always-allow", createdAt: now() };
			rules.set(r.id, r);
			emit(threadId, "rule", r);
		}
		addMessage(threadId, msg("vos", a.state === "approved" ? "Paid. Receipt filed." : "OK, I won't pay it."));
		if (dots.has(threadId)) setStatus(threadId, "idle", "");
		return json(res, 200, a);
	}
	if (seg[0] === "files" && seg[1]) {
		res.writeHead(200, { "content-type": "image/png" });
		return res.end(sampleImage);
	}

	// routines
	if (p === "/routines" && method === "GET") return json(res, 200, [...routines.values()].filter((r) => r.vos === vosId));
	if (p === "/routines" && method === "POST") {
		if ([...routines.values()].filter((r) => r.vos === vosId).length >= 50) return json(res, 400, { error: "A vos can have at most 50 routines." });
		if (!body.name || !body.trigger) return json(res, 400, { error: "name, instructions and trigger are required" });
		const r = { id: `rt-${uuid()}`, vos: vosId, name: body.name, instructions: body.instructions ?? "", skillId: body.skillId, trigger: body.trigger, enabled: body.enabled !== false, createdAt: now(), updatedAt: now(), runs: [], ...(body.trigger.type !== "schedule" && body.trigger.type !== "email" ? { hookUrl: `${BASE}/hooks/x/k3y-${uuid()}` } : { nextRun: new Date(Date.now() + 3600_000).toISOString() }) };
		routines.set(r.id, r);
		emit(threadId, "routine", r);
		return json(res, 201, r);
	}
	if (seg[0] === "routines" && seg[1]) {
		const r = routines.get(seg[1]);
		if (!r) return json(res, 404, { error: "No such routine" });
		if (!seg[2] && method === "GET") return json(res, 200, r);
		if (!seg[2] && method === "PATCH") {
			for (const k of ["name", "instructions", "trigger", "skillId", "enabled"]) if (body[k] !== undefined) r[k] = body[k];
			if (body.enabled) delete r.pausedReason;
			r.updatedAt = now();
			emit(threadId, "routine", r);
			return json(res, 200, r);
		}
		if (!seg[2] && method === "DELETE") {
			routines.delete(r.id);
			emit(threadId, "routine", { id: r.id, vos: r.vos, deleted: true });
			return json(res, 200, { ok: true });
		}
		if ((seg[2] === "test" || seg[2] === "run") && method === "POST") {
			const run = { id: `run-${uuid()}`, at: now(), cause: seg[2] === "test" ? "test" : "manual", taskId: null, status: "running" };
			r.runs = [run, ...r.runs].slice(0, 20);
			r.lastRunAt = run.at;
			emit(threadId, "routine", r);
			setTimeout(() => {
				run.status = "completed";
				run.summary = "Ran fine.";
				emit(threadId, "routine", r);
			}, 3000);
			return json(res, 200, run);
		}
		if (seg[2] === "rotate" && method === "POST") {
			r.hookUrl = `${BASE}/hooks/${r.id}/k3y-${uuid()}`;
			emit(threadId, "routine", r);
			return json(res, 200, r);
		}
	}

	// skills
	if (p === "/skills" && method === "GET") return json(res, 200, [...skills.values()]);
	if (p === "/skills" && method === "POST") {
		if (!/^[a-z0-9-]+$/.test(body.slug ?? "")) return json(res, 400, { error: "slug is lowercase letters, digits and hyphens" });
		if ([...skills.values()].some((s) => s.slug === body.slug)) return json(res, 409, { error: "That slug is taken" });
		const s = { id: `sk-${uuid()}`, title: body.slug, description: "", steps: [], source: "written", draft: false, uses: 0, createdAt: now(), updatedAt: now(), ...body };
		skills.set(s.id, s);
		emit(threadId, "skill", s);
		return json(res, 201, s);
	}
	if (seg[0] === "skills" && seg[1]) {
		const s = skills.get(seg[1]);
		if (!s) return json(res, 404, { error: "No such skill" });
		if (!seg[2] && method === "GET") return json(res, 200, s);
		if (!seg[2] && method === "PATCH") {
			Object.assign(s, body, { id: s.id, updatedAt: now() });
			emit(threadId, "skill", s);
			return json(res, 200, s);
		}
		if (!seg[2] && method === "DELETE") {
			skills.delete(s.id);
			emit(threadId, "skill", { id: s.id, deleted: true });
			return json(res, 200, { ok: true });
		}
		if (seg[2] === "test" && method === "POST") {
			work(threadId, `/${s.slug} (test on safe inputs)`);
			return json(res, 200, { taskId: running.get(threadId)?.task.id ?? "" });
		}
	}

	// rules
	if (p === "/rules" && method === "GET") return json(res, 200, [...rules.values()]);
	if (p === "/rules" && method === "POST") {
		const r = { id: `ru-${uuid()}`, source: "user", createdAt: now(), note: "", site: "", ...body };
		rules.set(r.id, r);
		emit(threadId, "rule", r);
		return json(res, 201, r);
	}
	if (seg[0] === "rules" && seg[1]) {
		const r = rules.get(seg[1]);
		if (!r) return json(res, 404, { error: "No such rule" });
		if (method === "GET") return json(res, 200, r);
		if (method === "PATCH" || method === "PUT") {
			Object.assign(r, body, { id: r.id });
			if (body.vos === null || body.vos === "") delete r.vos;
			if (body.match === null || body.match === "") delete r.match;
			emit(threadId, "rule", r);
			return json(res, 200, r);
		}
		if (method === "DELETE") {
			rules.delete(r.id);
			emit(threadId, "rule", { id: r.id, deleted: true });
			return json(res, 200, { ok: true });
		}
	}

	// groups
	if (p === "/groups" && method === "GET") return json(res, 200, [...groups.values()].map(groupRow));
	if (p === "/groups" && method === "POST") {
		const g = { id: `g-${uuid()}`, name: body.name || "Group", members: body.members ?? [], createdAt: now() };
		groups.set(g.id, g);
		emit(threadId, "group", g);
		return json(res, 201, g);
	}
	if (seg[0] === "groups" && seg[1]) {
		const g = groups.get(seg[1]);
		if (!g) return json(res, 404, { error: "No such group" });
		if (method === "PATCH") {
			if (body.name) g.name = body.name;
			if (Array.isArray(body.members)) g.members = body.members;
			emit(threadId, "group", g);
			return json(res, 200, g);
		}
		if (method === "DELETE") {
			groups.delete(g.id);
			emit(threadId, "group", { id: g.id, deleted: true });
			return json(res, 200, { ok: true });
		}
	}

	// teach a task
	if (p === "/teach" && method === "POST") {
		if (!String(body.goal ?? "").trim()) return json(res, 400, { error: "Say what you're teaching" });
		const id = `teach-${uuid()}`;
		const session = { id, goal: body.goal, state: "recording", startedAt: now(), steps: 0, computerId: body.computerId ?? `pc-${vosId}` };
		session.timer = setInterval(() => session.state === "recording" && session.steps++, 2500);
		teaches.set(id, session);
		session.announce = setInterval(() => {
			if (session.state !== "recording") return clearInterval(session.announce);
			const { timer, announce, ...doc } = session;
			emit(threadId, "teach", doc);
		}, 2500);
		status.set(vosId, { mood: "needsYou", statusLine: "You're teaching me" });
		return json(res, 201, { id, computerId: session.computerId });
	}
	if (seg[0] === "teach" && seg[1]) {
		const s = teaches.get(seg[1]);
		if (!s) return json(res, 404, { error: "No such recording" });
		const view = () => {
			const { timer, announce, ...rest } = s;
			return rest;
		};
		if (!seg[2] && method === "GET") return json(res, 200, view());
		if (seg[2] === "cancel" && method === "POST") {
			clearInterval(s.timer);
			s.state = "cancelled";
			setStatus(vosId, "idle", "");
			return json(res, 200, view());
		}
		if (seg[2] === "stop" && method === "POST") {
			clearInterval(s.timer);
			s.state = "drafting";
			setStatus(vosId, "thinking", "Writing up what you showed me");
			setTimeout(() => {
				const slug = s.goal.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "taught-task";
				const skill = { id: `sk-${uuid()}`, slug, title: s.goal, description: `What you showed me: ${s.goal}.`, steps: ["Open the site", "Sign in if asked", "Fill in the form", "Submit and check the confirmation"], source: "taught", draft: true, uses: 0, createdBy: vosId, createdAt: now(), updatedAt: now() };
				skills.set(skill.id, skill);
				s.state = "done";
				s.skillId = skill.id;
				emit(threadId, "skill", skill);
				emit(threadId, "teach", view());
				addMessage(vosId, msg("vos", `I wrote up what you showed me as /${slug}. Want me to test it?`, { attachment: { type: "skill", id: skill.id }, choices: ["Test it", "Keep", "Discard"] }));
				setStatus(vosId, "idle", "");
			}, 2500);
			return json(res, 200, view());
		}
	}

	// secrets
	if (p === "/secrets" && method === "GET") return json(res, 200, [...secrets.values()].filter((s) => s.state === "pending"));
	if (seg[0] === "secrets" && seg[1]) {
		const s = secrets.get(seg[1]);
		if (!s || s.state !== "pending") return json(res, 404, { error: "That request has expired or was answered." });
		if (seg[2] === "decline" && method === "POST") {
			s.state = "declined";
			emit(threadId, "secret", s);
			addMessage(s.vos, msg("vos", "OK, I'll leave the deploy for now."));
			return json(res, 200, s);
		}
		if (!seg[2] && method === "POST") {
			// The value is used and dropped: never stored, never logged.
			if (typeof body.value !== "string" || body.value === "") return json(res, 400, { error: "value is required" });
			s.state = "used";
			emit(threadId, "secret", s);
			addMessage(s.vos, msg("vos", "Got it, thanks. It's on my computer and not saved anywhere else."));
			res.writeHead(204);
			return res.end();
		}
	}

	// pairing (the phone's side) and device keys
	if (p === "/pair/claim" && method === "POST") {
		const pair = [...pairs.values()].find((x) => x.short === String(body.short) && pairState(x) === "pending");
		return pair ? json(res, 200, { ...pairView(pair), c: pair.code }) : json(res, 404, { error: "No pending pairing with that code" });
	}
	if (seg[0] === "pair" && seg[1]) {
		const pair = pairs.get(seg[1]);
		const c = body.c ?? url.searchParams.get("c");
		if (!pair || c !== pair.code) return json(res, 404, { error: "No such pairing" });
		if (!seg[2] && method === "GET") return json(res, 200, pairView(pair));
		if (pairState(pair) !== "pending") return json(res, 409, { error: `Already ${pairState(pair)}` });
		if (seg[2] === "approve" && method === "POST") {
			const key = `vosd_${randomUUID().replace(/-/g, "")}`;
			deviceKeys.set(key, { id: `key_${uuid()}`, name: pair.name, kind: pair.kind, createdAt: now() });
			pair.state = "approved";
			pair.key = key;
			res.writeHead(204);
			return res.end();
		}
		if (seg[2] === "deny" && method === "POST") {
			pair.state = "denied";
			res.writeHead(204);
			return res.end();
		}
	}
	if (seg[0] === "keys") {
		if (!isMasterKey) return json(res, 403, { error: "Device keys can't manage device keys." });
		if (!seg[1] && method === "GET") return json(res, 200, [...deviceKeys.values()]);
		if (seg[1] && method === "DELETE") {
			const entry = [...deviceKeys.entries()].find(([, v]) => v.id === seg[1]);
			if (!entry) return json(res, 404, { error: "No such key" });
			deviceKeys.delete(entry[0]);
			res.writeHead(204);
			return res.end();
		}
	}

	// memory (per vos)
	if (p === "/memory" && method === "GET") return json(res, 200, memory.get(vosId) ?? []);
	if (p === "/memory" && method === "POST") {
		if (!String(body.text ?? "").trim()) return json(res, 400, { error: "Empty note" });
		const note = { id: uuid(), text: String(body.text).trim(), source: "you", date: now() };
		memory.set(vosId, [note, ...(memory.get(vosId) ?? [])]);
		emit(threadId, "memory.added", note);
		return json(res, 201, note);
	}
	if (seg[0] === "memory" && seg[1]) {
		const list = memory.get(vosId) ?? [];
		const note = list.find((n) => n.id === seg[1]);
		if (!note) return json(res, 404, { error: "No such note" });
		if (method === "PATCH") {
			note.text = String(body.text ?? note.text);
			emit(threadId, "memory.updated", { note });
			return json(res, 200, note);
		}
		if (method === "DELETE") {
			memory.set(vosId, list.filter((n) => n.id !== seg[1]));
			emit(threadId, "memory.deleted", { id: seg[1] });
			return json(res, 200, { ok: true });
		}
	}

	// the inbox (all vos)
	if (p === "/inbox/count") {
		const open = [...inbox.values()].filter((i) => i.state === "open");
		return json(res, 200, { open: open.length, high: open.filter((i) => i.priority === "high").length, unread: open.filter((i) => i.date > inboxReadAt).length });
	}
	if (p === "/inbox/read" && method === "POST") {
		inboxReadAt = now();
		return json(res, 200, { unread: 0 });
	}
	if (p === "/inbox" && method === "GET") {
		const all = url.searchParams.get("state") === "all";
		const only = url.searchParams.get("vos");
		return json(res, 200, [...inbox.values()].filter((i) => (all || i.state === "open") && (!only || i.vos === only)).sort((a, b) => b.date.localeCompare(a.date)));
	}
	if (seg[0] === "inbox" && seg[1] && (seg[2] === "done" || seg[2] === "dismiss") && method === "POST") {
		const item = inbox.get(seg[1]);
		if (!item) return json(res, 404, { error: "No such item" });
		item.state = seg[2] === "done" ? "done" : "dismissed";
		emit(item.vos, "inbox.updated", { item });
		return json(res, 200, item);
	}

	// connectors
	if (p === "/plugins" && method === "GET") return json(res, 200, [...plugins.values()]);
	if (seg[0] === "plugins" && seg[1]) {
		const plugin = plugins.get(seg[1]);
		if (!plugin) return json(res, 404, { error: "No such connector" });
		if (seg[2] === "connect" && method === "POST") {
			Object.assign(plugin, { connected: true, enabled: true, account: "rob@example.com", scopes: [...plugin.availableScopes] });
			return json(res, 200, { url: `https://example.com/oauth/${plugin.id}` });
		}
		if (seg[2] === "disconnect" && method === "POST") {
			Object.assign(plugin, { connected: false, enabled: false, account: undefined, scopes: [] });
			return json(res, 200, plugin);
		}
		if (!seg[2] && method === "PATCH") {
			if (Array.isArray(body.scopes)) plugin.scopes = body.scopes.filter((s) => plugin.availableScopes.includes(s));
			if (typeof body.enabled === "boolean") plugin.enabled = body.enabled;
			return json(res, 200, plugin);
		}
	}

	// the computer: takeover, and coding agents
	if (p === "/computer" && method === "GET") {
		const c = computers.get(vosId) ?? { userInControl: false, handoffApprovalId: null };
		return json(res, 200, { id: `pc-${vosId}`, ...c, handoff: c.handoffApprovalId ? { id: c.handoffApprovalId, title: c.handoffReason, handoff: true } : null });
	}
	if ((p === "/computer/takeover" || p === "/computer/handback") && method === "POST") {
		const c = computers.get(vosId) ?? { userInControl: false };
		if (p === "/computer/takeover") c.userInControl = true;
		else Object.assign(c, { userInControl: false, handoffApprovalId: null, handoffReason: undefined });
		computers.set(vosId, c);
		emit(threadId, "computer", c);
		return json(res, 200, c);
	}
	if (p === "/computer/input" && method === "POST") return json(res, 200, { ok: true });
	if (p === "/code" && method === "POST") {
		if (!String(body.task ?? "").trim()) return json(res, 400, { error: "Say what to build or fix." });
		const task = { id: uuid(), title: `Code: ${String(body.task).slice(0, 60)}`, prompt: body.task, status: "inProgress", steps: [], progress: 0.1, createdAt: now(), plan: [{ text: `Clone ${body.repo ?? "the workspace"}`, status: "doing" }, { text: "Run Claude Code", status: "todo" }, { text: "Report back", status: "todo" }], now: "Cloning the repository", nowAt: now(), heartbeat: beat() };
		t.tasks.set(task.id, task);
		emit(threadId, "task.created", task);
		return json(res, 201, task);
	}

	// computers
	if (p === "/screens") {
		const tick = Math.floor(Date.now() / 1000);
		const screens = [...dots.values()]
			.filter((d) => ["working", "thinking", "needsYou"].includes(status.get(d.id)?.mood))
			.map((d, i) => {
				const f = desktopFrame(tick + i * 7, i * 12);
				return { id: d.id, name: d.name, look: d.look, status: status.get(d.id), pane: "desktop", userInControl: status.get(d.id)?.statusLine === "You're teaching me", jpegBase64: f.png.toString("base64"), width: f.w, height: f.h, cursor: f.cursor };
			});
		return json(res, 200, { screens });
	}
	return json(res, 404, { error: `Mock has no ${method} ${path}` });
});

// ---------------------------------------------------------------- /v1/computer/live (minimal WebSocket)

function wsFrame(payload, opcode) {
	const len = payload.length;
	const head = len < 126 ? Buffer.from([0x80 | opcode, len]) : len < 65536 ? Buffer.from([0x80 | opcode, 126, len >> 8, len & 255]) : Buffer.concat([Buffer.from([0x80 | opcode, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(len)); return b; })()]);
	return Buffer.concat([head, payload]);
}

server.on("upgrade", (req, socket) => {
	const url = new URL(req.url ?? "/", BASE);
	if (url.pathname !== "/v1/computer/live" || !authorised(req.headers.authorization)) {
		socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
		return;
	}
	const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
	socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
	let t = 0;
	const timer = setInterval(() => {
		const f = desktopFrame(t++);
		const head = Buffer.from(`${JSON.stringify({ w: f.w, h: f.h, cursor: f.cursor })}\n`);
		socket.write(wsFrame(Buffer.concat([head, f.png]), 2));
	}, 400);
	socket.on("data", (data) => {
		// Close frames end it; inputs (masked text frames) are accepted and ignored.
		if ((data[0] & 0x0f) === 8) socket.end();
	});
	socket.on("close", () => clearInterval(timer));
	socket.on("error", () => clearInterval(timer));
});

server.listen(PORT, "127.0.0.1", () => {
	console.log(`mock vos: ${BASE}  (API key: ${KEY === "dev-vos-key" ? "dev-vos-key" : "from MOCK_VOS_KEY"})`);
});
