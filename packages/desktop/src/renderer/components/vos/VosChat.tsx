import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
	elapsed,
	filterMembers,
	filterSkills,
	insertMention,
	isBusy,
	mentionQuery,
	moodLabel,
	slashQuery,
} from "../../../../../coding-agent/src/extensions/vos/format.ts";
import type {
	Approval,
	Message,
	RosterDot,
	SecretRequest,
	Skill,
	Task,
} from "../../../../../coding-agent/src/extensions/vos/types.ts";
import { cn } from "../../lib/cn.ts";
import {
	answerApproval,
	answerSecret,
	declineSecret,
	imageFor,
	isGroupThread,
	openVos,
	sendMessage,
	stopThread,
	type ThreadState,
	threadOf,
	useVos,
} from "../../state/vos.ts";
import { Button } from "../ui/button.tsx";
import { Icon } from "../ui/icon.tsx";
import { threadTimeline } from "../../state/vos-timeline.ts";
import { VosAvatar, VosText } from "./parts.tsx";

/** Re-render every second while mounted: the live line's timer. */
function useTick(active: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [active]);
	return now;
}

const STATUS_TEXT: Record<Task["status"], string> = {
	inProgress: "Working",
	waiting: "Waiting",
	scheduled: "Scheduled",
	completed: "Done",
	failed: "Failed",
	cancelled: "Stopped",
};

function TaskCard({ task }: { task: Task }) {
	const running = task.status === "inProgress" || task.status === "waiting";
	// Waiting is on the user: amber and still throughout, never the working spinner.
	const waiting = task.status === "waiting";
	const now = useTick(running);
	const plan = task.plan?.length ? task.plan : task.steps.map((s) => ({ text: s.text, status: s.done ? "done" : "doing" }));
	return (
		<div id={`vos-task-${task.id}`} className="mt-2 w-full max-w-[520px] overflow-hidden rounded-xl border bg-card/70">
			<div className="flex items-center gap-2 px-3.5 pt-3 pb-2">
				<span
					className={cn(
						"flex size-5 flex-none items-center justify-center rounded-full",
						waiting
							? "text-warn"
							: running
								? "text-tint"
								: task.status === "completed"
									? "text-ok"
									: task.status === "failed"
										? "text-warn"
										: "text-faint",
					)}
				>
					<Icon
						name={waiting ? "info" : running ? "spinner" : task.status === "completed" ? "check" : "close"}
						className={cn("[&>svg]:size-4", running && !waiting && "animate-spin [animation-duration:1.4s]")}
					/>
				</span>
				<span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">{task.title}</span>
				<span
					className={cn(
						"flex-none rounded-full px-2 py-0.5 text-[11px] font-medium",
						running && !waiting && "bg-tint/12 text-tint-text",
						waiting && "bg-warn/12 text-warn",
						task.status === "completed" && "bg-ok/12 text-ok",
						task.status === "failed" && "bg-warn/12 text-warn",
						task.status === "cancelled" && "bg-muted text-muted-foreground",
					)}
				>
					{STATUS_TEXT[task.status]}
				</span>
			</div>
			{running && !waiting && (
				<div className="mx-3.5 mb-2 h-1 overflow-hidden rounded-full bg-muted">
					<div
						className="h-full rounded-full bg-tint transition-[width] duration-500"
						style={{ width: `${Math.round(Math.max(0.04, task.progress) * 100)}%` }}
					/>
				</div>
			)}
			{plan.length > 0 && (
				<ol className="flex flex-col gap-1 px-3.5 pb-2.5">
					{plan.map((step, i) => {
						// Only a running task has a step in hand; a finished one's leftovers read as skipped.
						const live = running && step.status === "doing";
						return (
							<li
								// biome-ignore lint/suspicious/noArrayIndexKey: plan steps have no ids and never reorder
								key={i}
								className={cn(
									"flex items-start gap-2 text-[13px] leading-snug",
									step.status === "done" ? "text-muted-foreground" : live ? "text-foreground" : "text-faint",
								)}
							>
								<span className="mt-[3px] flex size-3.5 flex-none items-center justify-center">
									{step.status === "done" ? (
										<Icon name="check" className="text-ok [&>svg]:size-3.5" />
									) : live ? (
										<span className={cn("size-2 rounded-full", waiting ? "bg-warn" : "animate-pulse-soft bg-tint")} />
									) : (
										<span className="size-2 rounded-full border border-faint" />
									)}
								</span>
								<span className={cn(step.status === "done" && "line-through decoration-faint/60")}>
									{step.text}
								</span>
							</li>
						);
					})}
				</ol>
			)}
			{running && task.now && (
				<div className="flex items-center gap-2 border-t bg-background/40 px-3.5 py-2 text-[12.5px]">
					<span
						className={cn(
							"size-1.5 flex-none rounded-full",
							waiting ? "bg-warn" : "animate-pulse-soft bg-tint",
						)}
					/>
					<span
						className={cn("min-w-0 flex-1 truncate", waiting ? "text-warn" : "vos-shimmer")}
					>
						{task.now}
					</span>
					<span className="flex-none font-mono text-[11.5px] tabular-nums text-faint">{elapsed(task.nowAt, now)}</span>
				</div>
			)}
			{!running && task.result && <TaskResult text={task.result} />}
		</div>
	);
}

