import { useState } from "react";
import { ago } from "../../format.ts";
import type { MemoryNote } from "../../types.ts";
import { attempt, bumpVos, requestConfirm, useVos, vos, vosCall } from "../store.ts";
import { Button, Icon, Textarea } from "../ui.tsx";
import { Card, Empty, PageHeader } from "./parts.tsx";

const noteOf = (value: MemoryNote | { note: MemoryNote }): MemoryNote => ("note" in value ? value.note : value);

function NoteRow({ dot, note }: { dot: string; note: MemoryNote }) {
	const [editing, setEditing] = useState(false);
	const [text, setText] = useState(note.text);
	const [busy, setBusy] = useState(false);
	const save = async (): Promise<void> => {
		setBusy(true);
		const next = await attempt(() =>
			vosCall<MemoryNote | { note: MemoryNote }>("PATCH", `/memory/${encodeURIComponent(note.id)}`, { text: text.trim() }, dot),
		);
		setBusy(false);
		if (!next) return;
		vos.memory.set(dot, (vos.memory.get(dot) ?? []).map((n) => (n.id === note.id ? noteOf(next) : n)));
		setEditing(false);
		bumpVos();
	};
	const when = note.updatedAt ?? note.date ?? note.createdAt;
	return (
		<div className="group/note flex items-start gap-3 border-b px-4 py-3 last:border-b-0">
			<span className="mt-[7px] size-1.5 flex-none rounded-full bg-tint" aria-hidden />
			<div className="min-w-0 flex-1">
				{editing ? (
					<form
						className="flex flex-col gap-2"
						onSubmit={(event) => {
							event.preventDefault();
							void save();
						}}
					>
						<Textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} />
						<div className="flex justify-end gap-2">
							<Button
								size="xs"
								variant="ghost"
								onClick={() => {
									setText(note.text);
									setEditing(false);
								}}
							>
								Cancel
							</Button>
							<Button type="submit" size="xs" disabled={busy || !text.trim() || text.trim() === note.text}>
								Save
							</Button>
						</div>
					</form>
				) : (
					<>
						<p className="text-[13.5px] leading-relaxed whitespace-pre-wrap">{note.text}</p>
						<div className="mt-0.5 flex gap-3 text-[12px] text-faint">
							{note.source && <span>{note.source}</span>}
							{when && <span>{ago(when)}</span>}
						</div>
					</>
				)}
			</div>
			{!editing && (
				<div className="flex flex-none gap-1 opacity-60 transition-opacity group-hover/note:opacity-100">
					<Button size="xs" variant="ghost" onClick={() => setEditing(true)}>
						Edit
					</Button>
					<Button
						size="xs"
						variant="ghost"
						className="text-destructive hover:text-destructive"
						onClick={async () => {
							const ok = await requestConfirm({
								title: "Forget this?",
								message: note.text,
								actionLabel: "Forget",
								destructive: true,
							});
							if (!ok) return;
							const done = await attempt(() => vosCall("DELETE", `/memory/${encodeURIComponent(note.id)}`, undefined, dot));
							if (done === undefined) return;
							vos.memory.set(dot, (vos.memory.get(dot) ?? []).filter((n) => n.id !== note.id));
							bumpVos();
						}}
					>
						Forget
					</Button>
				</div>
			)}
		</div>
	);
}

/** What a vos remembers about the user: add, edit and forget notes. */
export function VosMemory({ dot, name }: { dot: string; name: string }) {
	const v = useVos();
	const [text, setText] = useState("");
	const [busy, setBusy] = useState(false);
	const [query, setQuery] = useState("");
	const notes = v.memory.get(dot);
	const q = query.trim().toLowerCase();
	const shown = (notes ?? []).filter((n) => !q || n.text.toLowerCase().includes(q));
	const add = async (): Promise<void> => {
		if (!text.trim()) return;
		setBusy(true);
		const note = await attempt(() =>
			vosCall<MemoryNote | { note: MemoryNote }>("POST", "/memory", { text: text.trim() }, dot),
		);
		setBusy(false);
		if (!note) return;
		const added = noteOf(note);
		vos.memory.set(dot, [added, ...(vos.memory.get(dot) ?? []).filter((n) => n.id !== added.id)]);
		setText("");
		bumpVos();
	};
	return (
		<div className="mx-auto w-full max-w-[760px] px-6 pt-2 pb-10">
			<PageHeader title="Memory" detail={`What ${name} remembers about you. It reads these before every task.`} />
			<Card className="mb-4 flex flex-col gap-2">
				<form
					className="flex flex-col gap-2 sm:flex-row sm:items-end"
					onSubmit={(event) => {
						event.preventDefault();
						void add();
					}}
				>
					<Textarea
						rows={2}
						value={text}
						placeholder="I prefer meetings after 10am."
						onChange={(e) => setText(e.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter" && !event.shiftKey) {
								event.preventDefault();
								void add();
							}
						}}
					/>
					<Button type="submit" size="sm" className="h-9" disabled={busy || !text.trim()}>
						<Icon name="plus" />
						Remember
					</Button>
				</form>
			</Card>
			{notes && notes.length > 6 && (
				<input
					type="search"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					placeholder="Search memory"
					className="mb-3 h-9 w-full rounded-lg border bg-transparent px-3 text-sm placeholder:text-faint focus-visible:border-border-strong focus-visible:outline-none"
				/>
			)}
			{!notes && <p className="text-sm text-faint">Loading…</p>}
			{notes && notes.length === 0 && <Empty>{name} remembers nothing yet. Tell it something above, or in chat.</Empty>}
			{shown.length > 0 && (
				<Card className="p-0">
					{shown.map((note) => (
						<NoteRow key={note.id} dot={dot} note={note} />
					))}
				</Card>
			)}
		</div>
	);
}
