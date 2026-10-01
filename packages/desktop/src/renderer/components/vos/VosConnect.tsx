import { useEffect, useMemo, useState } from "react";
import { DEFAULT_VOS_URL } from "../../../../../coding-agent/src/extensions/vos/client.ts";
import { encodeQr, qrSvgPath } from "../../../../../coding-agent/src/extensions/vos/qr.ts";
import { cn } from "../../lib/cn.ts";
import { cancelPair, connectVos, startPair, useVos } from "../../state/vos.ts";
import { Button } from "../ui/button.tsx";
import { Icon } from "../ui/icon.tsx";
import { Input } from "../ui/input.tsx";
import { Field } from "./parts.tsx";

/** The pairing QR, drawn here: black modules on a white card, so it scans in either theme. */
function PairQr({ text, faded }: { text: string; faded: boolean }) {
	const { path, size } = useMemo(() => {
		const matrix = encodeQr(text, "M");
		return { path: qrSvgPath(matrix, 3), size: matrix.length + 6 };
	}, [text]);
	return (
		<div
			className={cn(
				"rounded-2xl bg-white p-2 shadow-[0_1px_2px_rgba(var(--shadow-rgb),0.12),0_12px_32px_-16px_rgba(var(--shadow-rgb),0.35)] transition-opacity",
				faded && "opacity-25",
			)}
		>
			<svg
				role="img"
				aria-label="QR code to scan with the Vos app"
				viewBox={`0 0 ${size} ${size}`}
				width={216}
				height={216}
				shapeRendering="crispEdges"
			>
				<path d={path} fill="#111113" />
			</svg>
		</div>
	);
}

function useNow(active: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [active]);
	return now;
}

/**
 * Connect smolt to the user's Vos. It leads with pairing: a QR the phone
 * scans and approves with Face ID, after which the main process receives a
 * device key of its own and keeps it encrypted. An API key can still be
 * pasted instead; either way the key never stays on this page.
 */