/** A finished task's own account of itself; long ones fold to a few lines. */
function TaskResult({ text }: { text: string }) {
	const [open, setOpen] = useState(false);
	const long = text.length > 320;
	return (
		<div className="border-t px-3.5 py-2 text-[13px] leading-relaxed text-muted-foreground">
			<p className={cn("whitespace-pre-wrap", long && !open && "line-clamp-4")}>{text}</p>
			{long && (
				<button
					type="button"
					onClick={() => setOpen(!open)}
					className="mt-1 text-[12px] font-medium text-tint-text hover:underline"
				>
					{open ? "Show less" : "Show more"}
				</button>
			)}
		</div>
	);
}

function ApprovalCard({ dot, approval }: { dot: string; approval: Approval }) {
	const pending = approval.state === "pending";
	return (
		<div className="mt-2 w-full max-w-[520px] rounded-xl border border-warn/35 bg-warn/[0.06] p-3.5">
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<div className="text-[13.5px] font-medium">{approval.title}</div>
					<div className="mt-0.5 text-[13px] text-muted-foreground">{approval.detail}</div>
					<div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-faint">
						{approval.site && <span>{approval.site}</span>}
						{approval.amount && <span className="font-medium text-foreground">{approval.amount}</span>}
						{approval.reason && <span>{approval.reason}</span>}
					</div>
				</div>
				{!pending && (
					<span className="flex-none rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground capitalize">
						{approval.state}
					</span>
				)}
			</div>
			{pending && !approval.handoff && (
				<div className="mt-3 flex flex-wrap gap-2">
					<Button size="sm" onClick={() => void answerApproval(dot, approval.id, "approve")}>
						Approve
					</Button>
					<Button size="sm" variant="outline" onClick={() => void answerApproval(dot, approval.id, "deny")}>
						Deny
					</Button>
					<Button size="sm" variant="ghost" onClick={() => void answerApproval(dot, approval.id, "always")}>
						Always allow
					</Button>
				</div>
			)}
			{pending && approval.handoff && (
				<p className="mt-2 text-[12.5px] text-muted-foreground">
					This one is yours to do: take over the computer in the Vos app, then hand it back.
				</p>
			)}
		</div>
	);
}

/**
 * A secret the vos asked for. The field is masked, never echoed, and its
 * value is dropped from this page as soon as it is sent (or the card goes).
 */
