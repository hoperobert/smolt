import { useEffect, useState } from "react";
import { ago, sectionNames, vosColor } from "../../format.ts";
import type { Dot, Group, Share } from "../../types.ts";
import { bridge } from "../bridge.ts";
import {
	attempt,
	bumpVos,
	loadShares,
	openVos,
	refreshRoster,
	requestConfirm,
	requestInput,
	selectThread,
	useVos,
	vos,
	vosCall,
} from "../store.ts";
import { Button, cn, Input, Switch, Textarea } from "../ui.tsx";
import { Card, Field, PageHeader, VosAvatar } from "./parts.tsx";

const SWATCHES = ["sky", "blue", "teal", "mint", "lime", "lemon", "orange", "coral", "rose", "lilac", "grape", "slate"];

interface Draft {
	name: string;
	label: string;
	personality: string;
	job: string;
	rules: string;
	color: string;
}

const toDraft = (d: Dot): Draft => ({
	name: d.name,
	label: d.label ?? "",
	personality: d.personality ?? "",
	job: d.job ?? "",
	rules: d.rules ?? "",
	color: typeof d.look?.color === "string" ? d.look.color : "sky",
});

function ShareCard({ dot }: { dot: Dot }) {
	const v = useVos();
	const [fresh, setFresh] = useState<string | null>(null);
	const [copied, setCopied] = useState<string | null>(null);
	const mine = (v.shares ?? []).filter((s) => s.vos === dot.id);
	return (
		<Card>
			<div className="flex items-start justify-between gap-3">
				<div>
					<div className="text-[14px] font-medium">Share {dot.name}</div>
					<p className="mt-0.5 text-[13px] text-muted-foreground">
						A link with its profile, the skills it made and its routines (switched off). Never its chats, memories,
						computers, logins or secrets.
					</p>
				</div>
				<Button
					size="sm"
					variant="outline"
					className="flex-none"
					onClick={async () => {
						const share = await attempt(() => vosCall<Share>("POST", `/dots/${encodeURIComponent(dot.id)}/share`, {}));
						if (share) {
							setFresh(share.code);
							await loadShares();
						}
					}}
				>
					Make a link
				</Button>
			</div>
			{mine.length > 0 && (
				<ul className="mt-3 flex flex-col gap-1.5">
					{mine.map((share) => (
						<li
							key={share.code}
							className={cn(
								"flex items-center gap-2 rounded-lg px-3 py-1.5 text-[12.5px] transition-colors",
								share.code === fresh ? "bg-tint/10" : "bg-background/60",
							)}
						>
							<code className="min-w-0 flex-1 truncate font-mono text-muted-foreground">{share.url}</code>
							{share.createdAt && <span className="flex-none text-[11.5px] text-faint">{ago(share.createdAt)}</span>}
							<Button
								size="xs"
								variant="ghost"
								onClick={async () => {
									await bridge.copy(share.url).catch(() => {});
									setCopied(share.code);
									setTimeout(() => setCopied((c) => (c === share.code ? null : c)), 1500);
								}}
							>
								{copied === share.code ? "Copied" : "Copy"}
							</Button>
							<Button
								size="xs"
								variant="ghost"
								className="text-destructive hover:text-destructive"
								onClick={async () => {
									const done = await attempt(() => vosCall("DELETE", `/shares/${encodeURIComponent(share.code)}`));
									if (done !== undefined) await loadShares();
								}}
							>
								Revoke
							</Button>
						</li>
					))}
				</ul>
			)}
		</Card>
	);
}

function ImportCard() {
	const [link, setLink] = useState("");
	const [busy, setBusy] = useState(false);
	return (
		<Card>
			<div className="text-[14px] font-medium">Add a vos from a link</div>
			<p className="mt-0.5 text-[13px] text-muted-foreground">Paste a share link (or its code) someone sent you.</p>
			<form
				className="mt-3 flex gap-2"
				onSubmit={async (event) => {
					event.preventDefault();
					setBusy(true);
					const text = link.trim();
					const dot = await attempt(() =>
						vosCall<Dot>("POST", "/dots/import", text.includes("/") ? { url: text } : { code: text }),
					);
					setBusy(false);
					if (dot) {
						setLink("");
						await refreshRoster();
						openVos(dot.id, "profile");
					}
				}}
			>
				<Input value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://vos-api.vosgrau.com/share/…" />
				<Button type="submit" size="sm" className="h-9" disabled={busy || !link.trim()}>
					Import
				</Button>
			</form>
		</Card>
	);
}

