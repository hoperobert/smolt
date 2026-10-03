// Type-only import: a standalone install of this module outside the smolt
// tree switches this single line to `from "smolt"`.

import { hostname } from "node:os";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../../core/extensions/types.ts";
import { deviceName, groupDot, pollPairing, startPairing, VosClient, VosError } from "./client.ts";
import { type ResolvedVosConfig, resolveVosConfig, SECRET_DEVICE, SECRET_KEY, saveVosUrl } from "./config.ts";
import {
	ago,
	decisionLabel,
	describeTrigger,
	inboxKindLabel,
	isBusy,
	kindLabel,
	moodLabel,
	rosterSections,
	sortInbox,
	sortRoster,
	unreadTotal,
	untilLabel,
} from "./format.ts";
import { showVosPanel } from "./panel.ts";
import { encodeQr, qrTerminal } from "./qr.ts";
import { type SocketFactory, VosService } from "./service.ts";
import type { Group, InboxItem, Message, PairStart, Roster, RosterDot, VosEvent, VosStatus } from "./types.ts";
import { loadViewHtml } from "./view-html.ts";

/**
 * Vos: the user's AI teammates, as an extension.
 *
 * In graphical front ends it contributes a view (the desktop app's Vos
 * section): a page built from ./view whose every request is answered here,
 * by a VosService that holds the key. In the terminal it has commands and a
 * panel:
 *
 *   /vos                        roster (by section) and unread counts
 *   /vos panel                  inbox, chats, memory and coding agents in an overlay
 *   /vos inbox                  what needs you, across all vos
 *   /vos chat <name> [message]  send to a vos or group chat and follow the reply; no message shows the latest
 *   /vos memory <name>          what a vos remembers about you
 *   /vos routines [name]        a vos's routines (main when no name)
 *   /vos connectors [name]      the apps a vos can use
 *   /vos code <name> <task>     a coding agent on the vos's computer
 *   /vos skills                 the shared skills library
 *   /vos rules                  auto-review rules and approvals in advance
 *   /vos groups                 group chats
 *   /vos connect                pair with the phone: a QR here, approved in the Vos app
 *
 * The key comes from VOS_API_KEY, or from the host's secret store (the OS
 * keystore in the desktop app, a 0600 file in the terminal), which pairing
 * writes. See config.ts.
 */

const SUBCOMMANDS = [
	{ value: "panel", description: "Inbox, chats, memory and coding agents in an overlay" },
	{ value: "inbox", description: "What needs you, across all vos" },
	{ value: "chat", description: "Send to a vos or group and follow the reply" },
	{ value: "memory", description: "What a vos remembers about you" },
	{ value: "routines", description: "A vos's routines" },
	{ value: "connectors", description: "The apps a vos can use" },
	{ value: "code", description: "Start a coding agent on a vos's computer" },
	{ value: "skills", description: "The shared skills library" },
	{ value: "rules", description: "Auto-review rules" },
	{ value: "groups", description: "Group chats" },
	{ value: "connect", description: "Pair with your phone by QR (help: the API-key way)" },
];

/** How long a sent message's replies are followed before the follow gives up. */
const FOLLOW_MS = 4 * 60_000;

export interface VosExtensionOptions {
	env?: NodeJS.ProcessEnv;
	fetch?: typeof fetch;
	/** How often a pairing is polled; tests shorten it. */
	pollMs?: number;
	/** This machine's name, for what the phone shows; tests fix it. */
	host?: string;
	/** The live computer view's WebSocket; tests replace it. */
	socket?: SocketFactory;
}

/** The view's id, and the settings section's. */
export const VIEW_ID = "vos";
export const SETTINGS_VIEW_ID = "vos-settings";

