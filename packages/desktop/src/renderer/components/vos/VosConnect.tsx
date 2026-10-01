import { useState } from "react";
import { DEFAULT_VOS_URL } from "../../../../../coding-agent/src/extensions/vos/client.ts";
import { connectVos, useVos } from "../../state/vos.ts";
import { Button } from "../ui/button.tsx";
import { Input } from "../ui/input.tsx";
import { Field } from "./parts.tsx";

/**
 * Connect smolt to the user's Vos. The key is pasted here once and handed
 * to the main process, which checks it, encrypts it with the operating
 * system's keystore and keeps it; this page drops its copy straight away.
 */
export function VosConnect() {
	const v = useVos();
	const [url, setUrl] = useState(v.connection?.url ?? DEFAULT_VOS_URL);
	const [key, setKey] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(v.connection?.error ?? null);

	const submit = async (): Promise<void> => {
		setBusy(true);
		setError(null);
		const failure = await connectVos(url, key).catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
		setKey("");
		setBusy(false);
		if (failure) setError(failure);
	};

	return (
		<div className="flex flex-1 items-center justify-center overflow-y-auto p-8">
			<form
				className="flex w-full max-w-[420px] flex-col gap-5"
				onSubmit={(event) => {
					event.preventDefault();
					void submit();
				}}
			>
				<div className="flex flex-col items-center gap-3 text-center">
					<div className="flex -space-x-2">
						{["#5aa9f5", "#f26f5e", "#4cc78f"].map((color) => (
							<span
								key={color}
								aria-hidden
								className="size-9 rounded-full ring-4 ring-background"
								style={{ background: `linear-gradient(160deg, color-mix(in oklab, ${color} 80%, white), ${color})` }}
							/>
						))}
					</div>
					<h1 className="text-[19px] font-semibold tracking-[-0.015em]">Connect your vos</h1>
					<p className="max-w-[34ch] text-[13.5px] leading-relaxed text-muted-foreground">
						Chat with your teammates, run their routines and skills, and watch their computers from smolt.
					</p>
				</div>
				<Field label="Server">
					<Input value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} autoComplete="off" />
				</Field>
				<Field
					label="API key"
					hint={
						v.connection?.canPersist === false
							? "This system has no keystore smolt can use, so the key is kept for this session only."
							: "Stored encrypted by your operating system's keystore, and only ever sent to this server."
					}
				>
					<Input
						type="password"
						value={key}
						onChange={(e) => setKey(e.target.value)}
						placeholder={v.connection?.keySource === "encrypted" ? "Saved — paste a new one to replace it" : "Paste your key"}
						spellCheck={false}
						autoComplete="off"
						// biome-ignore lint/a11y/noAutofocus: the one field this page is for
						autoFocus
					/>
				</Field>
				{error && (
					<p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-[13px] text-destructive">
						{error}
					</p>
				)}
				<Button type="submit" disabled={busy || (!key.trim() && v.connection?.keySource !== "encrypted")}>
					{busy ? "Checking…" : "Connect"}
				</Button>
				<p className="text-center text-[12px] text-faint">
					In the terminal, <code className="font-mono">/vos connect</code> explains the TUI's setup.
				</p>
			</form>
		</div>
	);
}
