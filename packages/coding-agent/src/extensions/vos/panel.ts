import {
	type Component,
	Container,
	type Focusable,
	Input,
	type SelectItem,
	SelectList,
	Spacer,
	Text,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@smolt/tui";
import type { ExtensionCommandContext } from "../../core/extensions/types.ts";
import type { KeybindingsManager } from "../../core/keybindings.ts";
import { DynamicBorder } from "../../modes/interactive/components/dynamic-border.ts";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import {
	agentDuration,
	agentStateLabel,
	checksLabel,
	isAgentActive,
	parseAgentArgs,
	parseRepo,
	sortAgents,
} from "./agents.ts";
import { groupDot, type VosClient, VosError } from "./client.ts";
import { ago, inboxKindLabel, moodLabel, rosterSections, sortInbox } from "./format.ts";
import { type AgentJob, FACE_ID_KINDS, type InboxItem, type Message, type Roster } from "./types.ts";

/**
 * /vos panel: the Vos view's essentials in the terminal, as an overlay.
 *
 * Every screen is a list (the terminal's own select keys move and pick), so
 * nothing here binds a key of its own: the inbox and what to do with an item,
 * each vos's latest messages, sending one, its memory, cloud agents (list,
 * log, message, cancel, retry, start), and starting a coding agent. The live
 * computer and the editors stay in the desktop app.
 */

function selectTheme(theme: Theme) {
	return {
		selectedPrefix: (text: string) => theme.fg("accent", text),
		selectedText: (text: string) => theme.fg("accent", text),
		description: (text: string) => theme.fg("muted", text),
		scrollInfo: (text: string) => theme.fg("dim", text),
		noMatch: (text: string) => theme.fg("warning", text),
	};
}

function frame(theme: Theme, title: string, body: Component[], footer?: string): Container {
	const container = new Container();
	container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
	container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
	for (const child of body) container.addChild(child);
	if (footer) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", footer), 1, 0));
	}
	container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
	return container;
}

const BACK = "\0back";

/** The menu rows of the home screen: the inbox, cloud agents, then each vos by section, then groups. */
export function homeItems(roster: Roster, open: number, running = 0): SelectItem[] {
	const items: SelectItem[] = [
		{ value: "inbox", label: `Inbox${open ? ` (${open} open)` : ""}`, description: "What needs you, across all vos" },
		{
			value: "agents",
			label: `Cloud agents${running ? ` (${running} running)` : ""}`,
			description: "A VM per task, ending in a PR",
		},
	];
	for (const section of rosterSections(roster.dots)) {
		for (const d of section.dots) {
			const status = d.status?.statusLine || moodLabel(d.status?.mood);
			items.push({
				value: `vos:${d.id}`,
				label: `${d.name}${d.unread ? ` (${d.unread})` : ""}`,
				description: [section.name, d.label, status].filter(Boolean).join(" · "),
			});
		}
	}
	for (const g of roster.groups) {
		items.push({
			value: `group:${g.id}`,
			label: `${g.name}${g.unread ? ` (${g.unread})` : ""}`,
			description: "Group chat",
		});
	}
	return items;
}

/**
 * What can be done with one inbox item from the terminal. `faceId` marks an approval only the phone can
 * give (a purchase or an account change): it can still be denied here.
 */
export function inboxActions(item: InboxItem, faceId = false): SelectItem[] {
	const actions: SelectItem[] = [];
	if (item.ref?.type === "approval" && item.state === "open" && item.kind === "approval" && faceId) {
		actions.push({ value: "deny", label: "Deny", description: "Approve it on your phone: it needs Face ID" });
	} else if (item.ref?.type === "approval" && item.state === "open" && item.kind === "approval") {
		actions.push(
			{ value: "approve:once", label: "Approve once" },
			{ value: "approve:1h", label: "Approve for 1 hour" },
			{ value: "approve:today", label: "Approve today" },
			{ value: "deny", label: "Deny" },
		);
	}
	if (item.state === "open") {
		actions.push({ value: "done", label: "Mark done" }, { value: "dismiss", label: "Dismiss" });
	}
	if (item.ref?.type === "agent") actions.push({ value: `agent:${item.ref.id}`, label: "Open the job" });
	actions.push({ value: `vos:${item.vos}`, label: "Open its chat" }, { value: BACK, label: "Back" });
	return actions;
}