/** A vos or group by name: exact, then prefix, case-insensitive; ids work too. */
export function findThread(
	roster: Roster,
	name: string,
): { kind: "vos"; vos: RosterDot } | { kind: "group"; group: Group } | undefined {
	const q = name.trim().toLowerCase();
	if (q === "") return undefined;
	const exactDot = roster.dots.find((d) => d.name.toLowerCase() === q || d.id === name.trim());
	if (exactDot) return { kind: "vos", vos: exactDot };
	const exactGroup = roster.groups.find((g) => g.name.toLowerCase() === q || g.id === name.trim());
	if (exactGroup) return { kind: "group", group: exactGroup };
	const dot = roster.dots.find((d) => d.name.toLowerCase().startsWith(q));
	if (dot) return { kind: "vos", vos: dot };
	const group = roster.groups.find((g) => g.name.toLowerCase().startsWith(q));
	return group ? { kind: "group", group } : undefined;
}

/**
 * Split "chat Ada Lovelace hello there" into the thread name and the message,
 * trying the longest name the roster knows first so names with spaces work.
 */
export function splitNameAndMessage(roster: Roster, rest: string): { name: string; message: string } {
	const words = rest.trim().split(/\s+/).filter(Boolean);
	const names = [...roster.dots.map((d) => d.name), ...roster.groups.map((g) => g.name)].map((n) => n.toLowerCase());
	for (let take = words.length; take > 1; take--) {
		const candidate = words.slice(0, take).join(" ").toLowerCase();
		if (names.includes(candidate))
			return { name: words.slice(0, take).join(" "), message: words.slice(take).join(" ") };
	}
	return { name: words[0] ?? "", message: words.slice(1).join(" ") };
}

export function connectHelp(config: ResolvedVosConfig): string {
	const lines = [
		"## Connect smolt to Vos",
		"",
		"`/vos connect` pairs this terminal with your phone: scan the QR it shows and approve in the Vos app.",
		"",
		"Without a phone, the TUI takes an API key from the environment instead:",
		"",
		"```",
		"export VOS_API_KEY=<your Vos API key>          # PowerShell: $env:VOS_API_KEY = '<key>'",
		`export VOS_URL=${config.url}   # optional; this is the default`,
		"```",
		"",
		"The desktop app keeps its own key with the operating system's keystore; the terminal pairs on its own and keeps its key in a file only you can read.",
	];
	if (config.keySource === "env") lines.push("", "VOS_API_KEY is set, so the TUI uses it.");
	else if (config.apiKey) {
		lines.push(
			"",
			`Connected${config.deviceName ? ` as ${config.deviceName}` : ""} (key kept in the ${config.keySource === "keychain" ? "OS keystore" : "secret store"}).`,
		);
	}
	return lines.join("\n");
}

function inboxLine(item: InboxItem, names: Map<string, string>): string {
	const flag = item.priority === "high" ? "**!** " : "";
	return `- ${flag}**${names.get(item.vos) ?? item.vos}** · ${inboxKindLabel(item.kind)}: ${item.title}${item.detail ? ` (${item.detail})` : ""} · ${ago(item.date)}`;
}

/** What the transcript says about a pairing; the QR itself is a widget above the prompt. */
export function pairingMessage(pair: PairStart, minutes: number): string {
	const digits = pair.short ? `${pair.short.slice(0, 3)} ${pair.short.slice(3)}` : "";
	return [
		"## Connect smolt to Vos",
		"",
		"Scan the QR above the prompt with your iPhone's camera, or in the Vos app (Settings › Connected devices › Scan), and approve with Face ID.",
		...(digits ? ["", `No camera handy? Enter **${digits}** in the Vos app.`] : []),
		"",
		`The code expires in ${minutes} minute${minutes === 1 ? "" : "s"}. Waiting for your phone…`,
	].join("\n");
}

/**
 * The QR as terminal lines, white on black whatever the terminal's colours:
 * scanners want dark modules on a light ground, and a light theme's default
 * colours would invert it.
 */
export function pairingQrLines(pair: PairStart): string[] {
	return qrTerminal(encodeQr(pair.url, "M")).map((line) => `\x1b[38;2;255;255;255m\x1b[48;2;0;0;0m${line}\x1b[0m`);
}