function SecretCard({ request }: { request: SecretRequest | undefined }) {
	const [value, setValue] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// The value lives only in this card's own state: it goes with the card,
	// is never put in the store, and is cleared the moment it is sent.
	if (!request) {
		return (
			<div className="mt-2 inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-[12.5px] text-faint">
				<Icon name="key" className="[&>svg]:size-3.5" />
				Secret request answered or expired
			</div>
		);
	}
	const send = async (): Promise<void> => {
		if (!value) return;
		setBusy(true);
		const failure = await answerSecret(request, value);
		setValue("");
		setBusy(false);
		setError(failure);
	};
	return (
		<form
			className="mt-2 w-full max-w-[520px] rounded-xl border bg-card/70 p-3.5"
			onSubmit={(event) => {
				event.preventDefault();
				void send();
			}}
		>
			<div className="flex items-center gap-2 text-[13.5px] font-medium">
				<Icon name="key" className="text-warn" />
				{request.label}
			</div>
			<p className="mt-1 text-[13px] text-muted-foreground">{request.why}</p>
			<p className="mt-1 text-[12px] text-faint">
				{request.into === "env"
					? `Goes into ${request.env ?? "an environment variable"} on its computer`
					: "Typed into the focused field on its computer"}
				{request.site ? ` · ${request.site}` : ""} · never stored or shown again
			</p>
			<div className="mt-3 flex gap-2">
				<input
					type="password"
					value={value}
					onChange={(e) => setValue(e.target.value)}
					autoComplete="off"
					spellCheck={false}
					aria-label={request.label}
					placeholder="Paste or type it here"
					className="h-9 min-w-0 flex-1 rounded-lg border bg-background px-3 font-mono text-sm placeholder:font-sans placeholder:text-faint focus-visible:border-border-strong focus-visible:outline-none"
				/>
				<Button type="submit" size="sm" className="h-9" disabled={busy || !value}>
					{busy ? "Sending…" : "Send"}
				</Button>
				<Button type="button" size="sm" variant="ghost" className="h-9" onClick={() => void declineSecret(request)}>
					Decline
				</Button>
			</div>
			{error && <p className="mt-2 text-[12.5px] text-destructive">{error}</p>}
		</form>
	);
}

function SkillChip({ skill, id }: { skill: Skill | undefined; id: string }) {
	return (
		<button
			type="button"
			onClick={() => openVos(undefined, "skills")}
			className="mt-2 flex w-full max-w-[520px] items-center gap-3 rounded-xl border bg-card/70 px-3.5 py-2.5 text-left transition-colors hover:bg-accent/50"
		>
			<span className="flex size-8 flex-none items-center justify-center rounded-lg bg-tint/12 font-mono text-[13px] text-tint-text">
				/
			</span>
			<span className="min-w-0 flex-1">
				<span className="block truncate text-[13.5px] font-medium">{skill ? `/${skill.slug}` : "A skill"}</span>
				<span className="block truncate text-[12.5px] text-muted-foreground">{skill?.description ?? id}</span>
			</span>
			{skill?.draft && (
				<span className="flex-none rounded-full bg-warn/15 px-2 py-0.5 text-[11px] font-medium text-warn">Draft</span>
			)}
		</button>
	);
}

function ImageAttachment({ url }: { url: string }) {
	useVos();
	const src = imageFor(url);
	if (!src) return <div className="mt-2 h-40 w-64 animate-pulse-soft rounded-xl bg-muted" />;
	return <img src={src} alt="" className="mt-2 max-h-80 max-w-full rounded-xl border object-contain" />;
}

function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