/** What can be done with one cloud agent job from the terminal. */
export function agentActions(job: AgentJob): SelectItem[] {
	const actions: SelectItem[] = [{ value: "log", label: "Log" }];
	if (isAgentActive(job.state)) {
		actions.push({ value: "message", label: "Message…" }, { value: "cancel", label: "Cancel" });
	} else {
		actions.push({ value: "retry", label: "Retry" });
	}
	actions.push({ value: "refresh", label: "Refresh" }, { value: BACK, label: "Back" });
	return actions;
}

class VosPanel implements Component, Focusable {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly client: VosClient;
	private readonly close: () => void;
	private content: Container;
	private input: { handleInput?(data: string): void } | undefined;
	private target: Focusable | undefined;
	private roster: Roster = { dots: [], groups: [] };
	private inbox: InboxItem[] = [];
	private agents: AgentJob[] = [];
	private _focused = false;

	constructor(tui: TUI, theme: Theme, keybindings: KeybindingsManager, client: VosClient, close: () => void) {
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.client = client;
		this.close = close;
		this.content = frame(theme, "Vos", [new Text(theme.fg("muted", "Loading…"), 1, 1)]);
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		if (this.target) this.target.focused = value;
	}

	private set(content: Container, input?: { handleInput?(data: string): void }, target?: Focusable): void {
		if (this.target) this.target.focused = false;
		this.content = content;
		this.input = input;
		this.target = target;
		if (target) target.focused = this._focused;
		this.tui.requestRender();
	}

	private list(
		title: string,
		body: Component[],
		items: SelectItem[],
		pick: (value: string) => void,
		back: () => void,
	): void {
		const list = new SelectList(items, Math.min(Math.max(items.length, 1), 14), selectTheme(this.theme), {
			minPrimaryColumnWidth: 24,
			maxPrimaryColumnWidth: 44,
		});
		list.onSelect = (item) => (item.value === BACK ? back() : pick(item.value));
		list.onCancel = back;
		this.set(
			frame(
				this.theme,
				title,
				[...body, new Spacer(1), list],
				`${keyHint("tui.select.confirm", "choose")} • ${keyHint("tui.select.cancel", "back")}`,
			),
			list,
		);
	}

	private note(title: string, message: string): void {
		this.set(frame(this.theme, title, [new Text(this.theme.fg("muted", message), 1, 1)]));
	}

	private fail(error: unknown): void {
		this.note("Vos", error instanceof Error ? error.message : String(error));
		setTimeout(() => void this.home(), 1800);
	}

	private ask(title: string, hint: string, done: (value: string | undefined) => void): void {
		const field = new Input();
		field.onSubmit = (value) => done(value.trim() || undefined);
		field.onEscape = () => done(undefined);
		this.set(
			frame(
				this.theme,
				title,
				[new Text(this.theme.fg("dim", hint), 1, 0), field],
				`${keyHint("tui.input.submit", "send")} • ${keyHint("tui.select.cancel", "back")}`,
			),
			field,
			field,
		);
	}

	async home(): Promise<void> {
		try {
			const [roster, inbox, agents] = await Promise.all([
				this.client.roster(),
				this.client.inbox({ state: "open" }).catch(() => [] as InboxItem[]),
				this.client.agents({ state: "all" }).catch(() => [] as AgentJob[]),
			]);
			this.roster = roster;
			this.inbox = sortInbox(inbox);
			this.agents = sortAgents(agents);
		} catch (error) {
			this.note("Vos", error instanceof Error ? error.message : String(error));
			return;
		}
		this.list(
			"Vos",
			[],
			homeItems(this.roster, this.inbox.length, this.agents.filter((j) => isAgentActive(j.state)).length),
			(value) => {
				if (value === "inbox") this.showInbox();
				else if (value === "agents") this.showAgents();
				else this.showThread(value.startsWith("vos:") ? value.slice(4) : groupDot(value.slice(6)));
			},
			this.close,
		);
	}