function rosterLine(d: RosterDot): string {
	const status = d.status
		? `${moodLabel(d.status.mood)}${d.status.statusLine ? ` · ${d.status.statusLine}` : ""}`
		: "Idle";
	const unread = d.unread ? ` · **${d.unread} unread**` : "";
	const label = d.label ? ` (${d.label})` : "";
	const pin = d.pinned ? " [pinned]" : "";
	return `- **${d.name}**${label}${pin}: ${status}${unread}`;
}

function messageLine(m: Message, threadName: string): string {
	const who = m.role === "you" ? "You" : (m.fromVos?.name ?? threadName);
	// Choices under an approval are the approval's; once it is answered they are noise.
	const extra = m.choices?.length && m.attachment?.type !== "approval" ? `  [${m.choices.join(" / ")}]` : "";
	const attachment =
		m.attachment?.type === "secret"
			? "  (asks for a secret: answer it in the Vos app or smolt desktop)"
			: m.attachment?.type === "approval"
				? "  (an approval: answer it in the Vos app or smolt desktop)"
				: m.attachment?.type === "image"
					? "  (image)"
					: m.attachment?.type === "link"
						? `  (${m.attachment.title}: ${m.attachment.url})`
						: "";
	return `**${who}:** ${m.text}${extra}${attachment}`;
}

/** A vos by name, or main when no name is given; a group does not count. */
function vosByName(roster: Roster, name: string): RosterDot | undefined {
	if (!name.trim()) return roster.dots.find((d) => d.id === "main") ?? roster.dots[0];
	const thread = findThread(roster, name);
	return thread?.kind === "vos" ? thread.vos : undefined;
}

/** A request's params as a record, whatever the view sent. */
const record = (params: unknown): Record<string, unknown> =>
	params && typeof params === "object" && !Array.isArray(params) ? (params as Record<string, unknown>) : {};
const text = (value: unknown): string => (typeof value === "string" ? value : value === undefined ? "" : String(value));

