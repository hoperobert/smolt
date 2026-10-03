import { useState } from "react";
import {
	ago,
	describeTrigger,
	rruleToSchedule,
	type ScheduleFrequency,
	type SimpleSchedule,
	scheduleToRrule,
	WEEK_DAYS,
} from "../../format.ts";
import type { Routine, Trigger, TriggerType } from "../../types.ts";
import { bridge } from "../bridge.ts";
import { attempt, bumpVos, loadRoutines, requestConfirm, useVos, vos, vosCall } from "../store.ts";
import { Button, cn, Icon, Input, Select, Switch, Textarea } from "../ui.tsx";
import { Card, Empty, Field, PageHeader, Segmented } from "./parts.tsx";

const TRIGGERS: { value: TriggerType; label: string }[] = [
	{ value: "schedule", label: "On a schedule" },
	{ value: "email", label: "An email arrives" },
	{ value: "webhook", label: "A webhook is called" },
	{ value: "github", label: "GitHub" },
	{ value: "slack", label: "Slack" },
	{ value: "linear", label: "Linear" },
	{ value: "sentry", label: "Sentry" },
	{ value: "pagerduty", label: "PagerDuty" },
];

const localZone = (): string => {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
	} catch {
		return "UTC";
	}
};

function defaultTrigger(type: TriggerType): Trigger {
	switch (type) {
		case "schedule":
			return { type, rrule: "FREQ=DAILY;BYHOUR=8;BYMINUTE=0", timezone: localZone() };
		case "slack":
			return { type, keyword: "" };
		case "email":
		case "webhook":
		case "github":
			return { type };
		default:
			return { type };
	}
}

/** Write the fields of one trigger type. */
function TriggerFields({ trigger, onChange }: { trigger: Trigger; onChange: (t: Trigger) => void }) {
	if (trigger.type === "schedule") {
		const simple: SimpleSchedule = rruleToSchedule(trigger.rrule) ?? { frequency: "daily", hour: 8, minute: 0, day: "MO" };
		const set = (patch: Partial<SimpleSchedule>) =>
			onChange({ ...trigger, rrule: scheduleToRrule({ ...simple, ...patch }) });
		return (
			<div className="flex flex-col gap-3">
				<Segmented<ScheduleFrequency>
					label="How often"
					value={simple.frequency}
					onChange={(frequency) => set({ frequency })}
					options={[
						{ value: "hourly", label: "Hourly" },
						{ value: "daily", label: "Daily" },
						{ value: "weekdays", label: "Weekdays" },
						{ value: "weekly", label: "Weekly" },
					]}
				/>
				<div className="flex flex-wrap gap-3">
					{simple.frequency === "weekly" && (
						<Field label="Day">
							<Select
								className="w-36"
								label="Day"
								value={simple.day}
								onChange={(day) => set({ day })}
								options={WEEK_DAYS.map((d) => ({
									value: d,
									label: new Date(Date.UTC(2024, 0, 1 + WEEK_DAYS.indexOf(d))).toLocaleDateString(undefined, {
										weekday: "long",
										timeZone: "UTC",
									}),
								}))}
							/>
						</Field>
					)}
					<Field label={simple.frequency === "hourly" ? "Minute past" : "Time"}>
						{simple.frequency === "hourly" ? (
							<Input
								type="number"
								min={0}
								max={59}
								className="w-24"
								value={simple.minute}
								onChange={(e) => set({ minute: Math.min(59, Math.max(0, Number(e.target.value) || 0)) })}
							/>
						) : (
							<Input
								type="time"
								className="w-32"
								value={`${String(simple.hour).padStart(2, "0")}:${String(simple.minute).padStart(2, "0")}`}
								onChange={(e) => {
									const [h, m] = e.target.value.split(":").map(Number);
									set({ hour: h ?? 0, minute: m ?? 0 });
								}}
							/>
						)}
					</Field>
					<Field label="Time zone">
						<Input
							className="w-48"
							value={trigger.timezone}
							onChange={(e) => onChange({ ...trigger, timezone: e.target.value })}
						/>
					</Field>
				</div>
			</div>
		);
	}
	const text = (key: string, label: string, placeholder: string) => (
		<Field label={label}>
			<Input
				value={String((trigger as Record<string, unknown>)[key] ?? "")}
				placeholder={placeholder}
				onChange={(e) => onChange({ ...trigger, [key]: e.target.value || undefined } as Trigger)}
			/>
		</Field>
	);
	switch (trigger.type) {
		case "email":
			return (
				<div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
					{text("from", "From", "anyone")}
					{text("subject", "Subject has", "anything")}
					{text("contains", "Mentions", "anything")}
				</div>
			);
		case "github":
			return (
				<div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
					<Field label="Events">
						<Input
							value={(trigger.events ?? []).join(", ")}
							placeholder="issues, pull_request"
							onChange={(e) =>
								onChange({
									...trigger,
									events: e.target.value
										.split(",")
										.map((x) => x.trim())
										.filter(Boolean),
								})
							}
						/>
					</Field>
					{text("repo", "Repository", "owner/name")}
					{text("contains", "Mentions", "anything")}
				</div>
			);
		case "slack":
			return (
				<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
					<Field label="Keyword">
						<Input value={trigger.keyword} onChange={(e) => onChange({ ...trigger, keyword: e.target.value })} />
					</Field>
					{text("channel", "Channel", "any channel")}
				</div>
			);
		case "webhook":
			return (
				<p className="text-[13px] text-muted-foreground">
					Any service can start it by POSTing to the routine's hook URL, shown once it is saved.
				</p>
			);
		default:
			return <div className="max-w-sm">{text("contains", "Mentions", "anything")}</div>;
	}
}

