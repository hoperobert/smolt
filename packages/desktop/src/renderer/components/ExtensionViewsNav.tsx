import { cn } from "../lib/cn.ts";
import { useApp } from "../state/useApp.ts";
import { openView } from "../state/views.ts";

/**
 * The sidebar's extension views (Vos, and any other extension's), above the
 * chats: one row each, with the badge its extension sets. Picking one gives it
 * the main pane; picking a chat gives the pane back.
 */
export function ExtensionViewsNav() {
	const state = useApp();
	const views = state.views.filter((view) => view.location === "sidebar");
	if (views.length === 0) return null;
	return (
		<nav aria-label="Extensions" className="flex flex-none flex-col gap-px pt-3 pb-1">
			{views.map((view) => {
				const active = state.viewOpen === view.id;
				return (
					<button
						key={view.id}
						type="button"
						data-view-row={view.id}
						onClick={() => openView(view.id)}
						aria-current={active ? "page" : undefined}
						className={cn(
							"flex h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-sm transition-colors",
							active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
						)}
					>
						<span className="flex size-5 flex-none items-center justify-center text-[13px] text-faint" aria-hidden>
							{view.icon ?? view.title.slice(0, 1)}
						</span>
						<span className="min-w-0 flex-1 truncate">{view.title}</span>
						{view.badge !== undefined && (
							<span className="flex h-[18px] min-w-[18px] flex-none items-center justify-center rounded-full bg-primary px-1.5 text-[10.5px] font-semibold tabular-nums text-primary-foreground">
								{typeof view.badge === "number" && view.badge > 99 ? "99+" : view.badge}
							</span>
						)}
					</button>
				);
			})}
		</nav>
	);
}
