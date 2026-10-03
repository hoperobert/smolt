import { useState } from "react";
import { ago } from "../../format.ts";
import type { Skill } from "../../types.ts";
import { attempt, bumpVos, loadSkills, requestConfirm, setTab, useVos, vos, vosCall } from "../store.ts";
import { Button, cn, Icon, Input, Textarea } from "../ui.tsx";
import { Card, Empty, Field, PageHeader } from "./parts.tsx";

const SOURCE: Record<Skill["source"], string> = {
	written: "Written",
	saved: "Saved by a vos",
	taught: "Taught",
	shared: "Shared",
};

interface Draft {
	slug: string;
	title: string;
	description: string;
	inputs: string;
	steps: string;
	rules: string;
	approvals: string;
	output: string;
}

const toDraft = (s?: Skill): Draft => ({
	slug: s?.slug ?? "",
	title: s?.title ?? "",
	description: s?.description ?? "",
	inputs: s?.inputs ?? "",
	steps: (s?.steps ?? []).join("\n"),
	rules: s?.rules ?? "",
	approvals: s?.approvals ?? "",
	output: s?.output ?? "",
});

function SkillEditor({ skill, onDone }: { skill?: Skill; onDone: () => void }) {
	const [draft, setDraft] = useState(() => toDraft(skill));
	const [busy, setBusy] = useState(false);
	const slugOk = /^[a-z0-9]+(-[a-z0-9]+)*$/.test(draft.slug);
	const set = (key: keyof Draft) => (e: { target: { value: string } }) => setDraft({ ...draft, [key]: e.target.value });
	const save = async (): Promise<void> => {
		setBusy(true);
		const body = {
			slug: draft.slug,
			title: draft.title.trim() || draft.slug,
			description: draft.description.trim(),
			steps: draft.steps
				.split("\n")
				.map((s) => s.trim())
				.filter(Boolean),
			...(draft.inputs.trim() ? { inputs: draft.inputs.trim() } : {}),
			...(draft.rules.trim() ? { rules: draft.rules.trim() } : {}),
			...(draft.approvals.trim() ? { approvals: draft.approvals.trim() } : {}),
			...(draft.output.trim() ? { output: draft.output.trim() } : {}),
		};
		const result = await attempt(() =>
			skill
				? vosCall<Skill>("PATCH", `/skills/${encodeURIComponent(skill.id)}`, body)
				: vosCall<Skill>("POST", "/skills", { ...body, source: "written", draft: false }),
		);
		setBusy(false);
		if (result) {
			await loadSkills();
			onDone();
		}
	};
	return (
		<Card className="flex flex-col gap-3">
			<div className="grid grid-cols-1 gap-3 sm:grid-cols-[200px_1fr]">
				<Field label="Command" hint={slugOk || !draft.slug ? undefined : "lowercase letters, digits and hyphens"}>
					<div className="flex items-center rounded-lg border focus-within:border-border-strong">
						<span className="pl-3 font-mono text-sm text-faint">/</span>
						<input
							value={draft.slug}
							onChange={(e) => setDraft({ ...draft, slug: e.target.value.toLowerCase().replace(/\s+/g, "-") })}
							className="h-9 min-w-0 flex-1 bg-transparent pr-3 pl-0.5 font-mono text-sm outline-none"
							spellCheck={false}
						/>
					</div>
				</Field>
				<Field label="Title">
					<Input value={draft.title} onChange={set("title")} />
				</Field>
			</div>
			<Field label="What it does, and when to use it">
				<Input value={draft.description} onChange={set("description")} />
			</Field>
			<Field label="Steps" hint="One per line">
				<Textarea rows={4} value={draft.steps} onChange={set("steps")} />
			</Field>
			<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
				<Field label="Inputs">
					<Input value={draft.inputs} onChange={set("inputs")} placeholder="What it needs to be told" />
				</Field>
				<Field label="Output">
					<Input value={draft.output} onChange={set("output")} placeholder="What it hands back" />
				</Field>
				<Field label="Rules">
					<Input value={draft.rules} onChange={set("rules")} />
				</Field>
				<Field label="Approvals">
					<Input value={draft.approvals} onChange={set("approvals")} placeholder="When to ask first" />
				</Field>
			</div>
			<div className="flex justify-end gap-2">
				<Button size="sm" variant="ghost" onClick={onDone}>
					Cancel
				</Button>
				<Button size="sm" disabled={!slugOk || busy} onClick={() => void save()}>
					{busy ? "Saving…" : "Save skill"}
				</Button>
			</div>
		</Card>
	);
}

