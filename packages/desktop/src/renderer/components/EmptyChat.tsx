import type { CSSProperties, ReactNode } from "react";
import { useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import { cn } from "../lib/cn.ts";
import { compactNumber, relativeTime } from "../lib/format.ts";
import { applyStarter, projectName, type Starter, switchToSession } from "../state/app.ts";
import { useApp } from "../state/useApp.ts";
import { Tip } from "./ui/tooltip.tsx";

/**
 * The new-chat page: the typefish, a greeting, the composer pulled up into
 * the middle of the page (its folder chip attached), and under it a few
 * quiet ways in: suggested starts and the last three chats.
 *
 * The page is laid out from the top rather than centred, so nothing above
 * the composer moves when the things below it (starters, recents) arrive.
 * While the local loads are in flight the same layout stands as a skeleton:
 * the mark breathes, the greeting and rows are soft bars, and the composer is
 * already in its final place; the loaded content fades in over it.
 */

function greeting(): string {
	const hour = new Date().getHours();
	if (hour < 5) return "Still going";
	if (hour < 12) return "Morning";
	if (hour < 18) return "Afternoon";
	return "Evening";
}

/** The typefish ><>, the brand's mark: it swims a little while idle, and breathes while the page loads. */
function Mark({ loading }: { loading: boolean }) {
	return (
		<span
			aria-hidden
			className={cn(
				"select-none font-mono text-[46px] leading-[52px] font-bold tracking-[-0.08em] text-salmon",
				loading ? "animate-pulse-soft" : "newchat-swim",
			)}
		>
			&gt;&lt;&gt;
		</span>
	);
}

const Bar = ({ className, style }: { className?: string; style?: CSSProperties }) => (
	<span className={cn("block animate-pulse-soft rounded-full bg-muted-foreground/15", className)} style={style} />
);

function Starters({ ready }: { ready: boolean }) {
	const state = useApp();
	const starters: Starter[] = state.starters.slice(0, 3);
	// A warm cache lands within a few frames; only a slow model call shows placeholders.
	const [slow, setSlow] = useState(false);
	useEffect(() => {
		const timer = setTimeout(() => setSlow(true), 400);
		return () => clearTimeout(timer);
	}, []);
	const waiting = !ready || (!state.startersLoaded && starters.length === 0);
	// Nothing to suggest: no row at all, rather than a gap under the composer.
	if (!waiting && starters.length === 0) return null;
	// Starters usually land with the page; only a slow model call earns placeholders.
	if (waiting && !slow) return null;
	return (
		// A fixed-height row: chips arriving (or not) never move what is below.
		<div className="flex min-h-[34px] flex-wrap justify-center gap-2" aria-hidden={waiting || undefined}>
			{waiting
				? slow &&
					[132, 168, 112].map((w) => (
						<span key={w} className="flex h-[30px] items-center rounded-full border px-3" style={{ width: w }}>
							<Bar className="h-[7px] w-full" />
						</span>
					))
				: starters.map((starter) => (
						<Tip key={starter.label} label={starter.meta || starter.label}>
							<button
								type="button"
								onClick={() => applyStarter(starter.label)}
								className="newchat-in h-[30px] max-w-[260px] overflow-hidden text-ellipsis whitespace-nowrap rounded-full border bg-background px-3 text-[12.5px] text-muted-foreground transition-colors hover:border-border-strong hover:bg-accent/60 hover:text-foreground"
							>
								{starter.label}
							</button>
						</Tip>
					))}
		</div>
	);
}

/** The way back into recent work: three quiet rows. */
function Recents({ ready }: { ready: boolean }) {
	const state = useApp();
	const rows = [...state.sessionRows].sort((a, b) => b.lastActive - a.lastActive).slice(0, 3);
	// Sidebar titles are cut short; here there is room for the opening sentence.
	const label = (row: { title: string; preview: string }): string => {
		if (!row.title.endsWith("…") || row.preview === "") return row.title;
		const sentence = (row.preview.split(/(?<=[.!?])\s/)[0] ?? row.preview).replace(/\s+/g, " ").trim();
		if (sentence.length <= 96) return sentence;
		const cut = sentence.slice(0, 96);
		const lastSpace = cut.lastIndexOf(" ");
		return `${(lastSpace > 48 ? cut.slice(0, lastSpace) : cut).replace(/[,;:.]$/, "")}…`;
	};
	if (!ready) {
		return (
			<div className="w-full" aria-hidden>
				<div className="mb-1.5 flex h-[18px] items-center px-3">
					<Bar className="h-[7px] w-[52px]" />
				</div>
				{[64, 52, 44].map((w) => (
					<div key={w} className="flex h-9 items-center gap-3 px-3">
						<Bar className="h-[8px]" style={{ width: `${w}%` }} />
						<span className="flex-1" />
						<Bar className="h-[7px] w-[44px]" />
					</div>
				))}
			</div>
		);
	}
	if (rows.length === 0) return null;
	return (
		<div className="newchat-in w-full">
			<h2 className="mb-1.5 flex h-[18px] items-center px-3 text-[11.5px] font-medium tracking-wide text-faint">
				Recent
			</h2>
			{rows.map((row) => (
				<Tip key={row.path} label={row.preview || row.title}>
					<button
						type="button"
						className="group/recent flex h-9 w-full items-center gap-3 rounded-lg px-3 text-left text-[13.5px] transition-colors hover:bg-accent/70"
						onClick={() => void switchToSession(row.path)}
					>
						<span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-muted-foreground group-hover/recent:text-foreground">
							{label(row)}
						</span>
						<span className="flex-none text-[12px] text-faint tabular-nums">{relativeTime(row.lastActive)}</span>
					</button>
				</Tip>
			))}
		</div>
	);
}

/** One faint line of what this agent knows and has done here, instead of a card. */
function Knowledge() {
	const state = useApp();
	const learned = state.stats?.learned;
	const stats = state.stats;
	if (!learned || !stats) return null;
	const folder = projectName();
	const bits: ReactNode[] = [];
	if (learned.memoryEntries > 0) {
		bits.push(
			<Tip key="notes" label="What the agent wrote down for itself in MEMORY.md. Click to open it.">
				<button
					type="button"
					className="underline-offset-2 hover:text-foreground hover:underline"
					onClick={() => void api.reveal(learned.memoryPath)}
				>
					{learned.memoryEntries} {learned.memoryEntries === 1 ? "note" : "notes"}
				</button>
			</Tip>,
		);
	}
	if (learned.skills.length > 0) {
		bits.push(
			<span key="skills">
				{learned.skills.length} {learned.skills.length === 1 ? "skill" : "skills"}
			</span>,
		);
	}
	if (stats.sessions > 0) {
		bits.push(
			<span key="sessions">
				{stats.sessions} {stats.sessions === 1 ? "chat" : "chats"}
				{state.appInfo.hasProject && folder !== "" ? ` in ${folder}` : ""}
			</span>,
		);
	}
	if (stats.tokens > 0) bits.push(<span key="tokens">{compactNumber(stats.tokens)} tokens</span>);
	if (bits.length === 0) return null;
	return (
		<p className="newchat-in flex flex-wrap items-center justify-center gap-x-2 text-[11.5px] text-faint">
			{bits.map((bit, i) => (
				<span key={String(i)} className="flex items-center gap-2">
					{i > 0 && <span aria-hidden>·</span>}
					{bit}
				</span>
			))}
		</p>
	);
}

/** The whole new-chat page, with the composer passed in so it sits in the middle. */
export function NewChatPage({ children }: { children: ReactNode }) {
	const state = useApp();
	const folder = projectName();
	const inProject = state.appInfo.hasProject && folder !== "";
	const ready = state.statsLoaded && state.sessionsLoaded && state.appInfoLoaded;
	return (
		<div className="min-h-0 flex-1 overflow-y-auto">
			<div className="mx-auto flex min-h-full w-full max-w-[804px] flex-col items-center pt-[max(40px,15vh)] pb-10 @max-[550px]:pt-8">
				<div className="flex flex-col items-center px-8 text-center">
					<Mark loading={!ready} />
					<div className="mt-3 flex h-[34px] items-center">
						{ready ? (
							<h1 className="newchat-in text-balance text-[24px] leading-[34px] font-semibold tracking-[-0.022em]">
								{greeting()}
								{inProject ? `, what's next in ${folder}?` : ", what shall we work on?"}
							</h1>
						) : (
							<Bar className="h-[14px] w-[300px]" />
						)}
					</div>
					<p className="mt-1 flex h-[20px] items-center text-[13px] text-faint">
						{ready && !inProject && (
							<span className="newchat-in">No project folder yet: ask anything, or pick one below.</span>
						)}
					</p>
				</div>
				{/* In its final place from the first frame, and quiet until the page has loaded. */}
				<div
					aria-busy={!ready || undefined}
					className={cn("mt-7 w-full transition-opacity duration-300", !ready && "pointer-events-none opacity-60")}
				>
					{children}
				</div>
				<div className="mt-3 flex w-full max-w-[740px] flex-col items-center gap-6 px-8">
					<Starters ready={ready} />
					<Recents ready={ready} />
					{ready && <Knowledge />}
				</div>
			</div>
		</div>
	);
}
