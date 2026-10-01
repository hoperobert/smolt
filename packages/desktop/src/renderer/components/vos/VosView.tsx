import { moodLabel } from "../../../../../coding-agent/src/extensions/vos/format.ts";
import type { Group } from "../../../../../coding-agent/src/extensions/vos/types.ts";
import { cn } from "../../lib/cn.ts";
import { requestConfirm, requestInput } from "../../state/app.ts";
import {
	attempt,
	disconnectVos,
	dismissNotice,
	isGroupThread,
	openVos,
	refreshRoster,
	setTab,
	threadOf,
	useVos,
	type VosTab,
	vosCall,
} from "../../state/vos.ts";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "../ui/dropdown-menu.tsx";
import { Icon } from "../ui/icon.tsx";
import { VosAvatar } from "./parts.tsx";
import { VosChat } from "./VosChat.tsx";
import { VosComputers } from "./VosComputers.tsx";
import { VosConnect } from "./VosConnect.tsx";
import { GroupSettings, VosProfile } from "./VosProfile.tsx";
import { VosRoutines } from "./VosRoutines.tsx";
import { VosRules } from "./VosRules.tsx";
import { VosSkills } from "./VosSkills.tsx";
import { VosTeach } from "./VosTeach.tsx";

const VOS_TABS: { value: VosTab; label: string }[] = [
	{ value: "chat", label: "Chat" },
	{ value: "routines", label: "Routines" },
	{ value: "skills", label: "Skills" },
	{ value: "teach", label: "Teach" },
	{ value: "rules", label: "Rules" },
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

function SectionMenu() {
	const v = useVos();
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					aria-label="Vos menu"
					title="Vos menu"
					className="flex size-8 items-center justify-center rounded-lg text-faint transition-colors hover:bg-accent hover:text-foreground"
				>
					⋯
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="min-w-52">
				<DropdownMenuItem
					onSelect={async () => {
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
				</DropdownMenuItem>
				<DropdownMenuItem onSelect={() => openVos(undefined, "profile")}>Add a vos from a link…</DropdownMenuItem>
				<DropdownMenuSeparator />
				<div className="px-2.5 py-1 text-[11.5px] text-faint">
					{v.connection?.url.replace(/^https?:\/\//, "")}
					{v.connection?.keySource === "session" ? " · key kept for this session" : ""}
				</div>
				<DropdownMenuItem
					variant="destructive"
					onSelect={async () => {
						const ok = await requestConfirm({
							title: "Disconnect Vos?",
							message: "smolt forgets the API key. Your vos and their work stay on the server.",
							actionLabel: "Disconnect",
							destructive: true,
						});
						if (ok) await disconnectVos();
					}}
				>
					Disconnect
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/** The main pane while the sidebar's Vos section is open. */
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
	const subtitle = group
		? members.map((m) => m.name).join(", ")
		: [self?.label, status && (status.statusLine || moodLabel(status.mood))].filter(Boolean).join(" · ");

	return (
		<div className="flex min-h-0 flex-1 flex-col" data-vos-view>
			<header className="mx-auto flex w-full max-w-[1000px] flex-wrap items-center gap-x-4 gap-y-2 px-6 pt-1 pb-3">
				<div className="flex min-w-0 flex-1 items-center gap-3">
					{group ? (
						<span className="flex -space-x-2">
							{members.slice(0, 3).map((m) => (
								<VosAvatar
									key={m.id}
									name={m.name}
									look={m.look}
									id={m.id}
									size={30}
									className="rounded-full ring-2 ring-background"
								/>
							))}
						</span>
					) : self ? (
						<VosAvatar name={self.name} look={self.look} id={self.id} size={34} mood={status?.mood} />
					) : null}
					<div className="min-w-0">
						<div className="truncate text-[15px] font-semibold tracking-[-0.01em]">
							{group?.name ?? self?.name ?? "Vos"}
						</div>
						{subtitle && <div className="truncate text-[12.5px] text-muted-foreground">{subtitle}</div>}
					</div>
					{thread?.stream === "error" && (
						<span title={thread.error} className="flex-none rounded-full bg-warn/15 px-2 py-0.5 text-[11px] font-medium text-warn">
							Reconnecting
						</span>
					)}
				</div>
				<nav aria-label="Vos pages" className="flex items-center gap-0.5 rounded-xl border bg-card/60 p-0.5">
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
			</header>
			{v.notice && (
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
			)}
			<div className={cn("flex min-h-0 flex-1 flex-col", tab !== "chat" && "overflow-y-auto")} data-vos-page={tab}>
				{!dot ? (
					<div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
						{v.roster ? "Pick a vos in the sidebar." : "Loading your vos…"}
					</div>
				) : tab === "chat" ? (
					<VosChat dot={dot} />
				) : tab === "routines" && self ? (
					<VosRoutines dot={self.id} name={self.name} />
				) : tab === "skills" ? (
					<VosSkills dot={group ? (group.members[0] ?? null) : (self?.id ?? null)} />
				) : tab === "teach" && self ? (
					<VosTeach dot={self.id} name={self.name} />
				) : tab === "rules" ? (
					<VosRules />
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
