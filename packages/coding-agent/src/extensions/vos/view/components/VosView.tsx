import { isBusy, moodLabel } from "../../format.ts";
import type { Group } from "../../types.ts";
import {
	attempt,
	disconnectVos,
	dismissNotice,
	isGroupThread,
	openVos,
	refreshRoster,
	requestConfirm,
	requestInput,
	setTab,
	startCoding,
	threadOf,
	useVos,
	type VosTab,
	vosCall,
} from "../store.ts";
import { cn, Icon, Menu, MenuItem, MenuSeparator } from "../ui.tsx";
import { VosAvatar } from "./parts.tsx";
import { VosAgents } from "./VosAgents.tsx";
import { revealNeedsYou, VosChat } from "./VosChat.tsx";
import { VosComputers } from "./VosComputers.tsx";
import { VosConnect } from "./VosConnect.tsx";
import { VosConnectors } from "./VosConnectors.tsx";
import { VosInbox } from "./VosInbox.tsx";
import { VosMemory } from "./VosMemory.tsx";
import { GroupSettings, VosProfile } from "./VosProfile.tsx";
import { VosRoster } from "./VosRoster.tsx";
import { VosRoutines } from "./VosRoutines.tsx";
import { VosRules } from "./VosRules.tsx";
import { VosSkills } from "./VosSkills.tsx";
import { VosTeach } from "./VosTeach.tsx";

const VOS_TABS: { value: VosTab; label: string }[] = [
	{ value: "chat", label: "Chat" },
	{ value: "routines", label: "Routines" },
	{ value: "memory", label: "Memory" },
	{ value: "skills", label: "Skills" },
	{ value: "teach", label: "Teach" },
	{ value: "rules", label: "Rules" },
	{ value: "connectors", label: "Connectors" },
	{ value: "computers", label: "Computers" },
	{ value: "profile", label: "Profile" },
];
const GROUP_TABS: { value: VosTab; label: string }[] = [
	{ value: "chat", label: "Chat" },
	{ value: "skills", label: "Skills" },
	{ value: "rules", label: "Rules" },
	{ value: "computers", label: "Computers" },
	{ value: "profile", label: "Group" },
];

/** Ask a vos to start a coding agent: what to do, and optionally which repository. */
export async function askForCodingAgent(dot: string, name: string): Promise<void> {
	const task = await requestInput({
		title: `Start a coding agent for ${name}`,
		message: `It runs Claude Code on ${name}'s computer under ${name}'s rules; anything consequential comes back here as an approval.`,
		placeholder: "Fix the failing checkout test",
		actionLabel: "Next",
		multiline: true,
	});
	if (!task?.trim()) return;
	const repo = await requestInput({
		title: "Which repository?",
		message: "owner/name, an https URL, or leave empty to work without one.",
		placeholder: "acme/site",
		actionLabel: "Start",
	});
	if (repo === null) return;
	if (await startCoding(dot, task.trim(), repo.trim() || undefined)) setTab("chat");
}