interface Draft {
	name: string;
	instructions: string;
	skillId: string;
	trigger: Trigger;
	enabled: boolean;
}

function RoutineEditor({
	initial,
	onSave,
	onCancel,
}: {
	initial: Draft;
	onSave: (draft: Draft) => Promise<boolean>;
	onCancel: () => void;
}) {
	const v = useVos();
	const [draft, setDraft] = useState(initial);
	const [busy, setBusy] = useState(false);
	const valid =
		draft.name.trim() !== "" &&
		draft.instructions.trim() !== "" &&
		(draft.trigger.type !== "slack" || draft.trigger.keyword.trim() !== "");
	return (
		<Card className="flex flex-col gap-4">
			<div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_220px]">
				<Field label="Name">
					<Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Morning briefing" />
				</Field>
				<Field label="Skill (optional)">
					<Select
						label="Skill"
						value={draft.skillId || "none"}
						onChange={(skillId) => setDraft({ ...draft, skillId: skillId === "none" ? "" : skillId })}
						options={[
							{ value: "none", label: "No skill" },
							...(v.skills ?? []).map((s) => ({ value: s.id, label: `/${s.slug}` })),
						]}
					/>
				</Field>
			</div>
			<Field label="What to do">
				<Textarea
					rows={3}
					value={draft.instructions}
					onChange={(e) => setDraft({ ...draft, instructions: e.target.value })}
					placeholder="Summarise my calendar and anything due today."
				/>
			</Field>
			<Field label="When">
				<Select<TriggerType>
					className="w-60"
					label="When"
					value={draft.trigger.type}
					onChange={(type) => setDraft({ ...draft, trigger: defaultTrigger(type) })}
					options={TRIGGERS}
				/>
			</Field>
			<TriggerFields trigger={draft.trigger} onChange={(trigger) => setDraft({ ...draft, trigger })} />
			<p className="text-[12.5px] text-faint">{describeTrigger(draft.trigger)}</p>
			<div className="flex items-center justify-end gap-2">
				<Button variant="ghost" size="sm" onClick={onCancel}>
					Cancel
				</Button>
				<Button
					size="sm"
					disabled={!valid || busy}
					onClick={async () => {
						setBusy(true);
						const ok = await onSave(draft);
						setBusy(false);
						if (ok) onCancel();
					}}
				>
					{busy ? "Saving…" : "Save routine"}
				</Button>
			</div>
		</Card>
	);
}

