import { useEffect, useState } from "react";
import { moodLabel } from "../../format.ts";
import { loadScreens, openVos, takeover, useVos } from "../store.ts";
import { Button } from "../ui.tsx";
import { LiveScreen, screenImage } from "./LiveScreen.tsx";
import { Empty, PageHeader, VosAvatar } from "./parts.tsx";

/** Every vos at a computer right now, each with a small live picture; one opens large. */
export function VosComputers() {
	const v = useVos();
	const [focus, setFocus] = useState<string | null>(null);

	useEffect(() => {
		void loadScreens();
		const timer = setInterval(() => {
			if (document.visibilityState === "visible") void loadScreens();
		}, 1500);
		return () => clearInterval(timer);
	}, []);

	const screens = v.screens ?? [];
	const focused = focus ? screens.find((s) => s.id === focus) : undefined;
	return (
		<div className="mx-auto w-full max-w-[1000px] px-6 pt-2 pb-10">
			<PageHeader title="Computers" detail="Your vos at their computers, right now." />
			{focused && (
				<div className="mb-6">
					<div className="mb-2 flex items-center gap-2">
						<VosAvatar name={focused.name} look={focused.look} id={focused.id} size={22} mood={focused.status.mood} />
						<span className="text-[14px] font-medium">{focused.name}</span>
						<span className="text-[13px] text-muted-foreground">{focused.status.statusLine || moodLabel(focused.status.mood)}</span>
						<span className="flex-1" />
						<Button size="xs" variant="ghost" onClick={() => openVos(focused.id, "chat")}>
							Open chat
						</Button>
						<Button size="xs" variant="outline" onClick={() => void takeover(focused.id, !focused.userInControl)}>
							{focused.userInControl ? "Hand back" : "Take over"}
						</Button>
						<Button size="xs" variant="ghost" onClick={() => setFocus(null)}>
							Close
						</Button>
					</div>
					<LiveScreen dot={focused.id} interactive={focused.userInControl} className="w-full" />
				</div>
			)}
			{!v.screens && <p className="text-sm text-faint">Loading…</p>}
			{v.screens && screens.length === 0 && <Empty>No vos is at a computer right now.</Empty>}
			<div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4">
				{screens
					.filter((s) => s.id !== focus)
					.map((screen) => {
						const image = screenImage(screen);
						return (
							<button
								key={screen.id}
								type="button"
								onClick={() => setFocus(screen.id)}
								className="group/screen overflow-hidden rounded-xl border bg-card/60 text-left transition-colors hover:border-border-strong"
							>
								<div className="aspect-[16/10] w-full bg-background-deep">
									{image ? (
										<img src={image} alt="" className="size-full object-cover" draggable={false} />
									) : (
										<div className="flex size-full items-center justify-center text-[12px] text-faint">No picture</div>
									)}
								</div>
								<div className="flex items-center gap-2 px-3 py-2.5">
									<VosAvatar name={screen.name} look={screen.look} id={screen.id} size={22} mood={screen.status.mood} />
									<div className="min-w-0 flex-1">
										<div className="truncate text-[13.5px] font-medium">{screen.name}</div>
										<div className="truncate text-[12px] text-muted-foreground">
											{screen.userInControl ? "You're driving" : screen.status.statusLine || moodLabel(screen.status.mood)}
										</div>
									</div>
								</div>
							</button>
						);
					})}
			</div>
		</div>
	);
}