function Attachment({ dot, message, thread }: { dot: string; message: Message; thread: ThreadState }) {
	const v = useVos();
	const a = message.attachment;
	if (!a) return null;
	switch (a.type) {
		case "task": {
			const task = thread.tasks.get(a.id);
			return task ? <TaskCard task={task} /> : null;
		}
		case "approval": {
			const approval = thread.approvals.get(a.id);
			return approval ? <ApprovalCard dot={dot} approval={approval} /> : null;
		}
		case "secret":
			return <SecretCard request={v.secrets.find((s) => s.id === a.id)} />;
		case "skill":
			return <SkillChip id={a.id} skill={v.skills?.find((s) => s.id === a.id)} />;
		case "image":
			return <ImageAttachment url={a.url} />;
		case "link":
			return (
				<a
					href={a.url}
					target="_blank"
					rel="noreferrer noopener"
					className="mt-2 flex w-full max-w-[520px] items-center gap-3 rounded-xl border bg-card/70 px-3.5 py-2.5 transition-colors hover:bg-accent/50"
				>
					{a.image?.startsWith("/") ? (
						<LinkThumb url={a.image} />
					) : (
						<span className="flex size-9 flex-none items-center justify-center rounded-lg bg-muted text-faint">
							<Icon name="copy" />
						</span>
					)}
					<span className="min-w-0 flex-1">
						<span className="block truncate text-[13.5px] font-medium text-foreground">{a.title}</span>
						<span className="block truncate text-[12.5px] text-muted-foreground">{a.detail ?? hostOf(a.url)}</span>
					</span>
					<Icon name="chevron" className="text-faint" />
				</a>
			);
		case "table":
			return (
				<div className="md mt-2 max-w-full">
					<table>
						<thead>
							<tr>
								{a.headers.map((h) => (
									<th key={h}>{h}</th>
								))}
							</tr>
						</thead>
						<tbody>
							{a.rows.map((row, i) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: table rows are static
								<tr key={i}>
									{row.map((cell, j) => (
										// biome-ignore lint/suspicious/noArrayIndexKey: table cells are static
										<td key={j}>{cell}</td>
									))}
								</tr>
							))}
						</tbody>
					</table>
				</div>
			);
		case "flag":
			return (
				<div className="mt-2 max-w-[520px] rounded-xl border border-warn/35 bg-warn/[0.06] px-3.5 py-2.5">
					<div className="text-[13.5px] font-medium">{a.title}</div>
					<div className="text-[13px] text-muted-foreground">{a.detail}</div>
				</div>
			);
		case "file":
			return (
				<div className="mt-2 inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[13px]">
					<Icon name="attach" className="text-faint" />
					{a.name}
				</div>
			);
		case "safety":
			return (
				<div className="mt-2 max-w-[520px] rounded-xl border border-destructive/35 bg-destructive/[0.06] px-3.5 py-2.5 text-[13px]">
					The vos paused for a safety check. Answer it in the Vos app.
				</div>
			);
		default:
			return null;
	}
}

function LinkThumb({ url }: { url: string }) {
	useVos();
	const src = imageFor(url);
	return src ? (
		<img src={src} alt="" className="size-9 flex-none rounded-lg object-cover" />
	) : (
		<span className="size-9 flex-none rounded-lg bg-muted" />
	);
}

function Choices({ dot, message, thread }: { dot: string; message: Message; thread: ThreadState }) {
	if (!message.choices?.length) return null;
	// Choices under an approval are the approval's own buttons, drawn by its card.
	if (message.attachment?.type === "approval" && thread.approvals.has(message.attachment.id)) return null;
	const isLast = thread.messages.at(-1)?.id === message.id;
	return (
		<div className="mt-2 flex flex-wrap gap-2">
			{message.choices.map((choice) => (
				<Button
					key={choice}
					size="sm"
					variant="outline"
					disabled={!isLast}
					className="rounded-full"
					onClick={() => void sendMessage(dot, choice)}
				>
					{choice}
				</Button>
			))}
		</div>
	);
}