function SkillCard({ skill, dot, onEdit }: { skill: Skill; dot: string | null; onEdit: () => void }) {
	const [open, setOpen] = useState(false);
	const v = useVos();
	const creator = skill.createdBy ? v.roster?.dots.find((d) => d.id === skill.createdBy)?.name : undefined;
	return (
		<Card className="p-0">
			<button
				type="button"
				onClick={() => setOpen(!open)}
				className="flex w-full items-start gap-3 rounded-xl px-4 py-3 text-left transition-colors hover:bg-accent/30"
			>
				<span className="mt-0.5 flex size-8 flex-none items-center justify-center rounded-lg bg-tint/12 font-mono text-[13px] text-tint-text">
					/
				</span>
				<span className="min-w-0 flex-1">
					<span className="flex items-center gap-2">
						<span className="truncate font-mono text-[13.5px] font-medium text-foreground">/{skill.slug}</span>
						{skill.draft && (
							<span className="flex-none rounded-full bg-warn/15 px-2 py-0.5 text-[11px] font-medium text-warn">Draft</span>
						)}
					</span>
					<span className="mt-0.5 block text-[13px] text-muted-foreground">{skill.description || skill.title}</span>
					<span className="mt-1 flex flex-wrap gap-x-3 text-[12px] text-faint">
						<span>{SOURCE[skill.source] ?? skill.source}</span>
						{creator && <span>by {creator}</span>}
						<span>
							used {skill.uses}×{skill.lastUsedAt ? `, last ${ago(skill.lastUsedAt)}` : ""}
						</span>
					</span>
				</span>
				<Icon name="chevron" className={cn("mt-2 text-faint transition-transform", open && "rotate-90")} />
			</button>
			{open && (
				<div className="border-t px-4 pt-3 pb-4">
					{skill.inputs && <p className="mb-2 text-[13px] text-muted-foreground">Needs: {skill.inputs}</p>}
					<ol className="ml-5 list-decimal text-[13px] leading-relaxed marker:text-faint">
						{skill.steps.map((step, i) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: steps are plain text in order
							<li key={i}>{step}</li>
						))}
					</ol>
					{(skill.rules || skill.approvals || skill.output) && (
						<dl className="mt-3 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-[12.5px]">
							{skill.rules && (
								<>
									<dt className="text-faint">Rules</dt>
									<dd className="text-muted-foreground">{skill.rules}</dd>
								</>
							)}
							{skill.approvals && (
								<>
									<dt className="text-faint">Approvals</dt>
									<dd className="text-muted-foreground">{skill.approvals}</dd>
								</>
							)}
							{skill.output && (
								<>
									<dt className="text-faint">Output</dt>
									<dd className="text-muted-foreground">{skill.output}</dd>
								</>
							)}
						</dl>
					)}
					<div className="mt-4 flex flex-wrap gap-1.5">
						<Button
							size="xs"
							variant="outline"
							disabled={!dot}
							title={dot ? "Run it now on safe test inputs" : "Open a vos to test with"}
							onClick={async () => {
								if (!dot) return;
								const started = await attempt(() => vosCall("POST", `/skills/${encodeURIComponent(skill.id)}/test`, {}, dot));
								if (started !== undefined) setTab("chat");
							}}
						>
							Test
						</Button>
						{skill.draft && (
							<Button
								size="xs"
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
						<Button size="xs" variant="ghost" onClick={onEdit}>
							Edit
						</Button>
						<Button
							size="xs"
							variant="ghost"
							className="text-destructive hover:text-destructive"
							onClick={async () => {
								const ok = await requestConfirm({
									title: `Delete /${skill.slug}?`,
									message: "Every vos loses it, and routines that use it run without it.",
									actionLabel: "Delete",
									destructive: true,
								});
								if (!ok) return;
								const done = await attempt(() => vosCall("DELETE", `/skills/${encodeURIComponent(skill.id)}`));
								if (done !== undefined && vos.skills) {
									vos.skills = vos.skills.filter((s) => s.id !== skill.id);
									bumpVos();
								}
							}}
						>
							Delete
						</Button>
					</div>
				</div>
			)}
		</Card>
	);
}

/** The skills library: shared by every vos, and the "/" commands in chat. */
export function VosSkills({ dot }: { dot: string | null }) {
	const v = useVos();
	const [query, setQuery] = useState("");
	const [editing, setEditing] = useState<string | "new" | null>(null);
	const q = query.trim().toLowerCase();
	const skills = (v.skills ?? [])
		.filter((s) => !q || s.slug.includes(q) || s.title.toLowerCase().includes(q) || s.description.toLowerCase().includes(q))
		.sort((a, b) => Number(b.draft) - Number(a.draft) || b.uses - a.uses || a.slug.localeCompare(b.slug));
	return (
		<div className="mx-auto w-full max-w-[760px] px-6 pt-2 pb-10">
			<PageHeader title="Skills" detail="Shared by all your vos. Type / in a chat to use one.">
				<Button size="sm" onClick={() => setEditing("new")}>
					<Icon name="plus" />
					New skill
				</Button>
			</PageHeader>
			<Input
				type="search"
				placeholder="Search skills"
				value={query}
				onChange={(e) => setQuery(e.target.value)}
				className="mb-4"
			/>
			<div className="flex flex-col gap-2.5">
				{editing === "new" && <SkillEditor onDone={() => setEditing(null)} />}
				{!v.skills && <p className="text-sm text-faint">Loading…</p>}
				{v.skills && skills.length === 0 && editing !== "new" && (
					<Empty>{q ? `No skills match "${query}".` : "No skills yet. Teach one, or write it here."}</Empty>
				)}
				{skills.map((skill) =>
					editing === skill.id ? (
						<SkillEditor key={skill.id} skill={skill} onDone={() => setEditing(null)} />
					) : (
						<SkillCard key={skill.id} skill={skill} dot={dot} onEdit={() => setEditing(skill.id)} />
					),
				)}
			</div>
		</div>
	);
}
