import { isBusy, moodLabel, sortRoster, unreadTotal } from "../../../../../coding-agent/src/extensions/vos/format.ts";
import type { Group, RosterDot } from "../../../../../coding-agent/src/extensions/vos/types.ts";
import { cn } from "../../lib/cn.ts";
import { useApp } from "../../state/useApp.ts";
import { openVos, toggleHiddenOpen, toggleRosterOpen, useVos } from "../../state/vos.ts";
import { Icon } from "../ui/icon.tsx";
import { VosAvatar } from "./parts.tsx";

function Unread({ count }: { count?: number }) {
	if (!count) return null;
	return (
		<span className="flex h-[18px] min-w-[18px] flex-none items-center justify-center rounded-full bg-primary px-1.5 text-[10.5px] font-semibold tabular-nums text-primary-foreground">
			{count > 99 ? "99+" : count}
		</span>
	);
}

function Row({
	active,
	onClick,
	children,
	title,
}: {
	active: boolean;
	onClick: () => void;
	children: React.ReactNode;
	title?: string;
}) {
	return (
		<button
			type="button"
			title={title}
			onClick={onClick}
			className={cn(
				"group/vos flex h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-sm transition-colors",
				active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
			)}
		>
			{children}
		</button>
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
		>
			<VosAvatar
				name={dot.name}
				look={dot.look}
				id={dot.id}
				size={20}
				mood={mood}
				// The mood dot's ring cuts it out of the avatar in the row's own colour, hovered or picked.
				className={
					active
						? "[--vos-avatar-ring:var(--accent)]"
						: "[--vos-avatar-ring:var(--background-deep)] group-hover/vos:[--vos-avatar-ring:color-mix(in_srgb,var(--accent)_60%,var(--background-deep))]"
				}
			/>
			<span className={cn("min-w-0 flex-1 truncate", (dot.unread ?? 0) > 0 && "font-semibold text-foreground")}>
				{dot.name}
				{line && (isBusy(mood) || mood === "needsYou") ? (
					<span
						className={cn("ml-1.5 text-[12px] font-normal", mood === "needsYou" ? "text-warn" : "text-tint-text")}
					>
						{line}
					</span>
				) : (
					dot.label && <span className="ml-1.5 text-[12px] font-normal text-faint">{dot.label}</span>
				)}
			</span>
			<Unread count={dot.unread} />
		</Row>
	);
}

function GroupRow({ group, dots, active }: { group: Group; dots: RosterDot[]; active: boolean }) {
	const members = group.members.map((id) => dots.find((d) => d.id === id)).filter((d): d is RosterDot => !!d);
	return (
		<Row active={active} onClick={() => openVos(`group:${group.id}`)} title={group.name}>
			<span className="relative flex h-5 w-5 flex-none">
				{members.slice(0, 2).map((m, i) => (
					<VosAvatar
						key={m.id}
						name={m.name}
						look={m.look}
						id={m.id}
						size={14}
						className={cn("absolute", i === 0 ? "top-0 left-0" : "right-0 bottom-0 ring-2 ring-background-deep rounded-full")}
					/>
				))}
			</span>
			<span className={cn("min-w-0 flex-1 truncate", (group.unread ?? 0) > 0 && "font-semibold text-foreground")}>
				{group.name}
			</span>
			<Unread count={group.unread} />
		</Row>
	);
}

/**
 * The sidebar's Vos section: the user's AI teammates above their chats.
 * A disclosure, so a long roster folds away; hidden vos fold again under
 * their own.
 */
export function VosSidebar() {
	const state = useApp();
	const v = useVos();
	const connected = v.connection?.connected === true;
	const roster = v.roster;
	const { shown, hidden } = sortRoster(roster?.dots ?? []);
	const unread = roster ? unreadTotal(roster) : 0;
	const isActive = (id: string) => state.vosOpen && v.selected === id;

	return (
		<div className="flex max-h-[45%] min-h-0 flex-none flex-col">
			<div className="flex items-center">
				<button
					type="button"
					onClick={() => (connected ? toggleRosterOpen() : openVos())}
					className="flex min-w-0 flex-1 cursor-pointer select-none items-center gap-2 rounded-lg px-3 pt-4 pb-1 text-xs font-medium tracking-wide text-faint transition-colors hover:text-muted-foreground"
				>
					<span className={cn("flex text-faint transition-transform", v.rosterOpen && connected && "rotate-90")}>
						<Icon name="chevron" />
					</span>
					Vos
					{!v.rosterOpen && unread > 0 && <Unread count={unread} />}
				</button>
				{connected && (
					<button
						type="button"
						title="Open Vos"
						aria-label="Open Vos"
						onClick={() => openVos()}
						className="mr-1 mt-3 flex size-6 items-center justify-center rounded-md text-faint transition-colors hover:bg-accent hover:text-foreground"
					>
						<Icon name="side" className="[&>svg]:size-3.5" />
					</button>
				)}
			</div>
			{!connected ? (
				<Row active={state.vosOpen} onClick={() => openVos()}>
					<span className="flex size-5 flex-none items-center justify-center rounded-full border border-dashed border-faint text-faint">
						<Icon name="plus" className="[&>svg]:size-3" />
					</span>
					<span className="truncate">Connect your vos</span>
				</Row>
			) : (
				v.rosterOpen && (
					<div className="flex min-h-0 flex-col gap-px overflow-y-auto">
						{!roster && !v.rosterError && <p className="px-3 py-1.5 text-[13px] text-faint">Loading…</p>}
						{v.rosterError && !roster && (
							<button
								type="button"
								onClick={() => openVos()}
								className="px-3 py-1.5 text-left text-[13px] text-destructive hover:underline"
							>
								{v.rosterError}
							</button>
						)}
						{shown.map((dot) => (
							<DotRow key={dot.id} dot={dot} active={isActive(dot.id)} />
						))}
						{roster?.groups.map((group) => (
							<GroupRow
								key={group.id}
								group={group}
								dots={roster.dots}
								active={isActive(`group:${group.id}`)}
							/>
						))}
						{hidden.length > 0 && (
							<>
								<button
									type="button"
									onClick={toggleHiddenOpen}
									className="flex h-7 items-center gap-2 rounded-lg px-3 text-left text-xs text-faint transition-colors hover:text-muted-foreground"
								>
									<span className={cn("flex transition-transform", v.hiddenOpen && "rotate-90")}>
										<Icon name="chevron" />
									</span>
									Hidden ({hidden.length})
								</button>
								{v.hiddenOpen &&
									hidden.map((dot) => <DotRow key={dot.id} dot={dot} active={isActive(dot.id)} />)}
							</>
						)}
					</div>
				)
			)}
		</div>
	);
}