export function VosConnect() {
	const v = useVos();
	const [url, setUrl] = useState(v.connection?.url ?? DEFAULT_VOS_URL);
	const [editingServer, setEditingServer] = useState(false);
	const [mode, setMode] = useState<"pair" | "key">("pair");
	const [key, setKey] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(v.connection?.error ?? null);
	const pair = v.pair;
	const waiting = pair?.state === "waiting";
	const now = useNow(waiting);
	const left = pair?.expiresAt ? Math.max(0, Math.round((Date.parse(pair.expiresAt) - now) / 1000)) : 0;

	// Pairing starts on its own, and a code that ran out is replaced.
	// biome-ignore lint/correctness/useExhaustiveDependencies: restart only on mode or expiry
	useEffect(() => {
		if (mode !== "pair" || editingServer) return;
		if (!pair || pair.state === "expired") void startPair(url);
	}, [mode, editingServer, pair?.state]);
	// Leaving the screen stops the polling.
	useEffect(() => () => cancelPair(), []);

	const submit = async (): Promise<void> => {
		setBusy(true);
		setError(null);
		const failure = await connectVos(url, key).catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
		setKey("");
		setBusy(false);
		if (failure) setError(failure);
	};

	const host = url.replace(/^https?:\/\//, "").replace(/\/$/, "");
	const digits = pair?.short ? `${pair.short.slice(0, 3)} ${pair.short.slice(3)}` : "";

	return (
		<div className="flex flex-1 items-center justify-center overflow-y-auto p-8">
			<div className="flex w-full max-w-[400px] flex-col items-center gap-6 text-center">
				<div className="flex flex-col items-center gap-2">
					<h1 className="text-[20px] font-semibold tracking-[-0.015em]">
						{mode === "pair" ? "Connect with your iPhone" : "Connect with an API key"}
					</h1>
					<p className="max-w-[36ch] text-[13.5px] leading-relaxed text-muted-foreground">
						{mode === "pair"
							? "Scan the code with your iPhone's camera, or in the Vos app, and approve with Face ID."
							: "Paste a Vos API key. smolt keeps it encrypted by your operating system's keystore."}
					</p>
				</div>

				{mode === "pair" && !editingServer && (
					<div className="flex flex-col items-center gap-4">
						{pair?.qr ? (
							<PairQr text={pair.qr} faded={pair.state === "expired" || pair.state === "denied"} />
						) : (
							<div className="flex size-[232px] items-center justify-center rounded-2xl border border-dashed text-faint">
								{pair?.state === "error" ? (
									<Icon name="info" className="[&>svg]:size-6" />
								) : (
									<Icon name="spinner" className="animate-spin [&>svg]:size-6" />
								)}
							</div>
						)}
						{digits && pair?.state === "waiting" && (
							<div className="flex flex-col items-center gap-1">
								<span className="font-mono text-[26px] font-semibold tracking-[0.18em] tabular-nums">{digits}</span>
								<span className="text-[12px] text-faint">or enter this code in the Vos app</span>
							</div>
						)}
						<div
							role="status"
							aria-live="polite"
							className={cn(
								"flex items-center gap-2 rounded-full px-3 py-1 text-[12.5px]",
								pair?.state === "approved" && "bg-ok/12 text-ok",
								pair?.state === "denied" && "bg-destructive/10 text-destructive",
								(pair?.state === "waiting" || pair?.state === "starting") && "bg-card text-muted-foreground",
								pair?.state === "error" && "bg-destructive/10 text-destructive",
							)}
						>
							{pair?.state === "waiting" && (
								<>
									<span className="size-1.5 animate-pulse-soft rounded-full bg-tint" />
									Waiting for your phone…
									<span className="font-mono tabular-nums text-faint">
										{Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}
									</span>
								</>
							)}
							{pair?.state === "starting" && "Getting a code…"}
							{pair?.state === "approved" && (
								<>
									<Icon name="check" className="[&>svg]:size-3.5" />
									Approved — connecting
								</>
							)}
							{pair?.state === "denied" && "Declined on the phone"}
							{pair?.state === "error" && (pair.error ?? "Could not start pairing")}
						</div>
						{(pair?.state === "denied" || pair?.state === "error") && (
							<Button size="sm" variant="outline" onClick={() => void startPair(url)}>
								Try again
							</Button>
						)}
					</div>
				)}

				{mode === "pair" && editingServer && (
					<form
						className="flex w-full flex-col gap-3 text-left"
						onSubmit={(event) => {
							event.preventDefault();
							setEditingServer(false);
							void startPair(url);
						}}
					>
						<Field label="Server">
							<Input value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} autoComplete="off" />
						</Field>
						<Button type="submit" size="sm">
							Use this server
						</Button>
					</form>
				)}

				{mode === "key" && (
					<form
						className="flex w-full flex-col gap-4 text-left"
						onSubmit={(event) => {
							event.preventDefault();
							void submit();
						}}
					>
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
								placeholder="Paste your key"
								spellCheck={false}
								autoComplete="off"
								// biome-ignore lint/a11y/noAutofocus: the one field this form is for
								autoFocus
							/>
						</Field>
						{error && (
							<p
								role="alert"
								className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-[13px] text-destructive"
							>
								{error}
							</p>
						)}
						<Button type="submit" disabled={busy || !key.trim()}>
							{busy ? "Checking…" : "Connect"}
						</Button>
					</form>
				)}

				<div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-[12.5px] text-faint">
					{mode === "pair" ? (
						<>
							<button
								type="button"
								className="hover:text-foreground"
								onClick={() => {
									cancelPair();
									setMode("key");
								}}
							>
								Use an API key instead
							</button>
							<span aria-hidden>·</span>
							<button type="button" className="hover:text-foreground" onClick={() => setEditingServer(!editingServer)}>
								{host}
							</button>
						</>
					) : (
						<button type="button" className="hover:text-foreground" onClick={() => setMode("pair")}>
							Connect with your iPhone instead
						</button>
					)}
				</div>
			</div>
		</div>
	);
}