/** The hook URL holds its key: hidden until asked for, copied without being shown. */
function HookUrl({ dot, routine }: { dot: string; routine: Routine }) {
	const [shown, setShown] = useState(false);
	if (!routine.hookUrl) return null;
	const masked = routine.hookUrl.replace(/\/[^/]+$/, "/••••••••");
	return (
		<div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg bg-background/60 px-3 py-2">
			<code className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted-foreground">
				{shown ? routine.hookUrl : masked}
			</code>
			<Button size="xs" variant="ghost" onClick={() => setShown(!shown)}>
				{shown ? "Hide" : "Show"}
			</Button>
			<Button size="xs" variant="ghost" onClick={() => void bridge.copy(routine.hookUrl ?? "").catch(() => {})}>
				Copy
			</Button>
			<Button
				size="xs"
				variant="ghost"
				onClick={async () => {
					const ok = await requestConfirm({
						title: "Make a new hook URL?",
						message: "The old URL stops working at once. Anything posting to it has to be given the new one.",
						actionLabel: "Rotate",
					});
					if (!ok) return;
					const next = await attempt(() =>
						vosCall<Routine>("POST", `/routines/${encodeURIComponent(routine.id)}/rotate`, {}, dot),
					);
					if (next?.id) {
						vos.routines.set(dot, (vos.routines.get(dot) ?? []).map((r) => (r.id === next.id ? next : r)));
						bumpVos();
						setShown(true);
					}
				}}
			>
				Rotate
			</Button>
		</div>
	);
}

const RUN_TONE: Record<string, string> = {
	completed: "text-ok",
	failed: "text-destructive",
	running: "text-tint-text",
	skipped: "text-faint",
};