/** Where the roster files this vos: a section of its own, shared with others, or none. */
function SectionCard({ dot, patch }: { dot: Dot; patch: (body: Record<string, unknown>) => Promise<boolean> }) {
	const v = useVos();
	const [section, setSection] = useState(dot.section ?? "");
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset when the vos changes
	useEffect(() => setSection(dot.section ?? ""), [dot.id, dot.section]);
	const names = sectionNames(v.roster?.dots ?? []);
	const dirty = section.trim() !== (dot.section ?? "");
	return (
		<Card className="flex flex-col gap-3">
			<div>
				<div className="text-[14px] font-medium">Section</div>
				<div className="text-[13px] text-muted-foreground">Group vos in the roster by project or client.</div>
			</div>
			<form
				className="flex gap-2"
				onSubmit={async (event) => {
					event.preventDefault();
					await patch({ section: section.trim() || null });
				}}
			>
				<Input
					value={section}
					list="vos-sections"
					onChange={(e) => setSection(e.target.value)}
					placeholder="No section"
					maxLength={40}
				/>
				<datalist id="vos-sections">
					{names.map((name) => (
						<option key={name} value={name} />
					))}
				</datalist>
				<Button type="submit" size="sm" className="h-9" disabled={!dirty}>
					{section.trim() ? "Move" : "Clear"}
				</Button>
			</form>
		</Card>
	);
}

/** A vos's profile: who it is, its standing rules, section, pin/hide, duplicate, share, delete. */
export function VosProfile({ dot }: { dot: Dot }) {
	const [draft, setDraft] = useState(() => toDraft(dot));
	const [busy, setBusy] = useState(false);
	// Another vos picked, or the server sent a newer profile: start from it.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset when the vos changes
	useEffect(() => setDraft(toDraft(dot)), [dot.id]);
	useEffect(() => {
		void loadShares();
	}, []);
	const dirty = JSON.stringify(draft) !== JSON.stringify(toDraft(dot));
	const patch = async (body: Record<string, unknown>): Promise<boolean> => {
		const next = await attempt(() => vosCall<Dot>("PATCH", `/dots/${encodeURIComponent(dot.id)}`, body));
		if (next) await refreshRoster();
		return !!next;
	};
	const set = (key: keyof Draft) => (e: { target: { value: string } }) => setDraft({ ...draft, [key]: e.target.value });

	return (
		<div className="mx-auto w-full max-w-[760px] px-6 pt-2 pb-10">
			<PageHeader title="Profile" detail="Who this vos is and how it works. Changes apply from its next turn." />
			<div className="flex flex-col gap-4">
				<Card className="flex flex-col gap-4">
					<div className="flex items-center gap-4">
						<VosAvatar name={draft.name || dot.name} look={{ ...dot.look, color: draft.color }} id={dot.id} size={52} />
						<div className="flex flex-wrap gap-1.5">
							{SWATCHES.map((color) => (
								<button
									key={color}
									type="button"
									title={color}
									aria-label={`Colour ${color}`}
									aria-pressed={draft.color === color}
									onClick={() => setDraft({ ...draft, color })}
									className={cn(
										"size-6 rounded-full transition-transform hover:scale-110",
										draft.color === color && "ring-2 ring-foreground ring-offset-2 ring-offset-card",
									)}
									style={{ background: vosColor({ color }) }}
								/>
							))}
						</div>
					</div>
					<div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_200px]">
						<Field label="Name">
							<Input value={draft.name} onChange={set("name")} maxLength={40} />
						</Field>
						<Field label="Label">
							<Input value={draft.label} onChange={set("label")} placeholder="Research" maxLength={24} />
						</Field>
					</div>
					<Field label="Personality" hint="How it comes across.">
						<Textarea rows={2} value={draft.personality} onChange={set("personality")} />
					</Field>
					<Field label="Job" hint="What it's for.">
						<Textarea rows={2} value={draft.job} onChange={set("job")} />
					</Field>
					<Field label="Standing rules" hint="Always in its instructions, in your words. Only safety comes first.">
						<Textarea rows={3} value={draft.rules} onChange={set("rules")} placeholder="Never book anything before 9am." />
					</Field>
					<div className="flex justify-end gap-2">
						<Button size="sm" variant="ghost" disabled={!dirty} onClick={() => setDraft(toDraft(dot))}>
							Reset
						</Button>
						<Button
							size="sm"
							disabled={!dirty || busy || !draft.name.trim()}
							onClick={async () => {
								setBusy(true);
								await patch({
									name: draft.name.trim(),
									label: draft.label.trim(),
									personality: draft.personality.trim(),
									job: draft.job.trim(),
									rules: draft.rules.trim(),
									look: { ...dot.look, color: draft.color },
								});
								setBusy(false);
							}}
						>
							{busy ? "Saving…" : "Save"}
						</Button>
					</div>
				</Card>

				<Card className="flex flex-col gap-3">
					<div className="flex items-center justify-between gap-3">
						<div>
							<div className="text-[14px] font-medium">Pinned</div>
							<div className="text-[13px] text-muted-foreground">Shown first in the roster.</div>
						</div>
						<Switch checked={!!dot.pinned} onCheckedChange={(pinned) => void patch({ pinned })} aria-label="Pinned" />
					</div>
					<div className="flex items-center justify-between gap-3 border-t pt-3">
						<div>
							<div className="text-[14px] font-medium">Hidden</div>
							<div className="text-[13px] text-muted-foreground">
								Folded away under “Hidden”. Its routines keep running.
							</div>
						</div>
						<Switch checked={!!dot.hidden} onCheckedChange={(hidden) => void patch({ hidden })} aria-label="Hidden" />
					</div>
				</Card>

				<SectionCard dot={dot} patch={patch} />

				<ShareCard dot={dot} />
				<ImportCard />

				<Card className="flex flex-wrap items-center justify-between gap-3">
					<div>
						<div className="text-[14px] font-medium">{dot.id === "main" ? "Duplicate" : "Duplicate or delete"}</div>
						<div className="text-[13px] text-muted-foreground">
							A copy keeps the profile, settings, skills, routines and look; never its memory, chats, computers or logins.
						</div>
					</div>
					<div className="flex gap-2">
						<Button
							size="sm"
							variant="outline"
							onClick={async () => {
								const name = await requestInput({ title: `Duplicate ${dot.name}`, initial: `${dot.name} 2` });
								if (name === null) return;
								const copy = await attempt(() =>
									vosCall<Dot>("POST", `/dots/${encodeURIComponent(dot.id)}/duplicate`, { name: name.trim() || undefined }),
								);
								if (copy) {
									await refreshRoster();
									openVos(copy.id, "profile");
								}
							}}
						>
							Duplicate
						</Button>
						{/* The main vos stays: deleted vos's computers return to it, and the server refuses. */}
						{dot.id !== "main" && (
						<Button
							size="sm"
							variant="outline"
							className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
							onClick={async () => {
								const ok = await requestConfirm({
									title: `Delete ${dot.name}?`,
									message:
										"Its chats and routines go, and its computers return to your main vos. This cannot be undone.",
									actionLabel: "Delete",
									destructive: true,
								});
								if (!ok) return;
								const done = await attempt(() => vosCall("DELETE", `/dots/${encodeURIComponent(dot.id)}`));
								if (done !== undefined) {
									vos.selected = null;
									bumpVos();
									await refreshRoster();
									openVos();
								}
							}}
						>
							Delete
						</Button>
						)}
					</div>
				</Card>
			</div>
		</div>
	);
}