function MessageLink({ message }: { message: Message }) {
	const link = message.link;
	if (!link) return null;
	if (link.target.type === "url") {
		return (
			<a
				href={link.target.url}
				target="_blank"
				rel="noreferrer noopener"
				className="mt-2 inline-flex items-center gap-1 text-[13px] font-medium text-tint-text hover:underline"
			>
				{link.label}
				<Icon name="chevron" className="[&>svg]:size-3.5" />
			</a>
		);
	}
	if (link.target.type === "vos") {
		const id = link.target.id;
		return (
			<button
				type="button"
				onClick={() => openVos(id, "chat")}
				className="mt-2 inline-flex items-center gap-1 text-[13px] font-medium text-tint-text hover:underline"
			>
				{link.label}
			</button>
		);
	}
	if (link.target.type === "task") {
		const id = link.target.id;
		return (
			<button
				type="button"
				onClick={() => {
					const card = document.getElementById(`vos-task-${id}`);
					card?.scrollIntoView({ behavior: "smooth", block: "center" });
					card?.animate([{ outlineColor: "var(--ring)" }, { outlineColor: "transparent" }], { duration: 1200 });
				}}
				className="mt-2 inline-flex items-center gap-1 text-[13px] font-medium text-tint-text hover:underline"
			>
				{link.label}
			</button>
		);
	}
	return <span className="mt-2 inline-block text-[13px] text-faint">{link.label}</span>;
}

function MessageRow({
	dot,
	message,
	thread,
	speaker,
	first,
}: {
	dot: string;
	message: Message;
	thread: ThreadState;
	speaker: { id: string; name: string; look?: RosterDot["look"] } | null;
	first: boolean;
}) {
	if (message.role === "you") {
		return (
			<div className={cn("flex justify-end", first ? "mt-5" : "mt-1.5")}>
				<div className="max-w-[78%] rounded-2xl border border-border/60 bg-card px-4 py-2.5 text-[14px] leading-relaxed break-words whitespace-pre-wrap text-foreground">
					{message.text}
				</div>
			</div>
		);
	}
	return (
		<div className={cn("flex gap-3", first ? "mt-5" : "mt-1.5")}>
			<div className="w-7 flex-none">
				{first && speaker && <VosAvatar name={speaker.name} look={speaker.look} id={speaker.id} size={28} />}
			</div>
			<div className="min-w-0 flex-1">
				{first && speaker && (
					<div className="mb-0.5 text-[12.5px] font-semibold text-foreground/90">{speaker.name}</div>
				)}
				{message.text && <VosText text={message.text} />}
				<MessageLink message={message} />
				<Attachment dot={dot} message={message} thread={thread} />
				<Choices dot={dot} message={message} thread={thread} />
			</div>
		</div>
	);
}

