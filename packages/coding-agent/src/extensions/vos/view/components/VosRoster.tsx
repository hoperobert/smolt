import type { ReactNode } from "react";
import { isAgentActive } from "../../agents.ts";
import { isBusy, moodLabel, rosterSections, sectionNames, sortRoster } from "../../format.ts";
import type { Dot, Group, RosterDot } from "../../types.ts";
import {
	attempt,
	openAgents,
	openInbox,
	openVos,
	refreshRoster,
	requestInput,
	toggleHiddenOpen,
	useVos,
	vosCall,
} from "../store.ts";
import { cn, Icon, Menu, MenuItem, MenuSeparator } from "../ui.tsx";
import { VosAvatar } from "./parts.tsx";

function Count({ count, tone = "primary" }: { count?: number; tone?: "primary" | "warn" }) {
	if (!count) return null;
	return (
		<span
			className={cn(
				"flex h-[18px] min-w-[18px] flex-none items-center justify-center rounded-full px-1.5 text-[10.5px] font-semibold tabular-nums",
				tone === "warn" ? "bg-warn text-background" : "bg-primary text-primary-foreground",
			)}
		>
			{count > 99 ? "99+" : count}
		</span>
	);
}

function Row({
	active,
	onClick,
	children,
	title,
	menu,
}: {
	active: boolean;
	onClick: () => void;
	children: ReactNode;
	title?: string;
	menu?: ReactNode;
}) {
	return (
		<div
			className={cn(
				"group/vos relative flex h-8 w-full min-w-0 items-center rounded-lg text-sm transition-colors",
				active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
			)}
		>
			<button type="button" title={title} onClick={onClick} className="flex h-full min-w-0 flex-1 items-center gap-2 px-2 text-left">
				{children}
			</button>
			{menu && <div className="absolute right-0.5 opacity-0 transition-opacity group-hover/vos:opacity-100 focus-within:opacity-100">{menu}</div>}
		</div>
	);
}

/** Pin, hide, file under a section, or duplicate a vos, from its roster row. */
function DotMenu({ dot }: { dot: RosterDot }) {
	const v = useVos();
	const patch = async (body: Record<string, unknown>): Promise<void> => {
		const next = await attempt(() => vosCall<Dot>("PATCH", `/dots/${encodeURIComponent(dot.id)}`, body));
		if (next) await refreshRoster();
	};
	const sections = sectionNames(v.roster?.dots ?? []).filter((s) => s !== dot.section);
	return (
		<Menu label={`${dot.name} options`} trigger={<span className="text-[15px] leading-none">⋯</span>}>
			{(close) => (
				<>
					<MenuItem
						onSelect={() => {
							close();
							void patch({ pinned: !dot.pinned });
						}}
					>
						<Icon name="pin" />
						{dot.pinned ? "Unpin" : "Pin to the top"}
					</MenuItem>
					<MenuItem
						onSelect={() => {
							close();
							void patch({ hidden: !dot.hidden });
						}}
					>
						<Icon name="hide" />
						{dot.hidden ? "Show in the roster" : "Hide (routines keep running)"}
					</MenuItem>
					<MenuSeparator />
					{sections.map((name) => (
						<MenuItem
							key={name}
							onSelect={() => {
								close();
								void patch({ section: name });
							}}
						>
							Move to {name}
						</MenuItem>
					))}
					<MenuItem
						onSelect={async () => {
							close();
							const name = await requestInput({ title: `Section for ${dot.name}`, placeholder: "Client: Acme", initial: dot.section ?? "" });
							if (name !== null) await patch({ section: name.trim() || null });
						}}
					>
						{dot.section ? "Rename or clear section…" : "New section…"}
					</MenuItem>
					<MenuSeparator />
					<MenuItem
						onSelect={async () => {
							close();
							const name = await requestInput({ title: `Duplicate ${dot.name}`, initial: `${dot.name} 2`, message: "Copies its profile, rules, routines and look; not its memory or chats." });
							if (name === null) return;
							const copy = await attempt(() =>
								vosCall<Dot>("POST", `/dots/${encodeURIComponent(dot.id)}/duplicate`, { name: name.trim() || undefined }),
							);
							if (copy) {
								await refreshRoster();
								openVos(copy.id, "profile");
							}
						}}
					>
						Duplicate…
					</MenuItem>
				</>
			)}
		</Menu>
	);
}

function DotRow({ dot, active }: { dot: RosterDot; active: boolean }) {
	const mood = dot.status?.mood;
	const line = dot.status?.statusLine || (mood && mood !== "idle" ? moodLabel(mood) : "");
	return (
		<Row
			active={active}
			onClick={() => openVos(dot.id)}
			title={`${dot.name}${dot.label ? ` · ${dot.label}` : ""}${line ? ` · ${line}` : ""}`}
			menu={<DotMenu dot={dot} />}
		>
			<VosAvatar
				name={dot.name}
				look={dot.look}
				id={dot.id}
				size={20}
				mood={mood}
				className={active ? "[--vos-avatar-ring:var(--accent)]" : "[--vos-avatar-ring:var(--background-deep)]"}
			/>
			<span className={cn("min-w-0 flex-1 truncate", (dot.unread ?? 0) > 0 && "font-semibold text-foreground")}>
				{dot.name}
				{line && (isBusy(mood) || mood === "needsYou") ? (
					<span className={cn("ml-1.5 text-[12px] font-normal", mood === "needsYou" ? "text-warn" : "text-tint-text")}>
						{line}
					</span>
				) : (
					dot.label && <span className="ml-1.5 text-[12px] font-normal text-faint">{dot.label}</span>
				)}
			</span>
			<span className="group-hover/vos:invisible">
				<Count count={dot.unread} />
			</span>
		</Row>
	);
}

