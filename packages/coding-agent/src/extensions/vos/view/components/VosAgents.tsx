import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
	type AgentTone,
	agentDuration,
	agentStateLabel,
	agentTone,
	checksLabel,
	isAgentActive,
	parseRepo,
	sortAgents,
} from "../../agents.ts";
import type { AgentJob, AgentLogLine } from "../../types.ts";
import { bridge } from "../bridge.ts";
import {
	cancelAgent,
	closeAgent,
	loadAgents,
	loadGithub,
	messageAgent,
	nameOf,
	openAgent,
	openInbox,
	retryAgent,
	startAgent,
	useVos,
} from "../store.ts";
import { Button, cn, Icon, Input, Select, Textarea } from "../ui.tsx";
import { Card, Empty, PageHeader } from "./parts.tsx";

/**
 * Cloud agents: jobs that run smolt in a fresh VM on one repo and end in a
 * pull request. The list, a start form, and one job in detail with its live
 * log, a follow-up message, cancel or retry, the PR and the VM's screen.
 */

const TONE: Record<AgentTone, string> = {
	busy: "bg-tint/12 text-tint-text",
	warn: "bg-warn/15 text-warn",
	ok: "bg-ok/15 text-ok",
	bad: "bg-destructive/12 text-destructive",
	quiet: "bg-muted text-muted-foreground",
};

function StateBadge({ job }: { job: AgentJob }) {
	const tone = agentTone(job.state);
	return (
		<span className={cn("flex flex-none items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium", TONE[tone])}>
			{tone === "busy" && <span className="size-1.5 animate-pulse-soft rounded-full bg-tint" />}
			{agentStateLabel(job.state)}
		</span>
	);
}

function Checks({ checks }: { checks: NonNullable<AgentJob["pr"]>["checks"] }) {
	if (!checks) return null;
	const tone = checks === "passing" ? "bg-ok" : checks === "failing" ? "bg-destructive" : "animate-pulse-soft bg-warn";
	return (
		<span className="flex items-center gap-1 text-[11.5px] text-muted-foreground" title={checksLabel(checks)}>
			<span className={cn("size-1.5 rounded-full", tone)} />
			{checksLabel(checks)}
		</span>
	);
}

