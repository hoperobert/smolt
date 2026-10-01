// Type-only import: a standalone install of this module outside the smolt
// tree switches this single line to `from "smolt"`.
import type { ExtensionAPI, ExtensionCommandContext } from "../../core/extensions/types.ts";
import { groupDot, VosClient, VosError } from "./client.ts";
import { type ResolvedVosConfig, resolveVosConfig } from "./config.ts";
import {
	ago,
	decisionLabel,
	describeTrigger,
	isBusy,
	kindLabel,
	moodLabel,
	sortRoster,
	unreadTotal,
} from "./format.ts";
import type { Group, Message, Roster, RosterDot, VosEvent, VosStatus } from "./types.ts";

/**
 * /vos: the user's Vos teammates from the terminal.
 *
 *   /vos                        roster and unread counts
 *   /vos chat <name> [message]  send to a vos or group chat and follow the reply; no message shows the latest
 *   /vos routines [name]        a vos's routines (main when no name)
 *   /vos skills                 the shared skills library
 *   /vos rules                  auto-review rules
 *   /vos groups                 group chats
 *   /vos connect                how to set it up
 *
 * The key comes from VOS_API_KEY, or an `apiKey` the user wrote into
 * ~/.smolt/vos.json; see config.ts for why the desktop app's encrypted key
 * is not readable here.
 */

const SUBCOMMANDS = [
	{ value: "chat", description: "Send to a vos or group and follow the reply" },
	{ value: "routines", description: "A vos's routines" },
	{ value: "skills", description: "The shared skills library" },
	{ value: "rules", description: "Auto-review rules" },
	{ value: "groups", description: "Group chats" },
	{ value: "connect", description: "How to connect smolt to Vos" },
];

/** How long a sent message's replies are followed before the follow gives up. */
const FOLLOW_MS = 4 * 60_000;

export interface VosExtensionOptions {
	env?: NodeJS.ProcessEnv;
	fetch?: typeof fetch;
}

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
		"The TUI reads the API key from the environment:",
		"",
		"```",
		"export VOS_API_KEY=<your Vos API key>          # PowerShell: $env:VOS_API_KEY = '<key>'",
		`export VOS_URL=${config.url}   # optional; this is the default`,
		"```",
		"",
		`Or put \`"apiKey": "<key>"\` (and \`"url"\`) in ${config.path} yourself; keep that file private to your account.`,
		"",
		"The desktop app's Vos section stores its key encrypted by the operating system, which only the desktop app can read, so the TUI needs one of the two above.",
	];
	if (config.desktopOnly) lines.push("", "This machine has a desktop-app key saved; the TUI still needs VOS_API_KEY.");
	if (config.apiKey)
		lines.push("", `A key is set (from ${config.keySource === "env" ? "VOS_API_KEY" : config.path}).`);
	return lines.join("\n");
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
	const extra = m.choices?.length ? `  [${m.choices.join(" / ")}]` : "";
	const attachment =
		m.attachment?.type === "secret"
			? "  (asks for a secret: answer it in the Vos app or smolt desktop)"
			: m.attachment?.type === "image"
				? "  (image)"
				: m.attachment?.type === "link"
					? `  (${m.attachment.title}: ${m.attachment.url})`
					: "";
	return `**${who}:** ${m.text}${extra}${attachment}`;
}

export function createVosExtension(options: VosExtensionOptions = {}) {
	return function vosExtension(smolt: ExtensionAPI): void {
		/** Follows in flight, per thread, so a second send does not double every reply. */
		const following = new Map<string, AbortController>();

		const say = (content: string): void => {
			smolt.sendMessage({ customType: "vos", content, display: true });
		};

		const clientOr = (ctx: ExtensionCommandContext): VosClient | undefined => {
			const config = resolveVosConfig(options.env ?? process.env);
			if (!config.apiKey) {
				say(connectHelp(config));
				ctx.ui.notify("Vos is not connected: set VOS_API_KEY.", "warning");
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

		const run = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
			const trimmed = args.trim();
			const [sub = "", ...restWords] = trimmed.split(/\s+/);
			const rest = trimmed.slice(sub.length).trim();
			if (sub === "connect") {
				say(connectHelp(resolveVosConfig(options.env ?? process.env)));
				return;
			}
			const client = clientOr(ctx);
			if (!client) return;

			if (sub === "") {
				const roster = await client.roster();
				const { shown, hidden } = sortRoster(roster.dots);
				const lines = [`## Your vos (${unreadTotal(roster)} unread)`, "", ...shown.map(rosterLine)];
				if (roster.groups.length) {
					lines.push("", "**Group chats**", "");
					for (const g of roster.groups) lines.push(`- ${g.name}${g.unread ? ` · **${g.unread} unread**` : ""}`);
				}
				if (hidden.length) lines.push("", `Hidden: ${hidden.map((d) => d.name).join(", ")}`);
				lines.push("", "`/vos chat <name> <message>` to talk to one.");
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
							"",
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

			if (sub === "routines") {
				const roster = await client.roster();
				const thread = restWords.length ? findThread(roster, rest) : undefined;
				if (restWords.length && thread?.kind !== "vos") {
					ctx.ui.notify(`No vos called "${rest}".`, "warning");
					return;
				}
				const vos =
					thread?.kind === "vos" ? thread.vos : (roster.dots.find((d) => d.id === "main") ?? roster.dots[0]);
				if (!vos) {
					ctx.ui.notify("No vos yet.", "warning");
					return;
				}
				const routines = await client.routines(vos.id);
				const lines = [`## ${vos.name}'s routines`, ""];
				if (routines.length === 0) lines.push("None yet.");
				for (const r of routines) {
					const state = r.enabled ? "on" : r.pausedReason ? `paused: ${r.pausedReason}` : "off";
					const last = r.runs[0] ? ` · last ${r.runs[0].status} ${ago(r.runs[0].at)}` : "";
					const next = r.enabled && r.nextRun ? ` · next ${new Date(r.nextRun).toLocaleString()}` : "";
					lines.push(`- **${r.name}** (${state}): ${describeTrigger(r.trigger)}${next}${last}`);
				}
				say(lines.join("\n"));
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
					lines.push(
						`- **${decisionLabel(r.decision)}**: ${kindLabel(r.kind)} on ${r.site || "any site"}${match}${who}${r.note ? `: ${r.note}` : ""}`,
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

			ctx.ui.notify(`Unknown: /vos ${sub}. Try /vos, chat, routines, skills, rules, groups or connect.`, "warning");
		};

		smolt.registerCommand("vos", {
			description: "Your Vos teammates: roster, chat, routines, skills, rules, groups",
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
					const message = error instanceof VosError || error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Vos: ${message}`, "error");
				}
			},
		});

		smolt.on("session_shutdown", async () => {
			for (const controller of following.values()) controller.abort();
			following.clear();
		});
	};
}

export default createVosExtension();