/** A group chat's settings: its name, who is in it (first is the lead), delete. */
export function GroupSettings({ group }: { group: Group }) {
	const v = useVos();
	const [name, setName] = useState(group.name);
	const [members, setMembers] = useState(group.members);
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset when the group changes
	useEffect(() => {
		setName(group.name);
		setMembers(group.members);
	}, [group.id]);
	const dots = v.roster?.dots ?? [];
	const dirty = name !== group.name || members.join() !== group.members.join();
	return (
		<div className="mx-auto w-full max-w-[760px] px-6 pt-2 pb-10">
			<PageHeader title="Group" detail="Messages go to the vos you @mention, else to the lead." />
			<div className="flex flex-col gap-4">
				<Card className="flex flex-col gap-4">
					<Field label="Name">
						<Input value={name} onChange={(e) => setName(e.target.value)} />
					</Field>
					<div className="flex flex-col gap-1.5">
						<span className="text-[12px] font-medium text-muted-foreground">Members</span>
						{dots.map((d) => {
							const index = members.indexOf(d.id);
							return (
								<div key={d.id} className="flex items-center gap-3 rounded-lg px-1 py-1">
									<input
										type="checkbox"
										checked={index !== -1}
										aria-label={`${d.name} in the group`}
										className="size-4 accent-[var(--primary)]"
										onChange={(e) =>
											setMembers(e.target.checked ? [...members, d.id] : members.filter((id) => id !== d.id))
										}
									/>
									<VosAvatar name={d.name} look={d.look} id={d.id} size={22} />
									<span className="flex-1 text-[13.5px]">{d.name}</span>
									{index === 0 && <span className="text-[12px] text-faint">Lead</span>}
									{index > 0 && (
										<Button
											size="xs"
											variant="ghost"
											onClick={() => setMembers([d.id, ...members.filter((id) => id !== d.id)])}
										>
											Make lead
										</Button>
									)}
								</div>
							);
						})}
					</div>
					<div className="flex justify-end gap-2">
						<Button
							size="sm"
							disabled={!dirty || !name.trim() || members.length === 0}
							onClick={async () => {
								const next = await attempt(() =>
									vosCall<Group>("PATCH", `/groups/${encodeURIComponent(group.id)}`, { name: name.trim(), members }),
								);
								if (next) await refreshRoster();
							}}
						>
							Save
						</Button>
					</div>
				</Card>
				<Card className="flex items-center justify-between gap-3">
					<div>
						<div className="text-[14px] font-medium">Delete this group</div>
						<div className="text-[13px] text-muted-foreground">The vos stay; the group's thread goes.</div>
					</div>
					<Button
						size="sm"
						variant="outline"
						className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
						onClick={async () => {
							const ok = await requestConfirm({
								title: `Delete ${group.name}?`,
								message: "Its messages go with it.",
								actionLabel: "Delete",
								destructive: true,
							});
							if (!ok) return;
							const done = await attempt(() => vosCall("DELETE", `/groups/${encodeURIComponent(group.id)}`));
							if (done !== undefined) {
								await refreshRoster();
								const first = vos.roster?.dots.find((d) => !d.hidden);
								if (first) void selectThread(first.id);
							}
						}}
					>
						Delete
					</Button>
				</Card>
			</div>
		</div>
	);
}