/** A second's tick while anything on the page is running, so durations move. */
function useTick(active: boolean): void {
	const [, setNow] = useState(0);
	useEffect(() => {
		if (!active) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [active]);
}

function Setup({ installUrl }: { installUrl?: string }) {
	return (
		<Card className="mb-4 flex flex-wrap items-center gap-3">
			<span className="flex size-8 flex-none items-center justify-center rounded-lg bg-muted text-muted-foreground">
				<Icon name="branch" />
			</span>
			<div className="min-w-0 flex-1">
				<div className="text-[13.5px] font-medium">Connect GitHub</div>
				<div className="text-[12.5px] text-muted-foreground">Install the Vos app on the repos agents may use.</div>
			</div>
			{installUrl && (
				<Button size="sm" onClick={() => bridge.openUrl(installUrl)}>
					Install
				</Button>
			)}
			<Button size="sm" variant="outline" onClick={() => void loadGithub()}>
				Check again
			</Button>
		</Card>
	);
}

function StartForm({ onDone }: { onDone: () => void }) {
	const v = useVos();
	const repos = v.github?.repos ?? [];
	const vosList = (v.roster?.dots ?? []).filter((d) => !d.hidden);
	const [repo, setRepo] = useState(repos[0] ?? "");
	const [base, setBase] = useState("");
	const [task, setTask] = useState("");
	const [owner, setOwner] = useState(vosList.some((d) => d.id === "main") ? "main" : (vosList[0]?.id ?? "main"));
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<{ error: string; installUrl?: string } | null>(null);
	useEffect(() => {
		if (!repo && repos[0]) setRepo(repos[0]);
	}, [repo, repos]);
	const slug = parseRepo(repo);
	const submit = async (): Promise<void> => {
		if (!slug || !task.trim()) return;
		setBusy(true);
		setError(null);
		const failed = await startAgent({ vos: owner, repo: slug, task: task.trim(), base: base.trim() || undefined });
		setBusy(false);
		if (failed) setError(failed);
		else onDone();
	};
	return (
		<Card className="mb-4 flex flex-col gap-3">
			<div className="flex flex-wrap gap-2">
				{repos.length > 0 ? (
					<Select label="Repository" value={repo} onChange={setRepo} options={repos.map((r) => ({ value: r, label: r }))} className="min-w-[200px] flex-[2]" />
				) : (
					<Input aria-label="Repository" placeholder="owner/repo" value={repo} onChange={(e) => setRepo(e.target.value)} className="min-w-[200px] flex-[2]" />
				)}
				<Input aria-label="Base branch" placeholder="Base: default" value={base} onChange={(e) => setBase(e.target.value)} className="min-w-[120px] flex-1" />
				{vosList.length > 1 && (
					<Select label="Vos" value={owner} onChange={setOwner} options={vosList.map((d) => ({ value: d.id, label: d.name }))} className="w-[140px] flex-none" />
				)}
			</div>
			<Textarea
				aria-label="Task"
				placeholder="What should it do?"
				rows={3}
				value={task}
				onChange={(e) => setTask(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit();
				}}
			/>
			{error && (
				<div className="flex flex-wrap items-center gap-2 text-[12.5px] text-destructive">
					<span>{error.error}</span>
					{error.installUrl && (
						<Button size="xs" variant="outline" onClick={() => error.installUrl && bridge.openUrl(error.installUrl)}>
							Install GitHub app
						</Button>
					)}
				</div>
			)}
			<div className="flex items-center justify-end gap-2">
				<Button size="sm" variant="ghost" onClick={onDone}>
					Cancel
				</Button>
				<Button size="sm" disabled={busy || !slug || !task.trim()} onClick={() => void submit()}>
					{busy ? "Starting…" : "Start"}
				</Button>
			</div>
		</Card>
	);
}

function Row({ job }: { job: AgentJob }) {
	const active = isAgentActive(job.state);
	const line = active ? job.step : (job.error ?? job.summary);
	return (
		<div className="flex items-start gap-3 border-b px-4 py-3 last:border-b-0">
			<button type="button" onClick={() => void openAgent(job.id)} className="min-w-0 flex-1 text-left" data-agent={job.id}>
				<div className="flex min-w-0 items-center gap-2">
					<StateBadge job={job} />
					<span className="truncate text-[13.5px] font-medium">{job.repo}</span>
					<span className="truncate font-mono text-[11.5px] text-faint">{job.branch}</span>
				</div>
				{line && <div className={cn("mt-1 truncate text-[12.5px]", job.error && !active ? "text-destructive" : "text-muted-foreground")}>{line}</div>}
			</button>
			<div className="flex flex-none flex-col items-end gap-1">
				<span className="text-[12px] tabular-nums text-faint">{agentDuration(job)}</span>
				{job.pr && (
					<button
						type="button"
						onClick={() => job.pr && bridge.openUrl(job.pr.url)}
						className="flex items-center gap-1.5 text-[12px] text-tint-text hover:underline"
						title={job.pr.title}
					>
						#{job.pr.number}
						<Checks checks={job.pr.checks} />
					</button>
				)}
			</div>
		</div>
	);
}

const STREAM_TONE: Record<AgentLogLine["stream"], string> = {
	agent: "text-foreground",
	tool: "text-tint-text",
	shell: "text-muted-foreground",
	system: "text-warn",
};

function Log({ lines, active }: { lines: AgentLogLine[]; active: boolean }) {
	const box = useRef<HTMLDivElement>(null);
	const stick = useRef(true);
	useLayoutEffect(() => {
		const el = box.current;
		if (el && stick.current) el.scrollTop = el.scrollHeight;
	}, [lines.length]);
	return (
		<div
			ref={box}
			onScroll={(e) => {
				const el = e.currentTarget;
				stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
			}}
			className={cn(
				"overflow-y-auto rounded-xl border bg-background-deep px-3 py-2 font-mono text-[12px] leading-[1.55]",
				active ? "h-[340px]" : "max-h-[340px]",
			)}
			data-agent-log
		>
			{lines.length === 0 ? (
				<div className="py-6 text-center text-faint">{active ? "Waiting for output…" : "No log."}</div>
			) : (
				lines.map((line, i) => (
					// Lines have no id; their order is the log's.
					// biome-ignore lint/suspicious/noArrayIndexKey: append-only list
					<div key={i} className={cn("whitespace-pre-wrap break-words", STREAM_TONE[line.stream])}>
						{line.stream === "shell" ? "$ " : ""}
						{line.text}
					</div>
				))
			)}
		</div>
	);
}

/** The VM's screen over the agent's live line, when the server offers one. */
function AgentLive({ id }: { id: string }) {
	const v = useVos();
	const key = `agent:${id}`;
	const frame = v.frames.get(key);
	const live = v.live.get(key);
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		let stopped = false;
		const open = async (): Promise<void> => {
			const result = (await bridge.request("agentLiveOpen", { id }).catch(() => ({ ok: false }))) as { ok: boolean };
			if (!stopped && !result.ok) setFailed(true);
		};
		void open();
		const renew = setInterval(() => void open(), 15_000);
		return () => {
			stopped = true;
			clearInterval(renew);
			void bridge.request("liveClose", { dot: key }).catch(() => {});
		};
	}, [id, key]);
	const gone = failed || live === "unavailable" || live === "closed";
	return (
		<div
			className="relative mb-3 max-w-[640px] overflow-hidden rounded-xl border bg-background-deep"
			style={{ aspectRatio: frame ? `${frame.w} / ${frame.h}` : "16 / 10" }}
		>
			{frame && !gone ? (
				<img src={frame.image} alt="The agent's VM" className="size-full object-contain" draggable={false} />
			) : (
				<div className="flex size-full items-center justify-center text-[13px] text-faint">
					{gone ? "No live view for this VM" : "Connecting…"}
				</div>
			)}
		</div>
	);
}

