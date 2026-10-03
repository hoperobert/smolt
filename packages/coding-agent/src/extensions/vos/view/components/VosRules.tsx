import { useState } from "react";
import {
	ACTION_KINDS,
	decisionLabel,
	expiryFor,
	kindLabel,
	rememberLabel,
	ruleExpired,
	untilLabel,
} from "../../format.ts";
import { ALWAYS_ASK_KINDS, type ActionKind, type ApprovalRemember, type Rule, type RuleDecision } from "../../types.ts";
import { attempt, bumpVos, loadRules, requestConfirm, useVos, vos, vosCall } from "../store.ts";
import { Button, cn, Icon, Input, Select } from "../ui.tsx";
import { Card, Empty, Field, PageHeader, Segmented } from "./parts.tsx";

/** How long an allow rule made here holds: approve in advance for an hour, today, or for good. */
type Hold = Exclude<ApprovalRemember, "once">;
const HOLDS: { value: Hold; label: string }[] = (["1h", "today", "always"] as const).map((value) => ({
	value,
	label: rememberLabel(value),
}));

const DECISIONS: { value: RuleDecision; label: string }[] = (["allow", "ask", "block"] as const).map((value) => ({
	value,
	label: decisionLabel(value),
}));

const TONE: Record<RuleDecision, string> = {
	allow: "bg-ok",
	ask: "bg-warn",
	block: "bg-destructive",
};

interface Draft {
	kind: ActionKind;
	site: string;
	decision: RuleDecision;
	note: string;
	match: string;
	vos: string;
	/** For an allow rule: how long it holds. */
	hold: Hold;
}

function RuleEditor({ initial, onDone, rule }: { initial: Draft; onDone: () => void; rule?: Rule }) {
	const v = useVos();
	const [draft, setDraft] = useState(initial);
	const [busy, setBusy] = useState(false);
	const save = async (): Promise<void> => {
		setBusy(true);
		const body = {
			kind: draft.kind,
			site: draft.site.trim().toLowerCase(),
			decision: draft.decision,
			note: draft.note.trim(),
			// Clearing a field on an edit has to be said (null), or the old value stays.
			match: draft.match.trim() || (rule?.match ? null : undefined),
			vos: draft.vos || (rule?.vos ? null : undefined),
			// An allow made for a while lapses on its own; anything else holds until changed.
			expiresAt: draft.decision === "allow" ? (expiryFor(draft.hold) ?? (rule?.expiresAt ? null : undefined)) : rule?.expiresAt ? null : undefined,
		};
		const result = await attempt(() =>
			rule ? vosCall<Rule>("PATCH", `/rules/${encodeURIComponent(rule.id)}`, body) : vosCall<Rule>("POST", "/rules", body),
		);
		setBusy(false);
		if (result) {
			await loadRules();
			onDone();
		}
	};
	return (
		<Card className="flex flex-col gap-3">
			<div className="flex flex-wrap items-center gap-3">
				<Segmented<RuleDecision>
					label="Decision"
					value={draft.decision}
					options={DECISIONS}
					onChange={(decision) => setDraft({ ...draft, decision })}
				/>
				{draft.decision === "allow" && (
					<Segmented<Hold> label="For how long" value={draft.hold} options={HOLDS} onChange={(hold) => setDraft({ ...draft, hold })} />
				)}
			</div>
			<div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
				<Field label="When a vos wants to">
					<Select<ActionKind>
						label="Action"
						value={draft.kind}
						onChange={(kind) => setDraft({ ...draft, kind })}
						options={ACTION_KINDS.map((k) => ({ value: k, label: kindLabel(k) }))}
					/>
				</Field>
				<Field label="On">
					<Input value={draft.site} onChange={(e) => setDraft({ ...draft, site: e.target.value })} placeholder="any site" />
				</Field>
				<Field label="Which vos">
					<Select
						label="Which vos"
						value={draft.vos || "all"}
						onChange={(id) => setDraft({ ...draft, vos: id === "all" ? "" : id })}
						options={[{ value: "all", label: "All vos" }, ...(v.roster?.dots ?? []).map((d) => ({ value: d.id, label: d.name }))]}
					/>
				</Field>
			</div>
			<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
				<Field label="Only when (optional)">
					<Input
						value={draft.match}
						onChange={(e) => setDraft({ ...draft, match: e.target.value })}
						placeholder="only to people already in the thread"
					/>
				</Field>
				<Field label={draft.decision === "block" ? "In your words" : "Note"}>
					<Input
						value={draft.note}
						onChange={(e) => setDraft({ ...draft, note: e.target.value })}
						placeholder={draft.decision === "block" ? "Never send emails on my behalf" : undefined}
					/>
				</Field>
			</div>
			{draft.decision === "allow" && ALWAYS_ASK_KINDS.includes(draft.kind) && (
				<p className="text-[12.5px] text-warn">
					{kindLabel(draft.kind)} always asks, whatever the rules say: approve each one as it comes.
				</p>
			)}
			{draft.decision === "allow" && draft.match.trim() !== "" && (
				<p className="text-[12.5px] text-warn">
					The server can't check a condition, so “Allow automatically” with one still asks. The vos sees the condition.
				</p>
			)}
			<div className="flex justify-end gap-2">
				<Button size="sm" variant="ghost" onClick={onDone}>
					Cancel
				</Button>
				<Button size="sm" disabled={busy} onClick={() => void save()}>
					{busy ? "Saving…" : "Save rule"}
				</Button>
			</div>
		</Card>
	);
}

