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
import { groupDot, type VosClient } from "./client.ts";
import { ago, inboxKindLabel, moodLabel, rosterSections, sortInbox } from "./format.ts";
import type { InboxItem, Message, Roster } from "./types.ts";

/**
 * /vos panel: the Vos view's essentials in the terminal, as an overlay.
 *
 * Every screen is a list (the terminal's own select keys move and pick), so
 * nothing here binds a key of its own: the inbox and what to do with an item,
 * each vos's latest messages, sending one, its memory, and starting a coding
 * agent. The live computer and the editors stay in the desktop app.
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

/** The menu rows of the home screen: the inbox, then each vos by section, then groups. */
export function homeItems(roster: Roster, open: number): SelectItem[] {
	const items: SelectItem[] = [
		{ value: "inbox", label: `Inbox${open ? ` (${open} open)` : ""}`, description: "What needs you, across all vos" },
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

/** What can be done with one inbox item from the terminal. */
export function inboxActions(item: InboxItem): SelectItem[] {
	const actions: SelectItem[] = [];
	if (item.ref?.type === "approval" && item.state === "open" && item.kind === "approval") {
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
	actions.push({ value: `vos:${item.vos}`, label: "Open its chat" }, { value: BACK, label: "Back" });
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
			const [roster, inbox] = await Promise.all([
				this.client.roster(),
				this.client.inbox({ state: "open" }).catch(() => [] as InboxItem[]),
			]);
			this.roster = roster;
			this.inbox = sortInbox(inbox);
		} catch (error) {
			this.note("Vos", error instanceof Error ? error.message : String(error));
			return;
		}
		this.list(
			"Vos",
			[],
			homeItems(this.roster, this.inbox.length),
			(value) => {
				if (value === "inbox") this.showInbox();
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
				if (item) this.showItem(item);
			},
			() => void this.home(),
		);
	}

	private showItem(item: InboxItem): void {
		const body = [new Text(this.theme.fg("muted", item.detail ?? inboxKindLabel(item.kind)), 1, 0)];
		this.list(
			`${this.nameOf(item.vos)}: ${item.title}`,
			body,
			inboxActions(item),
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
