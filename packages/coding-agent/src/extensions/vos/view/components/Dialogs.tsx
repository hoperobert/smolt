import { useEffect, useRef, useState } from "react";
import { closeDialog, useVos } from "../store.ts";
import { Button, Input, Textarea } from "../ui.tsx";

/** The view's confirm and question dialogs, drawn over it. */
export function Dialogs() {
	const v = useVos();
	const dialog = v.dialog;
	const [value, setValue] = useState("");
	const field = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
	useEffect(() => {
		if (dialog?.kind === "input") {
			setValue(dialog.initial ?? "");
			requestAnimationFrame(() => field.current?.select());
		}
	}, [dialog]);
	useEffect(() => {
		if (!dialog) return;
		const key = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			if (dialog.kind === "confirm") dialog.resolve(false);
			else dialog.resolve(null);
			closeDialog();
		};
		document.addEventListener("keydown", key);
		return () => document.removeEventListener("keydown", key);
	}, [dialog]);
	if (!dialog) return null;
	const finish = (ok: boolean): void => {
		if (dialog.kind === "confirm") dialog.resolve(ok);
		else dialog.resolve(ok ? value : null);
		closeDialog();
	};
	return (
		<div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-6" role="presentation">
			<form
				role="dialog"
				aria-modal="true"
				aria-label={dialog.title}
				className="w-full max-w-[420px] rounded-2xl border bg-popover p-5 text-popover-foreground shadow-[0_24px_64px_-24px_rgba(var(--shadow-rgb),0.6)]"
				onSubmit={(event) => {
					event.preventDefault();
					finish(true);
				}}
			>
				<h2 className="text-[15px] font-semibold">{dialog.title}</h2>
				{dialog.message && <p className="mt-1.5 text-[13px] whitespace-pre-wrap text-muted-foreground">{dialog.message}</p>}
				{dialog.kind === "input" &&
					(dialog.multiline ? (
						<Textarea
							ref={field}
							rows={4}
							className="mt-3"
							value={value}
							placeholder={dialog.placeholder}
							onChange={(e) => setValue(e.target.value)}
						/>
					) : (
						<Input
							ref={field}
							className="mt-3"
							value={value}
							placeholder={dialog.placeholder}
							onChange={(e) => setValue(e.target.value)}
						/>
					))}
				<div className="mt-4 flex justify-end gap-2">
					<Button size="sm" variant="ghost" onClick={() => finish(false)}>
						Cancel
					</Button>
					<Button
						type="submit"
						size="sm"
						variant={dialog.kind === "confirm" && dialog.destructive ? "destructive" : "default"}
						// biome-ignore lint/a11y/noAutofocus: the dialog's one action
						autoFocus={dialog.kind === "confirm"}
					>
						{dialog.actionLabel ?? (dialog.kind === "confirm" ? "OK" : "Save")}
					</Button>
				</div>
			</form>
		</div>
	);
}
