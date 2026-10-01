import { useEffect, useState } from "react";
import { elapsed } from "../../../../../coding-agent/src/extensions/vos/format.ts";
import type { Skill } from "../../../../../coding-agent/src/extensions/vos/types.ts";
import {
	attempt,
	bumpVos,
	cancelTeach,
	clearTeach,
	setTab,
	startTeach,
	stopTeach,
	useVos,
	vos,
	vosCall,
} from "../../state/vos.ts";
import { Button } from "../ui/button.tsx";
import { Icon } from "../ui/icon.tsx";
import { Input } from "../ui/input.tsx";
import { LiveScreen } from "./LiveScreen.tsx";
import { Card, PageHeader } from "./parts.tsx";

const LIMIT_MS = 10 * 60_000;

function DraftSkill({ skill, dot }: { skill: Skill; dot: string }) {
	return (
		<Card>
			<div className="flex items-center gap-2">
				<span className="font-mono text-[14px] font-medium">/{skill.slug}</span>
				{skill.draft && (
					<span className="rounded-full bg-warn/15 px-2 py-0.5 text-[11px] font-medium text-warn">Draft</span>
				)}
			</div>
			<p className="mt-1 text-[13px] text-muted-foreground">{skill.description}</p>
			<ol className="mt-3 ml-5 list-decimal text-[13px] leading-relaxed marker:text-faint">
				{skill.steps.map((step, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: steps are plain text in order
					<li key={i}>{step}</li>
				))}
			</ol>
			<div className="mt-4 flex flex-wrap gap-2">
				<Button
					size="sm"
					onClick={async () => {
						const ok = await attempt(() => vosCall("POST", `/skills/${encodeURIComponent(skill.id)}/test`, {}, dot));
						if (ok !== undefined) setTab("chat");
					}}
				>
					Test it
				</Button>
				{skill.draft && (
					<Button
						size="sm"
						variant="outline"
						onClick={async () => {
							const next = await attempt(() =>
								vosCall<Skill>("PATCH", `/skills/${encodeURIComponent(skill.id)}`, { draft: false }),
							);
							if (next && vos.skills) {
								vos.skills = vos.skills.map((s) => (s.id === next.id ? next : s));
								bumpVos();
							}
						}}
					>
						Keep
					</Button>
				)}
				<Button
					size="sm"
					variant="ghost"
					className="text-destructive hover:text-destructive"
					onClick={async () => {
						const done = await attempt(() => vosCall("DELETE", `/skills/${encodeURIComponent(skill.id)}`));
						if (done !== undefined) {
							if (vos.skills) vos.skills = vos.skills.filter((s) => s.id !== skill.id);
							clearTeach();
						}
					}}
				>
					Discard
				</Button>
			</div>
		</Card>
	);
}

/**
 * Teach a task: the user does it once on the vos's computer while it watches,
 * then the vos writes it up as a draft skill. What is typed is never
 * recorded, only that something was.
 */
export function VosTeach({ dot, name }: { dot: string; name: string }) {
	const v = useVos();
	const [goal, setGoal] = useState("");
	const [now, setNow] = useState(() => Date.now());
	const teach = v.teach && v.teach.dot === dot ? v.teach : null;
	const recording = teach?.state === "recording";

	useEffect(() => {
		if (!recording) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [recording]);

	if (!teach || teach.state === "cancelled") {
		return (
			<div className="mx-auto w-full max-w-[760px] px-6 pt-2 pb-10">
				<PageHeader
					title="Teach a task"
					detail={`Do it once on ${name}'s computer while it watches; it writes up what you did as a skill.`}
				/>
				<Card className="flex flex-col gap-4">
					<form
						className="flex flex-col gap-3 sm:flex-row"
						onSubmit={(event) => {
							event.preventDefault();
							if (goal.trim()) void startTeach(dot, goal.trim());
						}}
					>
						<Input
							value={goal}
							onChange={(e) => setGoal(e.target.value)}
							placeholder="What are you showing it? e.g. Submit an expense claim"
							className="flex-1"
						/>
						<Button type="submit" disabled={!goal.trim()}>
							Start teaching
						</Button>
					</form>
					<ul className="flex flex-col gap-1.5 text-[12.5px] text-muted-foreground">
						<li className="flex gap-2">
							<Icon name="check" className="text-ok [&>svg]:size-3.5" />
							Clicks, scrolls and keys are recorded, with a screenshot after each click.
						</li>
						<li className="flex gap-2">
							<Icon name="key" className="text-warn [&>svg]:size-3.5" />
							What you type is never recorded, only that you typed something.
						</li>
						<li className="flex gap-2">
							<Icon name="info" className="text-faint [&>svg]:size-3.5" />
							Recording stops by itself after 10 minutes.
						</li>
					</ul>
				</Card>
			</div>
		);
	}

	const skill = teach.skillId ? v.skills?.find((s) => s.id === teach.skillId) : undefined;
	const used = Date.now() - Date.parse(teach.startedAt);
	return (
		<div className="mx-auto w-full max-w-[900px] px-6 pt-2 pb-10">
			<PageHeader title={teach.goal} detail={recording ? "Do the task on the screen below. Click it to drive." : undefined}>
				{recording && (
					<>
						<span className="flex items-center gap-2 rounded-full bg-destructive/12 px-2.5 py-1 font-mono text-[12px] tabular-nums text-destructive">
							<span className="size-1.5 animate-pulse-soft rounded-full bg-destructive" />
							{elapsed(teach.startedAt, now)} / 10:00
						</span>
						<Button size="sm" variant="ghost" onClick={() => void cancelTeach()}>
							Cancel
						</Button>
						<Button size="sm" onClick={() => void stopTeach()}>
							<Icon name="stop" />
							Stop and write it up
						</Button>
					</>
				)}
			</PageHeader>
			{teach.error && <p className="mb-3 text-[13px] text-destructive">{teach.error}</p>}
			{recording && (
				<>
					<LiveScreen dot={dot} interactive className="w-full" />
					<div className="mt-3 flex items-center justify-between text-[12.5px] text-muted-foreground">
						<span>
							{teach.steps} {teach.steps === 1 ? "step" : "steps"} recorded
						</span>
						<div className="h-1 w-48 overflow-hidden rounded-full bg-muted">
							<div className="h-full bg-destructive/70" style={{ width: `${Math.min(100, (used / LIMIT_MS) * 100)}%` }} />
						</div>
					</div>
				</>
			)}
			{teach.state === "drafting" && (
				<Card className="flex items-center gap-3">
					<Icon name="spinner" className="animate-spin text-tint" />
					<span className="text-[13.5px]">{name} is writing up what you showed it…</span>
				</Card>
			)}
			{teach.state === "done" && (
				<div className="flex flex-col gap-3">
					{skill ? (
						<DraftSkill skill={skill} dot={dot} />
					) : (
						<Card className="text-[13.5px] text-muted-foreground">The draft skill is ready. It is in Skills.</Card>
					)}
					<div>
						<Button size="sm" variant="ghost" onClick={clearTeach}>
							Teach another
						</Button>
					</div>
				</div>
			)}
		</div>
	);
}