	private nameOf(id: string): string {
		return this.roster.dots.find((d) => d.id === id)?.name ?? id;
	}

	private showInbox(): void {
		const items: SelectItem[] = this.inbox.map((item) => ({
			value: item.id,
			label: `${item.priority === "high" ? "! " : ""}${this.nameOf(item.vos)}: ${item.title}`,
			description: `${inboxKindLabel(item.kind)} · ${ago(item.date)}`,
		}));
		if (items.length === 0) items.push({ value: BACK, label: "Nothing needs you" });
		this.list(
			"Inbox",
			[],
			items,
			(id) => {
				const item = this.inbox.find((i) => i.id === id);
				if (item) void this.showItem(item);
			},
			() => void this.home(),
		);
	}

	private async showItem(item: InboxItem): Promise<void> {
		const body = [new Text(this.theme.fg("muted", item.detail ?? inboxKindLabel(item.kind)), 1, 0)];
		// Whether the approval behind it needs Face ID, from the vos's own state.
		let faceId = false;
		if (item.ref?.type === "approval") {
			const state = await this.client.state(item.vos).catch(() => undefined);
			const approval = state?.approvals.find((a) => a.id === item.ref?.id);
			faceId = !!approval && FACE_ID_KINDS.includes(approval.kind);
		}
		this.list(
			`${this.nameOf(item.vos)}: ${item.title}`,
			body,
			inboxActions(item, faceId),
			(action) => {
				void this.act(item, action);
			},
			() => this.showInbox(),
		);
	}

	private async act(item: InboxItem, action: string): Promise<void> {
		try {
			if (action.startsWith("vos:")) {
				await this.showThread(action.slice(4));
				return;
			}
			if (action.startsWith("agent:")) {
				await this.showAgent(action.slice(6), () => this.showInbox());
				return;
			}
			if (action.startsWith("approve:") && item.ref) {
				const remember = action.slice("approve:".length) as "once" | "1h" | "today";
				await this.client.answerApproval(item.vos, item.ref.id, "approve", remember);
			} else if (action === "deny" && item.ref) {
				await this.client.answerApproval(item.vos, item.ref.id, "deny");
			} else if (action === "done") {
				await this.client.inboxDone(item.id);
			} else if (action === "dismiss") {
				await this.client.inboxDismiss(item.id);
			}
			this.inbox = sortInbox(await this.client.inbox({ state: "open" }).catch(() => this.inbox));
			this.showInbox();
		} catch (error) {
			this.fail(error);
		}
	}

	// ---------------------------------------------------------------- cloud agents

	private showAgents(): void {
		const items: SelectItem[] = [
			{ value: "start", label: "Start a cloud agent…", description: "owner/repo[@base] then the task" },
			...this.agents.slice(0, 30).map((job) => ({
				value: job.id,
				label: `${agentStateLabel(job.state)}: ${job.repo}`,
				description: [
					isAgentActive(job.state) ? job.step : (job.error ?? job.summary),
					job.pr
						? `PR #${job.pr.number}${job.pr.checks ? ` ${checksLabel(job.pr.checks).toLowerCase()}` : ""}`
						: "",
					agentDuration(job),
				]
					.filter(Boolean)
					.join(" · "),
			})),
			{ value: BACK, label: "Back" },
		];
		this.list(
			"Cloud agents",
			[],
			items,
			(value) => {
				if (value === "start") this.startAgent();
				else void this.showAgent(value, () => this.showAgents());
			},
			() => void this.home(),
		);
	}