function RuleRow({ rule, onEdit }: { rule: Rule; onEdit: () => void }) {
	const v = useVos();
	const who = rule.vos ? (v.roster?.dots.find((d) => d.id === rule.vos)?.name ?? rule.vos) : "All vos";
	const setDecision = async (decision: RuleDecision): Promise<void> => {
		const next = await attempt(() => vosCall<Rule>("PATCH", `/rules/${encodeURIComponent(rule.id)}`, { decision }));
		if (next && vos.rules) {
			vos.rules = vos.rules.map((r) => (r.id === next.id ? next : r));
			bumpVos();
		}
	};
	return (
		<div className="group/rule flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-3 last:border-b-0">
			<span className={cn("size-2 flex-none rounded-full", TONE[rule.decision])} aria-hidden />
			<div className="min-w-[200px] flex-1">
				<div className="text-[13.5px]">
					<span className="font-medium">{kindLabel(rule.kind)}</span>
					<span className="text-muted-foreground"> on {rule.site || "any site"}</span>
					{rule.match && <span className="text-muted-foreground">, {rule.match}</span>}
				</div>
				<div className="mt-0.5 flex flex-wrap gap-x-3 text-[12px] text-faint">
					<span>{who}</span>
					{rule.expiresAt && <span className="text-tint-text">Approved in advance, {untilLabel(rule.expiresAt)}</span>}
					{rule.source === "always-allow" && <span>From “Always allow”</span>}
					{rule.decision === "allow" && rule.match && <span className="text-warn">Still asks: conditions can't be checked</span>}
					{rule.note && <span className="truncate">{rule.note}</span>}
				</div>
			</div>
			<Segmented<RuleDecision> label="Decision" value={rule.decision} options={DECISIONS} onChange={(d) => void setDecision(d)} />
			<div className="flex gap-1">
				<Button size="xs" variant="ghost" onClick={onEdit}>
					Edit
				</Button>
				<Button
					size="xs"
					variant="ghost"
					className="text-destructive hover:text-destructive"
					onClick={async () => {
						const ok = await requestConfirm({
							title: "Delete this rule?",
							message: "Vos go back to asking first for this kind of action.",
							actionLabel: "Delete",
							destructive: true,
						});
						if (!ok) return;
						const done = await attempt(() => vosCall("DELETE", `/rules/${encodeURIComponent(rule.id)}`));
						if (done !== undefined && vos.rules) {
							vos.rules = vos.rules.filter((r) => r.id !== rule.id);
							bumpVos();
						}
					}}
				>
					Delete
				</Button>
			</div>
		</div>
	);
}

const SECTIONS: { decision: RuleDecision; title: string; detail: string }[] = [
	{ decision: "block", title: "Limits", detail: "What no vos may ever do." },
	{ decision: "ask", title: "Ask first", detail: "What a vos always checks with you." },
	{ decision: "allow", title: "Approved in advance", detail: "What a vos may do without asking, for good or for a while." },
];

/** Auto-review rules: standing limits, what to ask about, and what is approved in advance. */
export function VosRules() {
	const v = useVos();
	const [editing, setEditing] = useState<string | "new" | null>(null);
	const [blank, setBlank] = useState<Draft>({
		kind: "sendMessage",
		site: "",
		decision: "ask",
		note: "",
		match: "",
		vos: "",
		hold: "today",
	});
	const live = (v.rules ?? []).filter((r) => !ruleExpired(r));
	const start = (draft: Partial<Draft>): void => {
		setBlank({ kind: "sendMessage", site: "", decision: "ask", note: "", match: "", vos: "", hold: "today", ...draft });
		setEditing("new");
	};
	const editor = (rule: Rule) => (
		<div key={rule.id} className="border-b p-2 last:border-b-0">
			<RuleEditor
				rule={rule}
				initial={{
					kind: rule.kind,
					site: rule.site,
					decision: rule.decision,
					note: rule.note,
					match: rule.match ?? "",
					vos: rule.vos ?? "",
					hold: rule.expiresAt ? "today" : "always",
				}}
				onDone={() => setEditing(null)}
			/>
		</div>
	);
	return (
		<div className="mx-auto w-full max-w-[860px] px-6 pt-2 pb-10">
			<PageHeader title="Rules" detail="What your vos may do without asking. When two rules match, the stricter one wins.">
				<Button size="sm" variant="outline" onClick={() => start({ decision: "block", kind: "sendMessage" })}>
					Add a limit
				</Button>
				<Button size="sm" variant="outline" onClick={() => start({ decision: "allow", kind: "sendMessage", hold: "today" })}>
					Approve in advance
				</Button>
				<Button size="sm" onClick={() => start({})}>
					<Icon name="plus" />
					New rule
				</Button>
			</PageHeader>
			<div className="flex flex-col gap-5">
				{editing === "new" && <RuleEditor key={JSON.stringify(blank)} initial={blank} onDone={() => setEditing(null)} />}
				{!v.rules && <p className="text-sm text-faint">Loading…</p>}
				{v.rules && live.length === 0 && editing !== "new" && (
					<Empty>No rules yet: every consequential action asks first.</Empty>
				)}
				{SECTIONS.map((section) => {
					const rules = live
						.filter((r) => r.decision === section.decision)
						.sort((a, b) => a.kind.localeCompare(b.kind) || a.site.localeCompare(b.site));
					if (rules.length === 0) return null;
					return (
						<section key={section.decision} className="flex flex-col gap-2">
							<div className="flex items-baseline gap-2 px-1">
								<h3 className="text-[13px] font-semibold">{section.title}</h3>
								<span className="text-[12px] text-faint">{section.detail}</span>
							</div>
							<Card className="p-0">
								{rules.map((rule) =>
									editing === rule.id ? editor(rule) : <RuleRow key={rule.id} rule={rule} onEdit={() => setEditing(rule.id)} />,
								)}
							</Card>
						</section>
					);
				})}
			</div>
		</div>
	);
}