function Detail({ job }: { job: AgentJob }) {
	const v = useVos();
	const active = isAgentActive(job.state);
	const log = v.agentLogs.get(job.id);
	const [text, setText] = useState("");
	const [watching, setWatching] = useState(false);
	useTick(active);
	const send = async (): Promise<void> => {
		if (await messageAgent(job, text)) setText("");
	};
	return (
		<div className="mx-auto w-full max-w-[900px] px-6 pt-4 pb-10">
			<button type="button" onClick={closeAgent} className="mb-3 flex items-center gap-1 text-[12.5px] text-muted-foreground hover:text-foreground">
				<span className="flex rotate-180">
					<Icon name="chevron" />
				</span>
				Cloud agents
			</button>
			<div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
				<h2 className="text-[17px] font-semibold tracking-[-0.01em]">{job.repo}</h2>
				<StateBadge job={job} />
				<span className="text-[12.5px] tabular-nums text-faint">{agentDuration(job)}</span>
				<div className="ml-auto flex flex-wrap items-center gap-1.5">
					{job.pr && (
						<Button size="sm" variant="outline" onClick={() => job.pr && bridge.openUrl(job.pr.url)}>
							<Icon name="external" />
							PR #{job.pr.number}
						</Button>
					)}
					{active && job.vm && (
						<Button size="sm" variant={watching ? "secondary" : "outline"} onClick={() => setWatching(!watching)}>
							<Icon name="screen" />
							{watching ? "Hide VM" : "Watch VM"}
						</Button>
					)}
					{active ? (
						<Button size="sm" variant="outline" className="text-destructive" onClick={() => void cancelAgent(job)}>
							Cancel
						</Button>
					) : (
						<Button size="sm" variant="outline" onClick={() => void retryAgent(job)}>
							<Icon name="refresh" />
							Retry
						</Button>
					)}
				</div>
			</div>
			<div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-muted-foreground">
				<span className="font-mono">
					{job.branch} <span className="text-faint">→ {job.base}</span>
				</span>
				<span>{nameOf(job.vos)}</span>
				{job.pr && <Checks checks={job.pr.checks} />}
			</div>
			<p className="mb-3 text-[13.5px] whitespace-pre-wrap">{job.task}</p>
			{job.state === "waiting" && (
				<div className="mb-3 flex items-center gap-2 rounded-lg border border-warn/30 bg-warn/[0.06] px-3 py-2 text-[13px] text-warn">
					<span className="flex-1">{job.step ?? "Waiting on an approval"}</span>
					<Button size="xs" variant="outline" onClick={openInbox}>
						Inbox
					</Button>
				</div>
			)}
			{job.summary && !active && <p className="mb-3 text-[13.5px] text-foreground">{job.summary}</p>}
			{job.error && <p className="mb-3 text-[13px] text-destructive">{job.error}</p>}
			{watching && active && <AgentLive id={job.id} />}
			{active && job.step && job.state !== "waiting" && (
				<div className="mb-2 flex items-center gap-1.5 text-[12.5px] text-tint-text">
					<span className="size-1.5 animate-pulse-soft rounded-full bg-tint" />
					{job.step}
				</div>
			)}
			<Log lines={log?.lines ?? []} active={active} />
			{active && (
				<form
					className="mt-3 flex gap-2"
					onSubmit={(e) => {
						e.preventDefault();
						void send();
					}}
				>
					<Input placeholder="Message the agent" value={text} onChange={(e) => setText(e.target.value)} />
					<Button type="submit" size="sm" className="h-9" disabled={!text.trim()}>
						Send
					</Button>
				</form>
			)}
		</div>
	);
}

/** The cloud agents page: one job in detail, or the list with a start form. */
export function VosAgents() {
	const v = useVos();
	const [starting, setStarting] = useState(false);
	const jobs = sortAgents(v.agents ?? []);
	const open = v.agent ? jobs.find((j) => j.id === v.agent) : undefined;
	useTick(!open && jobs.some((j) => isAgentActive(j.state)));
	if (open) return <Detail job={open} />;
	const notConfigured = v.github && !v.github.configured;
	return (
		<div className="mx-auto w-full max-w-[860px] px-6 pt-4 pb-10">
			<PageHeader title="Cloud agents">
				<Button size="icon" variant="ghost" title="Refresh" onClick={() => void loadAgents()}>
					<Icon name="refresh" />
				</Button>
				{!notConfigured && !starting && (
					<Button size="sm" onClick={() => setStarting(true)}>
						<Icon name="plus" />
						New
					</Button>
				)}
			</PageHeader>
			{notConfigured && <Setup installUrl={v.github?.installUrl} />}
			{starting && !notConfigured && <StartForm onDone={() => setStarting(false)} />}
			{!v.agents && !v.agentsError && <p className="text-sm text-faint">Loading…</p>}
			{v.agentsError && !v.agents && <p className="text-sm text-destructive">{v.agentsError}</p>}
			{v.agents && jobs.length === 0 && !starting && <Empty>No cloud agents yet.</Empty>}
			{jobs.length > 0 && (
				<div className="rounded-xl border bg-card/60">
					{jobs.map((job) => (
						<Row key={job.id} job={job} />
					))}
				</div>
			)}
		</div>
	);
}