/** The composer: Enter sends, "/" offers skills, "@" offers the group's members. */
function Composer({ dot, busy, members }: { dot: string; busy: boolean; members: RosterDot[] }) {
	const v = useVos();
	const [text, setText] = useState("");
	const [caret, setCaret] = useState(0);
	const [pick, setPick] = useState(0);
	const ref = useRef<HTMLTextAreaElement>(null);
	const group = isGroupThread(dot);

	// The draft is per thread: switching vos starts clean.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset on thread change only
	useEffect(() => {
		setText("");
		ref.current?.focus();
	}, [dot]);

	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		el.style.height = "0px";
		el.style.height = `${Math.min(220, el.scrollHeight)}px`;
	}, [text]);

	const slash = slashQuery(text);
	const mention = group ? mentionQuery(text, caret) : null;
	const skillItems = slash !== null ? filterSkills(v.skills ?? [], slash) : [];
	const memberItems = mention ? filterMembers(members, mention.query) : [];
	const items: { key: string; label: string; detail: string; apply: () => void }[] =
		slash !== null
			? skillItems.map((s) => ({
					key: s.id,
					label: `/${s.slug}`,
					detail: s.description,
					apply: () => {
						setText(`/${s.slug} `);
						setCaret(s.slug.length + 2);
					},
				}))
			: memberItems.map((m) => ({
					key: m.id,
					label: `@${m.name}`,
					detail: m.label ?? "",
					apply: () => {
						if (!mention) return;
						const next = insertMention(text, mention.start, caret, m.name);
						setText(next.text);
						setCaret(next.caret);
						requestAnimationFrame(() => ref.current?.setSelectionRange(next.caret, next.caret));
					},
				}));
	const open = items.length > 0;
	// "/" with nothing to offer says why, instead of showing nothing at all.
	const noSkills = slash !== null && v.skills !== null && v.skills.length === 0;
	const index = Math.min(pick, Math.max(0, items.length - 1));

	const submit = async (): Promise<void> => {
		const value = text;
		if (!value.trim()) return;
		setText("");
		const ok = await sendMessage(dot, value);
		if (!ok) setText(value);
	};

	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
		if (open) {
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				setPick((index + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length);
				return;
			}
			if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
				event.preventDefault();
				items[index]?.apply();
				setPick(0);
				return;
			}
		}
		if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
			event.preventDefault();
			void submit();
		}
	};

	return (
		<div className="relative mx-auto w-full max-w-[760px] px-6 pb-5">
			{noSkills && (
				<div className="absolute right-6 bottom-full left-6 mb-2 rounded-xl border bg-popover px-3.5 py-2.5 text-[12.5px] text-muted-foreground shadow-[0_12px_32px_-12px_rgba(var(--shadow-rgb),0.45)]">
					No skills yet. Teach one, or write one under Skills; they show up here as / commands.
				</div>
			)}
			{open && (
				<div
					role="listbox"
					className="absolute right-6 bottom-full left-6 mb-2 overflow-hidden rounded-xl border bg-popover p-1 shadow-[0_12px_32px_-12px_rgba(var(--shadow-rgb),0.45)]"
				>
					{items.map((item, i) => (
						<button
							key={item.key}
							type="button"
							role="option"
							aria-selected={i === index}
							onMouseDown={(event) => {
								event.preventDefault();
								item.apply();
								setPick(0);
								ref.current?.focus();
							}}
							className={cn(
								"flex w-full items-baseline gap-3 rounded-lg px-2.5 py-1.5 text-left",
								i === index ? "bg-accent" : "hover:bg-accent/60",
							)}
						>
							<span className="flex-none font-mono text-[13px] text-foreground">{item.label}</span>
							<span className="min-w-0 truncate text-[12.5px] text-muted-foreground">{item.detail}</span>
						</button>
					))}
				</div>
			)}
			<div className="flex items-end gap-2 rounded-2xl border bg-card px-3 py-2 shadow-[0_1px_2px_rgba(var(--shadow-rgb),0.06)] transition-colors focus-within:border-border-strong">
				<textarea
					ref={ref}
					rows={1}
					value={text}
					data-vos-composer
					placeholder={group ? "Message the group — @ to address one, / for skills" : "Message — / for skills"}
					onChange={(event) => {
						setText(event.target.value);
						setCaret(event.target.selectionStart ?? event.target.value.length);
						setPick(0);
					}}
					onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
					onKeyDown={onKeyDown}
					className="max-h-[220px] min-h-[24px] flex-1 resize-none bg-transparent py-1 text-[14px] leading-relaxed outline-none placeholder:text-faint"
				/>
				{busy && (
					// Alone, Stop takes Send's filled disc; beside Send (while typing) it steps back to an outline.
					<Button
						size="icon"
						variant={text.trim() ? "outline" : "default"}
						className="size-8 flex-none rounded-full"
						title="Stop what it's doing"
						aria-label="Stop"
						onClick={() => void stopThread(dot)}
					>
						<Icon name="stop" className={cn("[&>svg]:size-3.5", !text.trim() && "[&_rect]:fill-current")} />
					</Button>
				)}
				{(!busy || text.trim()) && (
					<Button
						size="icon"
						className="size-8 flex-none rounded-full"
						title="Send"
						disabled={!text.trim()}
						onClick={() => void submit()}
					>
						<Icon name="send" />
					</Button>
				)}
			</div>
		</div>
	);
}