function GroupRow({ group, dots, active }: { group: Group; dots: RosterDot[]; active: boolean }) {
	const members = group.members.map((id) => dots.find((d) => d.id === id)).filter((d): d is RosterDot => !!d);
	return (
		<Row active={active} onClick={() => openVos(`group:${group.id}`)} title={`${group.name}: ${members.map((m) => m.name).join(", ")}`}>
			<span className="relative flex h-5 w-5 flex-none">
				{members.slice(0, 2).map((m, i) => (
					<VosAvatar
						key={m.id}
						name={m.name}
						look={m.look}
						id={m.id}
						size={14}
						className={cn("absolute", i === 0 ? "top-0 left-0" : "right-0 bottom-0 rounded-full ring-2 ring-background-deep")}
					/>
				))}
			</span>
			<span className={cn("min-w-0 flex-1 truncate", (group.unread ?? 0) > 0 && "font-semibold text-foreground")}>{group.name}</span>
			<Count count={group.unread} />
		</Row>
	);
}

function Heading({ children }: { children: ReactNode }) {
	return <div className="px-2 pt-3 pb-1 text-[11.5px] font-medium tracking-wide text-faint">{children}</div>;
}

/**
 * The view's roster: the inbox first, then the user's vos (pinned, then by
 * section), group chats, and hidden vos folded away.
 */
export function VosRoster() {
	const v = useVos();
	const roster = v.roster;
	const { hidden } = sortRoster(roster?.dots ?? []);
	const sections = rosterSections(roster?.dots ?? []);
	const isActive = (id: string) => v.page === "thread" && v.selected === id;
	const open = v.inboxCount?.open ?? v.inbox?.filter((i) => i.state === "open").length ?? 0;
	const running = v.agents?.filter((j) => isAgentActive(j.state)).length ?? 0;
	return (
		<nav
			aria-label="Your vos"
			className="flex w-[232px] flex-none flex-col gap-px overflow-y-auto border-r bg-background-deep px-2 py-3"
		>
			<Row active={v.page === "inbox"} onClick={openInbox} title="Everything that needs you">
				<span className="flex size-5 flex-none items-center justify-center text-faint">
					<Icon name="inbox" />
				</span>
				<span className={cn("min-w-0 flex-1 truncate", open > 0 && "font-semibold text-foreground")}>Inbox</span>
				<Count count={open} tone={(v.inboxCount?.high ?? 0) > 0 ? "warn" : "primary"} />
			</Row>
			<Row active={v.page === "agents"} onClick={() => openAgents(null)} title="Coding jobs in their own VMs, ending in PRs">
				<span className="flex size-5 flex-none items-center justify-center text-faint">
					<Icon name="cloud" />
				</span>
				<span className="min-w-0 flex-1 truncate">Cloud agents</span>
				{running > 0 && <span className="text-[11.5px] tabular-nums text-tint-text">{running} running</span>}
			</Row>
			{!roster && !v.rosterError && <p className="px-3 py-1.5 text-[13px] text-faint">Loading…</p>}
			{v.rosterError && !roster && <p className="px-3 py-1.5 text-[13px] text-destructive">{v.rosterError}</p>}
			{sections.map((section) => (
				<div key={section.name ?? "-"} className="flex flex-col gap-px">
					<Heading>{section.name ?? "Your vos"}</Heading>
					{section.dots.map((dot) => (
						<DotRow key={dot.id} dot={dot} active={isActive(dot.id)} />
					))}
				</div>
			))}
			{roster && roster.groups.length > 0 && (
				<>
					<Heading>Group chats</Heading>
					{roster.groups.map((group) => (
						<GroupRow key={group.id} group={group} dots={roster.dots} active={isActive(`group:${group.id}`)} />
					))}
				</>
			)}
			{hidden.length > 0 && (
				<>
					<button
						type="button"
						onClick={toggleHiddenOpen}
						className="mt-2 flex h-7 items-center gap-2 rounded-lg px-2 text-left text-xs text-faint transition-colors hover:text-muted-foreground"
					>
						<span className={cn("flex transition-transform", v.hiddenOpen && "rotate-90")}>
							<Icon name="chevron" />
						</span>
						Hidden ({hidden.length})
					</button>
					{v.hiddenOpen && hidden.map((dot) => <DotRow key={dot.id} dot={dot} active={isActive(dot.id)} />)}
				</>
			)}
		</nav>
	);
}