	private startAgent(): void {
		this.ask("Cloud agent: repo", "owner/name, @branch for a base other than the default", (repoText) => {
			if (!repoText) return this.showAgents();
			const [repoPart = ""] = repoText.split(/\s+/);
			if (!parseRepo(repoPart.split("@")[0] ?? "")) {
				this.note("Cloud agents", "That is not owner/name.");
				setTimeout(() => this.startAgent(), 1500);
				return;
			}
			this.ask(`Task for ${repoPart}`, "What should it do? It ends in a PR.", (task) => {
				const parsed = task ? parseAgentArgs(`${repoPart} ${task}`) : undefined;
				if (!parsed) return this.showAgents();
				void this.client.startAgent("main", parsed).then(
					async (job) => {
						this.agents = sortAgents([job, ...this.agents.filter((j) => j.id !== job.id)]);
						await this.showAgent(job.id, () => this.showAgents());
					},
					(error: unknown) => {
						const install = error instanceof VosError && error.installUrl ? ` Install: ${error.installUrl}` : "";
						this.note("Cloud agents", `${error instanceof Error ? error.message : String(error)}${install}`);
						setTimeout(() => this.showAgents(), 3000);
					},
				);
			});
		});
	}

	private async showAgent(id: string, back: () => void, log?: string[]): Promise<void> {
		let job: AgentJob;
		try {
			const known = this.agents.find((j) => j.id === id);
			job = await this.client.agent(id, known?.vos);
			this.agents = sortAgents([job, ...this.agents.filter((j) => j.id !== id)]);
		} catch (error) {
			this.fail(error);
			return;
		}
		const muted = (text: string) => new Text(this.theme.fg("muted", text), 1, 0);
		const body: Component[] = [
			muted(`${agentStateLabel(job.state)} · ${job.branch} · ${agentDuration(job)}`),
			new Text(job.task.replace(/\s+/g, " "), 1, 0),
		];
		if (isAgentActive(job.state) && job.step) body.push(muted(job.step));
		if (job.summary) body.push(new Text(job.summary, 1, 0));
		if (job.error) body.push(new Text(this.theme.fg("error", job.error), 1, 0));
		if (job.pr) {
			body.push(
				new Text(
					`PR #${job.pr.number}${job.pr.checks ? ` · ${checksLabel(job.pr.checks)}` : ""}: ${this.theme.fg("accent", job.pr.url)}`,
					1,
					0,
				),
			);
		}
		if (log) {
			body.push(new Spacer(1));
			body.push(...(log.length ? log : ["(empty)"]).map((line) => new Text(this.theme.fg("dim", line), 1, 0)));
		}
		this.list(`${job.repo}`, body, agentActions(job), (action) => void this.agentAct(job, action, back), back);
	}

	private async agentAct(job: AgentJob, action: string, back: () => void): Promise<void> {
		const again = (log?: string[]) => this.showAgent(job.id, back, log);
		try {
			if (action === "log") {
				const { lines } = await this.client.agentLog(job.id, 0, job.vos);
				await again(lines.slice(-14).map((l) => l.text.replace(/\s+/g, " ").slice(0, 200)));
			} else if (action === "message") {
				this.ask("Message the agent", "A follow-up instruction; it reads it between steps.", (text) => {
					if (!text) return void again();
					void this.client.messageAgent(job.id, text, job.vos).then(
						() => again(),
						(error: unknown) => this.fail(error),
					);
				});
			} else if (action === "cancel") {
				await this.client.cancelAgent(job.id, job.vos);
				await again();
			} else if (action === "retry") {
				const next = await this.client.retryAgent(job.id, job.vos);
				this.agents = sortAgents([next, ...this.agents]);
				await this.showAgent(next.id, back);
			} else {
				await again();
			}
		} catch (error) {
			this.fail(error);
		}
	}

	private messageLines(messages: Message[], name: string): Component[] {
		const recent = [...messages].sort((a, b) => a.date.localeCompare(b.date)).slice(-8);
		if (recent.length === 0) return [new Text(this.theme.fg("dim", "No messages yet."), 1, 0)];
		return recent.map((m) => {
			const who = m.role === "you" ? "You" : (m.fromVos?.name ?? name);
			const text = m.text.replace(/\s+/g, " ").trim();
			return new Text(`${this.theme.fg(m.role === "you" ? "muted" : "accent", `${who}:`)} ${text}`, 1, 0);
		});
	}