/** A vos's chat, or a group's: live, with task cards, approvals and secrets in the flow. */
export function VosChat({ dot }: { dot: string }) {
	const v = useVos();
	const thread = threadOf(dot);
	const scroller = useRef<HTMLDivElement>(null);
	const pinned = useRef(true);
	const roster = v.roster;
	const group = isGroupThread(dot) ? roster?.groups.find((g) => `group:${g.id}` === dot) : undefined;
	const self = roster?.dots.find((d) => d.id === dot);
	const members = group
		? group.members.map((id) => roster?.dots.find((d) => d.id === id)).filter((d): d is RosterDot => !!d)
		: [];
	// A task left "in progress" by a server restart is not work happening now:
	// only one that has said so lately (its heartbeat or live line) counts. Nor
	// does one the vos has since talked past while idle (it stopped, or the card
	// is stale): a real task sets a fresh live line on its next step.
	const now = Date.now();
	const lastVosAt = Date.parse([...thread.messages].reverse().find((m) => m.role !== "you")?.date ?? "") || 0;
	const running = [...thread.tasks.values()].some(
		(t) =>
			(t.status === "inProgress" || t.status === "waiting") &&
			((t.heartbeat?.at ?? 0) > now - 90_000 || Date.parse(t.nowAt ?? "") > now - 5 * 60_000) &&
			!(thread.status.mood === "idle" && lastVosAt > (Date.parse(t.nowAt ?? "") || 0)),
	);
	const busy = isBusy(thread.status.mood) || running;

	const last = thread.messages.at(-1);
	// biome-ignore lint/correctness/useExhaustiveDependencies: follow new messages and task updates
	useLayoutEffect(() => {
		const el = scroller.current;
		if (el && pinned.current) el.scrollTop = el.scrollHeight;
	}, [thread.messages.length, last?.id, thread.tasks, dot]);

	const timeline = threadTimeline(thread.messages, thread.tasks.values());

	const speakerOf = (m: Message) => {
		if (m.role === "you") return null;
		if (m.fromVos) return m.fromVos;
		if (self) return { id: self.id, name: self.name, look: self.look };
		return { id: dot, name: "Vos" };
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div
				ref={scroller}
				className="min-h-0 flex-1 overflow-y-auto"
				onScroll={(event) => {
					const el = event.currentTarget;
					pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
				}}
			>
				<div className="mx-auto w-full max-w-[760px] px-6 pt-2 pb-6">
					{!thread.loaded && <p className="py-10 text-center text-sm text-faint">Loading…</p>}
					{thread.loaded && timeline.length === 0 && (
						<p className="py-16 text-center text-sm text-muted-foreground">
							{group ? `Say hello to ${group.name}.` : `Say hello to ${self?.name ?? "your vos"}.`}
						</p>
					)}
					{timeline.map((item, i) => {
						if (item.kind === "task") {
							return (
								<div key={`task-${item.task.id}`} className="mt-4 flex gap-3">
									<div className="w-7 flex-none" />
									<div className="min-w-0 flex-1">
										<TaskCard task={item.task} />
									</div>
								</div>
							);
						}
						const m = item.message;
						const before = timeline[i - 1];
						const prev = before?.kind === "message" ? before.message : undefined;
						const speaker = speakerOf(m);
						const prevSpeaker = prev ? speakerOf(prev) : undefined;
						const first =
							!prev ||
							prev.role !== m.role ||
							(speaker?.id ?? "") !== (prevSpeaker?.id ?? "") ||
							Date.parse(m.date) - Date.parse(prev.date) > 10 * 60_000;
						return <MessageRow key={m.id} dot={dot} message={m} thread={thread} speaker={speaker} first={first} />;
					})}
					{busy && !running && (
						<div className="mt-4 flex items-center gap-3 text-[13px]">
							{self && (
								<VosAvatar
									name={self.name}
									look={self.look}
									id={self.id}
									size={28}
									mood={thread.status.mood}
								/>
							)}
							<span className={cn("vos-shimmer min-w-0 truncate", !self && "pl-10")}>
								{thread.status.statusLine || moodLabel(thread.status.mood)}
							</span>
						</div>
					)}
				</div>
			</div>
			<Composer dot={dot} busy={busy} members={members} />
		</div>
	);
}