export function createVosExtension(options: VosExtensionOptions = {}) {
	return function vosExtension(smolt: ExtensionAPI): void {
		const env = options.env ?? process.env;
		/** Follows in flight, per thread, so a second send does not double every reply. */
		const following = new Map<string, AbortController>();

		const say = (content: string): void => {
			smolt.sendMessage({ customType: "vos", content, display: true });
		};

		/** The pairing waiting for the phone, if any: a new /vos connect replaces it. */
		let pairing: AbortController | undefined;

		/**
		 * The service behind the view, made on first use: a terminal session
		 * that never opens the view pays nothing for it.
		 */
		let service: VosService | undefined;
		const vos = (): VosService => {
			service ??= new VosService({
				secrets: smolt.secrets,
				post: (event, data) => smolt.postToView(VIEW_ID, event, data),
				env,
				fetch: options.fetch,
				socket: options.socket,
				pollMs: options.pollMs,
				host: options.host,
			});
			return service;
		};

		const clientOr = async (ctx: ExtensionCommandContext): Promise<VosClient | undefined> => {
			const config = await resolveVosConfig(smolt.secrets, env);
			if (!config.apiKey) {
				ctx.ui.notify("Vos is not connected. Run /vos connect to pair with your phone.", "warning");
				return undefined;
			}
			return new VosClient({ baseUrl: config.url, apiKey: config.apiKey, fetch: options.fetch });
		};

		/** Show the thread's new messages as they land, until the vos settles after answering. */
		const follow = (
			client: VosClient,
			dot: string,
			threadName: string,
			after: string,
			ctx: ExtensionCommandContext,
		) => {
			following.get(dot)?.abort();
			const controller = new AbortController();
			following.set(dot, controller);
			const seen = new Set<string>([after]);
			let answered = false;
			const timer = setTimeout(() => controller.abort(), FOLLOW_MS);
			const finish = (): void => {
				clearTimeout(timer);
				controller.abort();
				if (following.get(dot) === controller) following.delete(dot);
				ctx.ui.setStatus("vos", undefined);
			};
			ctx.ui.setStatus("vos", `${threadName} is answering…`);
			const onEvent = (event: VosEvent): void => {
				if (event.event === "message.created" || event.event === "message.updated") {
					const m = event.data as Message;
					if (!m?.id || seen.has(m.id) || m.role === "you") return;
					seen.add(m.id);
					answered = true;
					say(messageLine(m, threadName));
				} else if (event.event === "status") {
					const status = event.data as Partial<VosStatus>;
					if (isBusy(status.mood)) {
						ctx.ui.setStatus("vos", `${threadName}: ${status.statusLine || moodLabel(status.mood)}`);
					} else if (answered) {
						finish();
					}
				} else if (event.event === "secret") {
					say(
						`**${threadName}** asks for a secret. Answer it in the Vos app or smolt desktop; the TUI never takes secrets.`,
					);
				}
			};
			void client
				.events(dot, onEvent, { signal: controller.signal })
				.catch((error: unknown) => {
					if (!controller.signal.aborted) {
						ctx.ui.notify(`Vos stream: ${error instanceof Error ? error.message : String(error)}`, "warning");
					}
				})
				.finally(finish);
		};

		/**
		 * Pair with the phone: show the QR and the six digits, then poll in the
		 * background (the session stays usable) until it is approved, declined
		 * or expires. The device key goes to the secret store.
		 */
		const pair = async (config: ResolvedVosConfig, ctx: ExtensionCommandContext): Promise<void> => {
			pairing?.abort();
			const controller = new AbortController();
			pairing = controller;
			const name = deviceName(options.host ?? hostname(), "smolt-tui");
			const started = await startPairing(config.url, name, "smolt-tui", options.fetch);
			const expires = Date.parse(started.expiresAt);
			say(pairingMessage(started, Math.max(1, Math.round((expires - Date.now()) / 60_000))));
			ctx.ui.setStatus("vos", "Vos: waiting for your phone…");
			const qrLines = pairingQrLines(started);
			ctx.ui.setWidget("vos-pair", () => ({ render: () => qrLines, invalidate: () => {} }));
			const every = options.pollMs ?? 2000;
			void (async () => {
				try {
					while (!controller.signal.aborted) {
						await new Promise((resolve) => setTimeout(resolve, every));
						if (controller.signal.aborted) return;
						const result = await pollPairing(config.url, started.id, started.code, options.fetch).catch(
							() => null,
						);
						if (!result || result.state === "pending") {
							if (Date.now() <= expires + 5000) continue;
							say("The pairing code expired. Run `/vos connect` for a new one.");
							return;
						}
						if (result.state === "approved" && result.key) {
							saveVosUrl(config.url, env);
							await smolt.secrets.set(SECRET_KEY, result.key);
							await smolt.secrets.set(SECRET_DEVICE, name);
							const where =
								(await smolt.secrets.backend()) === "keychain"
									? "in your operating system's keystore"
									: "in a file only you can read";
							say(
								`Connected as **${name}**. The device key is kept ${where}; revoke it any time in the Vos app (Settings › Connected devices). Try \`/vos\`.`,
							);
							return;
						}
						say(
							result.state === "denied"
								? "The pairing was declined on the phone."
								: "The pairing code expired. Run `/vos connect` for a new one.",
						);
						return;
					}
				} finally {
					if (pairing === controller) {
						pairing = undefined;
						ctx.ui.setWidget("vos-pair", undefined);
					}
					ctx.ui.setStatus("vos", undefined);
				}
			})();
		};

		const run = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
			const trimmed = args.trim();
			const [sub = "", ...restWords] = trimmed.split(/\s+/);
			const rest = trimmed.slice(sub.length).trim();
			if (sub === "connect") {
				const config = await resolveVosConfig(smolt.secrets, env);
				if (restWords[0] === "help" || config.keySource === "env") {
					say(connectHelp(config));
					return;
				}
				await pair(config, ctx);
				return;
			}
			const client = await clientOr(ctx);
			if (!client) return;

			if (sub === "") {
				const roster = await client.roster();
				const { hidden } = sortRoster(roster.dots);
				const lines = [`## Your vos (${unreadTotal(roster)} unread)`, ""];
				for (const section of rosterSections(roster.dots)) {
					if (section.name) lines.push(`**${section.name}**`, "");
					lines.push(...section.dots.map(rosterLine), "");
				}
				if (roster.groups.length) {
					lines.push("**Group chats**", "");
					for (const g of roster.groups) lines.push(`- ${g.name}${g.unread ? ` · **${g.unread} unread**` : ""}`);
					lines.push("");
				}
				if (hidden.length)
					lines.push(`Hidden (routines keep running): ${hidden.map((d) => d.name).join(", ")}`, "");
				lines.push("`/vos chat <name> <message>` to talk to one, `/vos panel` for the inbox.");
				say(lines.join("\n"));
				return;
			}

			if (sub === "panel") {
				if (ctx.mode !== "tui") {
					ctx.ui.notify("The Vos panel is a terminal overlay; the desktop app has the Vos view instead.", "info");
					return;
				}
				await showVosPanel(ctx, client);
				return;
			}

			if (sub === "inbox") {
				const [items, roster] = await Promise.all([client.inbox({ state: "open" }), client.roster()]);
				const names = new Map(roster.dots.map((d) => [d.id, d.name]));
				const lines = ["## Inbox", ""];
				if (items.length === 0) lines.push("Nothing needs you.");
				for (const item of sortInbox(items)) lines.push(inboxLine(item, names));
				if (items.length) lines.push("", "`/vos panel` to approve, mark done or dismiss.");
				say(lines.join("\n"));
				return;
			}

			if (sub === "chat") {
				const roster = await client.roster();
				const { name, message } = splitNameAndMessage(roster, rest);
				const thread = findThread(roster, name);
				if (!thread) {
					ctx.ui.notify(
						name ? `No vos or group called "${name}".` : "Usage: /vos chat <name> [message]",
						"warning",
					);
					return;
				}
				const dot = thread.kind === "vos" ? thread.vos.id : groupDot(thread.group.id);
				const threadName = thread.kind === "vos" ? thread.vos.name : thread.group.name;
				if (message === "") {
					const messages = await client.messages(dot, 12);
					const recent = [...messages].sort((a, b) => a.date.localeCompare(b.date));
					say(
						[
							`## ${threadName}`,
							...(recent.length ? recent.map((m) => messageLine(m, threadName)) : ["No messages yet."]),
						].join("\n\n"),
					);
					return;
				}
				const sent = await client.send(dot, message, `smolt-tui-${Date.now()}`);
				say(`**You → ${threadName}:** ${message}`);
				follow(client, dot, threadName, sent.id, ctx);
				return;
			}

			if (sub === "memory") {
				const roster = await client.roster();
				const vosDot = vosByName(roster, rest);
				if (!vosDot) {
					ctx.ui.notify(`No vos called "${rest}".`, "warning");
					return;
				}
				const notes = await client.memory(vosDot.id);
				const lines = [`## What ${vosDot.name} remembers`, ""];
				if (notes.length === 0) lines.push("Nothing yet.");
				for (const note of notes) lines.push(`- ${note.text}`);
				lines.push("", "Add, edit or forget notes in `/vos panel` or the desktop app's Memory tab.");
				say(lines.join("\n"));
				return;
			}

			if (sub === "routines") {
				const roster = await client.roster();
				const thread = restWords.length ? findThread(roster, rest) : undefined;
				if (restWords.length && thread?.kind !== "vos") {
					ctx.ui.notify(`No vos called "${rest}".`, "warning");
					return;
				}
				const vosDot =
					thread?.kind === "vos" ? thread.vos : (roster.dots.find((d) => d.id === "main") ?? roster.dots[0]);
				if (!vosDot) {
					ctx.ui.notify("No vos yet.", "warning");
					return;
				}
				const routines = await client.routines(vosDot.id);
				const lines = [`## ${vosDot.name}'s routines`, ""];
				if (routines.length === 0) lines.push("None yet.");
				for (const r of routines) {
					const state = r.enabled ? "on" : r.pausedReason ? `paused: ${r.pausedReason}` : "off";
					const last = r.runs[0] ? ` · last ${r.runs[0].status} ${ago(r.runs[0].at)}` : "";
					const next =
						r.enabled && r.nextRun
							? ` · next ${new Date(r.nextRun).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`
							: "";
					lines.push(`- **${r.name}** (${state}): ${describeTrigger(r.trigger)}${next}${last}`);
				}
				say(lines.join("\n"));
				return;
			}

			if (sub === "connectors") {
				const roster = await client.roster();
				const vosDot = vosByName(roster, rest);
				const plugins = await client.plugins(vosDot?.id);
				const lines = ["## Connectors", ""];
				if (plugins.length === 0) lines.push("None available.");
				for (const p of [...plugins].sort(
					(a, b) => Number(b.connected) - Number(a.connected) || a.name.localeCompare(b.name),
				)) {
					const state = p.connected ? `connected${p.account ? ` as ${p.account}` : ""}` : "not connected";
					const scopes = p.connected && p.scopes?.length ? ` · ${p.scopes.join(", ")}` : "";
					lines.push(`- **${p.name}**: ${state}${scopes}`);
				}
				lines.push(
					"",
					"Connect or disconnect in the desktop app's Connectors tab (sign-in opens in your browser).",
				);
				say(lines.join("\n"));
				return;
			}

			if (sub === "code") {
				const roster = await client.roster();
				const { name, message } = splitNameAndMessage(roster, rest);
				const vosDot = vosByName(roster, name);
				if (!vosDot || !message) {
					ctx.ui.notify("Usage: /vos code <name> <what to build or fix> [in owner/repo]", "warning");
					return;
				}
				const repo = /\bin\s+([\w.-]+\/[\w.-]+)\s*$/.exec(message)?.[1];
				const task = await client.startCoding(vosDot.id, message, repo);
				say(
					`**${vosDot.name}** started a coding agent${repo ? ` on ${repo}` : ""}: ${task.title || message}. It follows ${vosDot.name}'s rules and asks for approvals as usual.`,
				);
				return;
			}

			if (sub === "skills") {
				const skills = await client.skills();
				const lines = ["## Skills", ""];
				if (skills.length === 0) lines.push("None yet.");
				for (const s of [...skills].sort((a, b) => a.slug.localeCompare(b.slug))) {
					lines.push(
						`- \`/${s.slug}\` **${s.title}**${s.draft ? " (draft)" : ""}: ${s.description} · used ${s.uses}×`,
					);
				}
				say(lines.join("\n"));
				return;
			}

			if (sub === "rules") {
				const [rules, roster] = await Promise.all([client.rules(), client.roster()]);
				const names = new Map(roster.dots.map((d) => [d.id, d.name]));
				const lines = ["## Auto-review rules", ""];
				if (rules.length === 0) lines.push("None yet: every consequential action asks first.");
				for (const r of rules) {
					const who = r.vos ? ` (only ${names.get(r.vos) ?? r.vos})` : "";
					const match = r.match ? `, ${r.match}` : "";
					const until = r.expiresAt ? ` (${untilLabel(r.expiresAt)})` : "";
					lines.push(
						`- **${decisionLabel(r.decision)}**${until}: ${kindLabel(r.kind)} on ${r.site || "any site"}${match}${who}${r.note ? `: ${r.note}` : ""}`,
					);
				}
				say(lines.join("\n"));
				return;
			}

			if (sub === "groups") {
				const roster = await client.roster();
				const names = new Map(roster.dots.map((d) => [d.id, d.name]));
				const lines = ["## Group chats", ""];
				if (roster.groups.length === 0) lines.push("None yet.");
				for (const g of roster.groups) {
					const members = g.members.map((id, i) => `${names.get(id) ?? id}${i === 0 ? " (lead)" : ""}`).join(", ");
					lines.push(`- **${g.name}**: ${members}${g.unread ? ` · **${g.unread} unread**` : ""}`);
				}
				say(lines.join("\n"));
				return;
			}

			ctx.ui.notify(
				`Unknown: /vos ${sub}. Try /vos, panel, inbox, chat, memory, routines, connectors, code, skills, rules, groups or connect.`,
				"warning",
			);
		};

		smolt.registerCommand("vos", {
			description: "Your Vos teammates: roster, inbox, chat, memory, routines, connectors, coding agents",
			getArgumentCompletions: (prefix) => {
				if (prefix.includes(" ")) return null;
				const items = SUBCOMMANDS.filter((s) => s.value.startsWith(prefix)).map((s) => ({
					value: s.value,
					label: s.value,
					description: s.description,
				}));
				return items.length ? items : null;
			},
			handler: async (args, ctx) => {
				try {
					await run(args, ctx);
				} catch (error) {
					if (error instanceof VosError && error.status === 401) {
						ctx.ui.notify(
							"Vos refused this terminal's key (revoked in the Vos app?). Run /vos connect to pair again.",
							"error",
						);
						return;
					}
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Vos: ${message}`, "error");
				}
			},
		});

		// ---------------------------------------------------------------- the view

		smolt.registerView({ id: VIEW_ID, title: "Vos", icon: "◉", location: "sidebar", order: -10, html: loadViewHtml });
		smolt.registerView({
			id: SETTINGS_VIEW_ID,
			title: "Vos",
			location: "settings",
			order: -10,
			html: loadViewHtml,
		});

		const handle = async (method: string, params: unknown): Promise<unknown> => {
			const p = record(params);
			const s = vos();
			switch (method) {
				case "status":
					return s.status();
				case "connect":
					return s.connect(text(p.url), text(p.key));
				case "disconnect":
					return s.disconnect();
				case "pairStart":
					return s.pairStart(text(p.url));
				case "pairCancel":
					s.pairCancel();
					return null;
				case "call":
					return s.call(text(p.method), text(p.path), p.body, typeof p.dot === "string" ? p.dot : undefined);
				case "secret":
					return s.answerSecret(text(p.dot), text(p.id), typeof p.value === "string" ? p.value : "");
				case "file":
					return s.file(text(p.path));
				case "watch":
					await s.watch(text(p.dot));
					return null;
				case "unwatch":
					s.unwatch(text(p.dot));
					return null;
				case "liveOpen":
					return s.liveOpen(text(p.dot));
				case "liveInput":
					return s.liveInput(text(p.dot), p.input);
				case "liveClose":
					s.liveClose(text(p.dot));
					return null;
				case "inboxRefresh":
					s.pokeInbox(0);
					return null;
				default:
					throw new Error(`Unknown Vos request: ${method}`);
			}
		};
		smolt.onViewRequest(VIEW_ID, (method, params) => handle(method, params));
		smolt.onViewRequest(SETTINGS_VIEW_ID, (method, params) => handle(method, params));

		/** Names for notifications, read when the first one needs them. */
		let names: Map<string, string> | undefined;
		const nameOf = async (id: string): Promise<string> => {
			if (!names?.has(id)) {
				const client = await vos().current();
				const roster = await client?.roster().catch(() => undefined);
				if (roster) names = new Map(roster.dots.map((d) => [d.id, d.name]));
			}
			return names?.get(id) ?? "Vos";
		};

		// A front end that shows views keeps the sidebar badge current and is
		// told, natively, when something urgent lands in the inbox.
		smolt.on("views_attached", (_event, ctx: ExtensionContext) => {
			vos().watchInbox(
				(count) => smolt.setViewBadge(VIEW_ID, (count?.unread ?? count?.open) || undefined),
				(item) => {
					void nameOf(item.vos).then((name) =>
						ctx.ui.notify(`${name}: ${item.title}`, "info", {
							native: true,
							title: `${name} needs you`,
							openView: VIEW_ID,
						}),
					);
				},
			);
		});

		smolt.on("session_shutdown", async () => {
			pairing?.abort();
			for (const controller of following.values()) controller.abort();
			following.clear();
			service?.dispose();
			service = undefined;
		});
	};
}

export default createVosExtension();