function RoutineRow({ dot, routine, onEdit }: { dot: string; routine: Routine; onEdit: () => void }) {
	const [history, setHistory] = useState(false);
	const last = routine.runs[0];
	const save = async (patch: Partial<Routine>): Promise<void> => {
		const next = await attempt(() => vosCall<Routine>("PATCH", `/routines/${encodeURIComponent(routine.id)}`, patch, dot));
		if (next) {
			vos.routines.set(dot, (vos.routines.get(dot) ?? []).map((r) => (r.id === next.id ? next : r)));
			bumpVos();
		}
	};
	return (
		<Card className={cn(!routine.enabled && "bg-transparent")}>
			<div className="flex items-start gap-3">
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2">
						<span className={cn("truncate text-[14px] font-medium", !routine.enabled && "text-muted-foreground")}>
							{routine.name}
						</span>
						{routine.pausedReason && (
							<span className="flex-none rounded-full bg-warn/15 px-2 py-0.5 text-[11px] font-medium text-warn">
								Paused itself
							</span>
						)}
					</div>
					<div className="mt-0.5 text-[13px] text-muted-foreground">{describeTrigger(routine.trigger)}</div>
					{routine.pausedReason && <div className="mt-1 text-[12.5px] text-warn">{routine.pausedReason}</div>}
					<div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-faint">
						{routine.enabled && routine.nextRun && (
							<span>Next {new Date(routine.nextRun).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</span>
						)}
						{last && (
							<button type="button" className="hover:text-foreground" onClick={() => setHistory(!history)}>
								Last run <span className={RUN_TONE[last.status]}>{last.status}</span> {ago(last.at)}
								{routine.runs.length > 1 ? ` · ${routine.runs.length} runs` : ""}
							</button>
						)}
					</div>
				</div>
				<Switch
					checked={routine.enabled}
					aria-label={routine.enabled ? "Pause routine" : "Turn routine on"}
					onCheckedChange={(enabled) => void save({ enabled })}
				/>
			</div>
			<HookUrl dot={dot} routine={routine} />
			{history && (
				<ol className="mt-3 flex flex-col gap-1.5 border-t pt-3">
					{routine.runs.map((run) => (
						<li key={run.id} className="flex gap-3 text-[12.5px]">
							<span className="w-24 flex-none text-faint">{ago(run.at)}</span>
							<span className={cn("w-20 flex-none", RUN_TONE[run.status])}>{run.status}</span>
							<span className="min-w-0 flex-1 text-muted-foreground">
								{run.event ? `${run.event} — ` : run.cause !== "schedule" ? `${run.cause} — ` : ""}
								{run.summary ?? ""}
							</span>
						</li>
					))}
				</ol>
			)}
			<div className="mt-3 flex flex-wrap gap-1.5">
				<Button
					size="xs"
					variant="outline"
					onClick={() => void attempt(() => vosCall("POST", `/routines/${encodeURIComponent(routine.id)}/test`, {}, dot))}
				>
					Test
				</Button>
				<Button
					size="xs"
					variant="outline"
					onClick={() => void attempt(() => vosCall("POST", `/routines/${encodeURIComponent(routine.id)}/run`, {}, dot))}
				>
					Run now
				</Button>
				<Button size="xs" variant="ghost" onClick={onEdit}>
					Edit
				</Button>
				<Button
					size="xs"
					variant="ghost"
					className="text-destructive hover:text-destructive"
					onClick={async () => {
						const ok = await requestConfirm({
							title: `Delete "${routine.name}"?`,
							message: "It stops running and its history goes with it.",
							actionLabel: "Delete",
							destructive: true,
						});
						if (!ok) return;
						const done = await attempt(() => vosCall("DELETE", `/routines/${encodeURIComponent(routine.id)}`, undefined, dot));
						if (done !== undefined) {
							vos.routines.set(dot, (vos.routines.get(dot) ?? []).filter((r) => r.id !== routine.id));
							bumpVos();
						}
					}}
				>
					Delete
				</Button>
			</div>
		</Card>
	);
}

/** A vos's routines: what it does on its own, and what starts it. */
export function VosRoutines({ dot, name }: { dot: string; name: string }) {
	const v = useVos();
	const [editing, setEditing] = useState<string | "new" | null>(null);
	const routines = v.routines.get(dot);

	const save = async (draft: Draft, id?: string): Promise<boolean> => {
		const body = {
			name: draft.name.trim(),
			instructions: draft.instructions.trim(),
			trigger: draft.trigger,
			...(draft.skillId ? { skillId: draft.skillId } : {}),
			...(id ? {} : { enabled: true }),
		};
		const result = await attempt(() =>
			id
				? vosCall<Routine>("PATCH", `/routines/${encodeURIComponent(id)}`, body, dot)
				: vosCall<Routine>("POST", "/routines", body, dot),
		);
		if (!result) return false;
		await loadRoutines(dot);
		return true;
	};

	return (
		<div className="mx-auto w-full max-w-[760px] px-6 pt-2 pb-10">
			<PageHeader title="Routines" detail={`What ${name} does on its own: on a schedule, or when something happens.`}>
				{editing !== "new" && (
					<Button size="sm" onClick={() => setEditing("new")}>
						<Icon name="plus" />
						New routine
					</Button>
				)}
			</PageHeader>
			<div className="flex flex-col gap-3">
				{editing === "new" && (
					<RoutineEditor
						initial={{ name: "", instructions: "", skillId: "", trigger: defaultTrigger("schedule"), enabled: true }}
						onSave={(draft) => save(draft)}
						onCancel={() => setEditing(null)}
					/>
				)}
				{!routines && <p className="text-sm text-faint">Loading…</p>}
				{routines?.length === 0 && editing !== "new" && (
					<Empty>No routines yet. A routine runs a job by itself: every morning, or when an email arrives.</Empty>
				)}
				{routines?.map((routine) =>
					editing === routine.id ? (
						<RoutineEditor
							key={routine.id}
							initial={{
								name: routine.name,
								instructions: routine.instructions,
								skillId: routine.skillId ?? "",
								trigger: routine.trigger,
								enabled: routine.enabled,
							}}
							onSave={(draft) => save(draft, routine.id)}
							onCancel={() => setEditing(null)}
						/>
					) : (
						<RoutineRow key={routine.id} dot={dot} routine={routine} onEdit={() => setEditing(routine.id)} />
					),
				)}
			</div>
		</div>
	);
}
