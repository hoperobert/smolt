import { useState } from "react";
import { ACTION_KINDS, decisionLabel, kindLabel } from "../../../../../coding-agent/src/extensions/vos/format.ts";
import type { ActionKind, Rule, RuleDecision } from "../../../../../coding-agent/src/extensions/vos/types.ts";
import { cn } from "../../lib/cn.ts";
import { requestConfirm } from "../../state/app.ts";
import { attempt, bumpVos, loadRules, useVos, vos, vosCall } from "../../state/vos.ts";
import { Button } from "../ui/button.tsx";
import { Icon } from "../ui/icon.tsx";
import { Input } from "../ui/input.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select.tsx";
import { Card, Empty, Field, PageHeader, Segmented } from "./parts.tsx";

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
			<Segmented<RuleDecision>
				label="Decision"
				value={draft.decision}
				options={DECISIONS}
				onChange={(decision) => setDraft({ ...draft, decision })}
			/>
			<div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
				<Field label="When a vos wants to">
					<Select value={draft.kind} onValueChange={(kind) => setDraft({ ...draft, kind: kind as ActionKind })}>
						<SelectTrigger>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{ACTION_KINDS.map((k) => (
								<SelectItem key={k} value={k}>
									{kindLabel(k)}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</Field>
				<Field label="On">
					<Input value={draft.site} onChange={(e) => setDraft({ ...draft, site: e.target.value })} placeholder="any site" />
				</Field>
				<Field label="Which vos">
					<Select value={draft.vos || "all"} onValueChange={(id) => setDraft({ ...draft, vos: id === "all" ? "" : id })}>
						<SelectTrigger>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="all">All vos</SelectItem>
							{(v.roster?.dots ?? []).map((d) => (
								<SelectItem key={d.id} value={d.id}>
									{d.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
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
				<Field label="Note">
					<Input value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
				</Field>
			</div>
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

/** Auto-review rules: what any vos may do unasked, must ask about, or must never do. */
export function VosRules() {
	const v = useVos();
	const [editing, setEditing] = useState<string | "new" | null>(null);
	const order: Record<RuleDecision, number> = { block: 0, ask: 1, allow: 2 };
	const rules = [...(v.rules ?? [])].sort((a, b) => order[a.decision] - order[b.decision] || a.kind.localeCompare(b.kind));
	const blank: Draft = { kind: "sendMessage", site: "", decision: "ask", note: "", match: "", vos: "" };
	return (
		<div className="mx-auto w-full max-w-[860px] px-6 pt-2 pb-10">
			<PageHeader
				title="Auto-review rules"
				detail="What your vos may do without asking. When two rules match, the stricter one wins."
			>
				<Button size="sm" onClick={() => setEditing("new")}>
					<Icon name="plus" />
					New rule
				</Button>
			</PageHeader>
			<div className="flex flex-col gap-3">
				{editing === "new" && <RuleEditor initial={blank} onDone={() => setEditing(null)} />}
				{!v.rules && <p className="text-sm text-faint">Loading…</p>}
				{v.rules && rules.length === 0 && editing !== "new" && (
					<Empty>No rules yet: every consequential action asks first.</Empty>
				)}
				{rules.length > 0 && (
					<Card className="p-0">
						{rules.map((rule) =>
							editing === rule.id ? (
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
										}}
										onDone={() => setEditing(null)}
									/>
								</div>
							) : (
								<RuleRow key={rule.id} rule={rule} onEdit={() => setEditing(rule.id)} />
							),
						)}
					</Card>
				)}
			</div>
		</div>
	);
}