	private async showThread(dot: string): Promise<void> {
		const group = dot.startsWith("group:") ? this.roster.groups.find((g) => groupDot(g.id) === dot) : undefined;
		const name = group?.name ?? this.nameOf(dot);
		let messages: Message[] = [];
		try {
			messages = await this.client.messages(dot, 8);
		} catch (error) {
			this.fail(error);
			return;
		}
		const actions: SelectItem[] = [{ value: "send", label: "Send a message…" }];
		if (!group) {
			actions.push(
				{ value: "memory", label: "Memory", description: "What it remembers about you" },
				{ value: "code", label: "Start a coding agent…", description: "On its computer, under its rules" },
			);
		}
		actions.push({ value: BACK, label: "Back" });
		this.list(
			name,
			this.messageLines(messages, name),
			actions,
			(action) => {
				if (action === "send") {
					this.ask(`Message ${name}`, "Enter sends; the reply shows here when you come back.", (text) => {
						if (!text) return void this.showThread(dot);
						void this.client.send(dot, text, `smolt-tui-${Date.now()}`).then(
							() => this.showThread(dot),
							(error: unknown) => this.fail(error),
						);
					});
				} else if (action === "memory") {
					void this.showMemory(dot, name);
				} else if (action === "code") {
					this.ask(
						`Coding agent for ${name}`,
						"What should it build or fix? Add `in owner/repo` to name a repository.",
						(task) => {
							if (!task) return void this.showThread(dot);
							const repo = /\bin\s+([\w.-]+\/[\w.-]+)\s*$/.exec(task)?.[1];
							void this.client.startCoding(dot, task, repo).then(
								(started) => {
									this.note(name, `Started: ${started.title || task}. It shows as a task in ${name}'s chat.`);
									setTimeout(() => void this.showThread(dot), 1800);
								},
								(error: unknown) => this.fail(error),
							);
						},
					);
				}
			},
			() => void this.home(),
		);
	}

	private async showMemory(dot: string, name: string): Promise<void> {
		let notes: Awaited<ReturnType<VosClient["memory"]>>;
		try {
			notes = await this.client.memory(dot);
		} catch (error) {
			this.fail(error);
			return;
		}
		const items: SelectItem[] = [
			{ value: "add", label: "Add a note…" },
			...notes.map((n) => ({
				value: n.id,
				label: n.text.replace(/\s+/g, " ").slice(0, 80),
				description: ago(n.updatedAt ?? n.createdAt),
			})),
			{ value: BACK, label: "Back" },
		];
		this.list(
			`${name}'s memory`,
			[],
			items,
			(value) => {
				if (value === "add") {
					this.ask(`Teach ${name} something`, "One fact or preference per note.", (text) => {
						if (!text) return void this.showMemory(dot, name);
						void this.client.addMemory(dot, text).then(
							() => this.showMemory(dot, name),
							(error: unknown) => this.fail(error),
						);
					});
					return;
				}
				const note = notes.find((n) => n.id === value);
				if (!note) return;
				this.list(
					note.text.slice(0, 60),
					[new Text(note.text, 1, 0)],
					[
						{ value: "delete", label: "Forget this" },
						{ value: BACK, label: "Back" },
					],
					() => {
						void this.client.deleteMemory(dot, note.id).then(
							() => this.showMemory(dot, name),
							(error: unknown) => this.fail(error),
						);
					},
					() => void this.showMemory(dot, name),
				);
			},
			() => void this.showThread(dot),
		);
	}

	handleInput(data: string): void {
		if (!this.input && this.keybindings.matches(data, "tui.select.cancel")) {
			this.close();
			return;
		}
		this.input?.handleInput?.(data);
		this.tui.requestRender();
	}

	render(width: number): string[] {
		return this.content
			.render(width)
			.map((line) => (visibleWidth(line) > width ? truncateToWidth(line, width, "") : line));
	}

	invalidate(): void {
		this.content.invalidate();
	}
}

/** Open the panel as an overlay until the user backs out of it. */
export async function showVosPanel(ctx: ExtensionCommandContext, client: VosClient): Promise<void> {
	await ctx.ui.custom<void>(
		(tui, theme, keybindings, done) => {
			const panel = new VosPanel(tui, theme, keybindings, client, () => done());
			void panel.home();
			return panel;
		},
		{ overlay: true },
	);
}