function SectionMenu() {
	const v = useVos();
	const self = v.selected && !isGroupThread(v.selected) ? v.roster?.dots.find((d) => d.id === v.selected) : undefined;
	return (
		<Menu label="Vos menu" trigger={<span className="text-[15px] leading-none">⋯</span>}>
			{(close) => (
				<>
					{self && (
						<MenuItem
							onSelect={() => {
								close();
								void askForCodingAgent(self.id, self.name);
							}}
						>
							<Icon name="code" />
							Start a coding agent…
						</MenuItem>
					)}
					<MenuItem
						onSelect={async () => {
							close();
							const name = await requestInput({ title: "New group chat", placeholder: "Launch crew" });
							if (!name?.trim()) return;
							const lead = v.selected && !isGroupThread(v.selected) ? v.selected : "main";
							const group = await attempt(() => vosCall<Group>("POST", "/groups", { name: name.trim(), members: [lead] }));
							if (group) {
								await refreshRoster();
								openVos(`group:${group.id}`, "profile");
							}
						}}
					>
						New group chat…
					</MenuItem>
					<MenuItem
						onSelect={() => {
							close();
							openVos(undefined, "profile");
						}}
					>
						Add a vos from a link…
					</MenuItem>
					<MenuSeparator />
					<div className="px-2.5 py-1 text-[11.5px] leading-snug text-faint">
						{v.connection?.deviceName ? `Connected as ${v.connection.deviceName}` : "Connected with an API key"}
						<br />
						{v.connection?.url.replace(/^https?:\/\//, "")}
						{v.connection?.keySource === "memory" ? " · key kept for this session" : ""}
					</div>
					<MenuItem
						destructive
						onSelect={async () => {
							close();
							const ok = await requestConfirm({
								title: "Disconnect Vos?",
								message: v.connection?.deviceName
									? "smolt forgets this device's key. To revoke the key itself, open the Vos app: Settings › Connected devices."
									: "smolt forgets the API key. Your vos and their work stay on the server.",
								actionLabel: "Disconnect",
								destructive: true,
							});
							if (ok) await disconnectVos();
						}}
					>
						Disconnect
					</MenuItem>
				</>
			)}
		</Menu>
	);
}

function Thread() {
	const v = useVos();
	const dot = v.selected;
	const group = dot && isGroupThread(dot) ? v.roster?.groups.find((g) => `group:${g.id}` === dot) : undefined;
	const self = dot && !group ? v.roster?.dots.find((d) => d.id === dot) : undefined;
	const thread = dot ? threadOf(dot) : null;
	const tabs = group ? GROUP_TABS : VOS_TABS;
	const tab = tabs.some((t) => t.value === v.tab) ? v.tab : "chat";
	const members = group
		? group.members.map((id) => v.roster?.dots.find((d) => d.id === id)).filter((d) => d !== undefined)
		: [];
	const status = thread?.status ?? self?.status;
	const computer = self ? v.computers.get(self.id) : undefined;
	const subtitle = group
		? members.map((m) => m.name).join(", ")
		: [
				self?.label,
				// Busy and needs-you get a chip of their own; idle says nothing.
				status &&
					!isBusy(status.mood) &&
					status.mood !== "needsYou" &&
					status.mood !== "idle" &&
					(status.statusLine || moodLabel(status.mood)),
			]
				.filter(Boolean)
				.join(" · ");

	return (
		<div className="flex min-h-0 min-w-0 flex-1 flex-col" data-vos-view>
			<header className="mx-auto flex w-full max-w-[1000px] flex-wrap items-center gap-x-4 gap-y-2 px-6 pt-3 pb-3">
				<div className="flex min-w-[180px] flex-1 items-center gap-3">
					{group ? (
						<span className="flex -space-x-2">
							{members.slice(0, 3).map((m) => (
								<VosAvatar key={m.id} name={m.name} look={m.look} id={m.id} size={30} className="rounded-full ring-2 ring-background" />
							))}
						</span>
					) : self ? (
						<VosAvatar name={self.name} look={self.look} id={self.id} size={34} mood={status?.mood} />
					) : null}
					<div className="min-w-0">
						<div className="flex min-w-0 items-center gap-2">
							<div className="max-w-[220px] flex-none truncate text-[15px] font-semibold tracking-[-0.01em]">
								{group?.name ?? self?.name ?? "Vos"}
							</div>
							{!group && status && isBusy(status.mood) && (
								<span className="flex min-w-0 max-w-[240px] items-center gap-1.5 rounded-full bg-tint/12 px-2 py-0.5 text-[11.5px] font-medium text-tint-text">
									<span className="size-1.5 flex-none animate-pulse-soft rounded-full bg-tint" />
									<span className="truncate">{status.statusLine || moodLabel(status.mood)}</span>
								</span>
							)}
							{!group && (status?.mood === "needsYou" || computer?.handoffApprovalId) && !computer?.userInControl && (
								<button
									type="button"
									title={computer?.handoffReason ?? status?.statusLine ?? "Show what it's waiting on"}
									onClick={() => {
										if (tab !== "chat") setTab("chat");
										revealNeedsYou();
									}}
									className="flex-none rounded-full bg-warn/15 px-2 py-0.5 text-[11.5px] font-medium text-warn transition-colors hover:bg-warn/25"
								>
									Needs you
								</button>
							)}
							{computer?.userInControl && (
								<span className="flex-none rounded-full bg-destructive/12 px-2 py-0.5 text-[11.5px] font-medium text-destructive">
									You're driving
								</span>
							)}
							{thread?.stream === "error" && (
								<span title={thread.error} className="flex-none rounded-full bg-warn/15 px-2 py-0.5 text-[11.5px] font-medium text-warn">
									Reconnecting
								</span>
							)}
						</div>
						{subtitle && <div className="truncate text-[12.5px] text-muted-foreground">{subtitle}</div>}
					</div>
				</div>
				<div className="flex flex-none items-center gap-1">
				<nav aria-label="Vos pages" className="flex flex-wrap items-center gap-0.5 rounded-xl border bg-card/60 p-0.5">
					{tabs.map((t) => (
						<button
							key={t.value}
							type="button"
							aria-current={tab === t.value ? "page" : undefined}
							onClick={() => setTab(t.value)}
							className={cn(
								"rounded-lg px-2.5 py-1 text-[12.5px] font-medium transition-colors",
								tab === t.value ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
							)}
						>
							{t.label}
						</button>
					))}
				</nav>
				<SectionMenu />
				</div>
			</header>
			<Notice />
			<div className={cn("flex min-h-0 flex-1 flex-col", tab !== "chat" && "overflow-y-auto")} data-vos-page={tab}>
				{!dot ? (
					<div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
						{v.roster ? "Pick a vos on the left." : "Loading your vos…"}
					</div>
				) : tab === "chat" ? (
					<VosChat dot={dot} />
				) : tab === "routines" && self ? (
					<VosRoutines dot={self.id} name={self.name} />
				) : tab === "memory" && self ? (
					<VosMemory dot={self.id} name={self.name} />
				) : tab === "skills" ? (
					<VosSkills dot={group ? (group.members[0] ?? null) : (self?.id ?? null)} />
				) : tab === "teach" && self ? (
					<VosTeach dot={self.id} name={self.name} />
				) : tab === "rules" ? (
					<VosRules />
				) : tab === "connectors" && self ? (
					<VosConnectors dot={self.id} name={self.name} />
				) : tab === "computers" ? (
					<VosComputers />
				) : tab === "profile" && group ? (
					<GroupSettings group={group} />
				) : tab === "profile" && self ? (
					<VosProfile dot={self} />
				) : null}
			</div>
		</div>
	);
}

function Notice() {
	const v = useVos();
	if (!v.notice) return null;
	return (
		<div className="mx-auto mb-2 flex w-full max-w-[760px] items-start gap-2 px-6">
			<div
				role="alert"
				className="flex flex-1 items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-[13px] text-destructive"
			>
				<span className="flex-1">{v.notice}</span>
				<button type="button" aria-label="Dismiss" onClick={dismissNotice} className="opacity-70 hover:opacity-100">
					<Icon name="close" className="[&>svg]:size-3.5" />
				</button>
			</div>
		</div>
	);
}

/** The whole view: the roster on the left, the inbox or a thread on the right. */
export function VosView() {
	const v = useVos();
	if (!v.connection) return <div className="flex-1" />;
	if (!v.connection.connected) {
		return (
			<div className="flex min-h-0 flex-1 flex-col">
				<VosConnect />
			</div>
		);
	}
	return (
		<div className="flex min-h-0 flex-1">
			<VosRoster />
			{v.page === "inbox" ? (
				<div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
					<Notice />
					<VosInbox />
				</div>
			) : v.page === "agents" ? (
				<div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto" data-vos-page="agents">
					<Notice />
					<VosAgents />
				</div>
			) : (
				<Thread />
			)}
		</div>
	);
}
