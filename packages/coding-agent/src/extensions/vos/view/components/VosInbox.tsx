import { ago, inboxKindLabel, sortInbox } from "../../format.ts";
import type { InboxItem } from "../../types.ts";
import { nameOf, openAgents, openVos, setInboxAll, settleInboxItem, takeover, useVos } from "../store.ts";
import { Button, cn, Icon } from "../ui.tsx";
import { Empty, PageHeader, Segmented, VosAvatar } from "./parts.tsx";

const KIND_ICON: Record<InboxItem["kind"], string> = {
	approval: "check",
	secret: "key",
	safety: "info",
	handoff: "hand",
	question: "info",
	finding: "search",
	failed: "close",
	done: "check",
};

const PRIORITY_TONE: Record<InboxItem["priority"], string> = {
	high: "bg-warn/15 text-warn",
	normal: "bg-tint/12 text-tint-text",
	low: "bg-muted text-muted-foreground",
};

/** Go to what the item is about: the chat (where approvals, secrets and questions are answered) or the takeover. */
function jump(item: InboxItem): void {
	if (item.ref?.type === "agent") {
		openAgents(item.ref.id);
		return;
	}
	if (item.kind === "handoff") {
		openVos(item.vos, "chat");
		void takeover(item.vos, true);
		return;
	}
	openVos(item.vos, item.ref?.type === "routine" ? "routines" : "chat");
	// The chat rings what it waits on once it has drawn.
	setTimeout(() => {
		const target = item.ref ? document.querySelector<HTMLElement>(`[data-ref="${item.ref.type}:${item.ref.id}"]`) : null;
		target?.scrollIntoView({ behavior: "smooth", block: "center" });
	}, 600);
}

function Row({ item }: { item: InboxItem }) {
	const v = useVos();
	const dot = v.roster?.dots.find((d) => d.id === item.vos);
	const open = item.state === "open";
	return (
		<div className={cn("flex items-start gap-3 border-b px-4 py-3 last:border-b-0", !open && "opacity-60")}>
			<span className="relative mt-0.5 flex-none">
				<VosAvatar name={dot?.name ?? item.vos} look={dot?.look} id={item.vos} size={28} />
				<span className="absolute -right-1 -bottom-1 flex size-4 items-center justify-center rounded-full border bg-card">
					<Icon name={KIND_ICON[item.kind] ?? "info"} className="[&>svg]:size-2.5" />
				</span>
			</span>
			<button type="button" onClick={() => jump(item)} className="min-w-0 flex-1 text-left">
				<div className="flex items-center gap-2">
					<span className="truncate text-[13.5px] font-medium">{item.title}</span>
					{open && item.priority !== "low" && (
						<span className={cn("flex-none rounded-full px-2 py-0.5 text-[11px] font-medium", PRIORITY_TONE[item.priority])}>
							{item.priority === "high" ? "Needs you" : "Normal"}
						</span>
					)}
				</div>
				{item.detail && <div className="mt-0.5 line-clamp-2 text-[13px] text-muted-foreground">{item.detail}</div>}
				<div className="mt-1 flex flex-wrap gap-x-3 text-[12px] text-faint">
					<span>{nameOf(item.vos)}</span>
					<span>{inboxKindLabel(item.kind)}</span>
					<span>{ago(item.date)}</span>
					{!open && <span className="capitalize">{item.state}</span>}
				</div>
			</button>
			{open && (
				<div className="flex flex-none gap-1">
					<Button size="xs" variant="outline" onClick={() => jump(item)}>
						{item.kind === "handoff" ? "Take over" : "Open"}
					</Button>
					<Button size="xs" variant="ghost" title="Mark done" onClick={() => void settleInboxItem(item, "done")}>
						<Icon name="check" />
					</Button>
					<Button size="xs" variant="ghost" title="Dismiss" onClick={() => void settleInboxItem(item, "dismiss")}>
						<Icon name="close" />
					</Button>
				</div>
			)}
		</div>
	);
}

/** The triage thread across all vos: what needs the user first, then what is worth knowing. */
export function VosInbox() {
	const v = useVos();
	const items = sortInbox(v.inbox ?? []);
	const high = items.filter((i) => i.state === "open" && i.priority === "high");
	const rest = items.filter((i) => !(i.state === "open" && i.priority === "high"));
	return (
		<div className="mx-auto w-full max-w-[820px] px-6 pt-4 pb-10">
			<PageHeader title="Inbox" detail="Everything your vos need from you, and what they found, across all of them.">
				<Segmented<"open" | "all">
					label="Show"
					value={v.inboxAll ? "all" : "open"}
					onChange={(value) => setInboxAll(value === "all")}
					options={[
						{ value: "open", label: "Open" },
						{ value: "all", label: "All" },
					]}
				/>
			</PageHeader>
			{!v.inbox && <p className="text-sm text-faint">Loading…</p>}
			{v.inbox && items.length === 0 && <Empty>Nothing needs you. Your vos will put things here as they come up.</Empty>}
			{high.length > 0 && (
				<section className="mb-5">
					<h3 className="mb-2 px-1 text-[13px] font-semibold text-warn">Needs you ({high.length})</h3>
					<div className="rounded-xl border border-warn/30 bg-warn/[0.04]">
						{high.map((item) => (
							<Row key={item.id} item={item} />
						))}
					</div>
				</section>
			)}
			{rest.length > 0 && (
				<section>
					{high.length > 0 && <h3 className="mb-2 px-1 text-[13px] font-semibold">Everything else</h3>}
					<div className="rounded-xl border bg-card/60">
						{rest.map((item) => (
							<Row key={item.id} item={item} />
						))}
					</div>
				</section>
			)}
		</div>
	);
}
