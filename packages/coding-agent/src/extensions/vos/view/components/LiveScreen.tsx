import { useEffect, useRef, useState } from "react";
import type { VosCallResult } from "../../types.ts";
import type { Screen } from "../../types.ts";
import { bridge } from "../bridge.ts";
import { useVos, vosCall } from "../store.ts";
import { cn } from "../ui.tsx";

/** A data URL for a /screens snapshot: the field says JPEG, the bytes may say otherwise. */
export function screenImage(screen: Pick<Screen, "jpegBase64">): string | undefined {
	const b64 = screen.jpegBase64;
	if (!b64) return undefined;
	const type = b64.startsWith("iVBOR") ? "image/png" : b64.startsWith("R0lGOD") ? "image/gif" : "image/jpeg";
	return `data:${type};base64,${b64}`;
}

const KEYS = new Set(["Enter", "Backspace", "Tab", "Escape", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Delete"]);

/**
 * A vos's computer, live. Frames come over the extension's WebSocket to
 * /v1/computer/live; when that cannot open, it falls back to /v1/screens
 * snapshots about once a second. With `interactive`, clicks, scrolls and keys
 * go back to the computer (the user is driving, as in Teach a task).
 */
export function LiveScreen({ dot, interactive = false, className }: { dot: string; interactive?: boolean; className?: string }) {
	const v = useVos();
	const [snapshot, setSnapshot] = useState<string | undefined>();
	const [fallback, setFallback] = useState(false);
	const box = useRef<HTMLDivElement>(null);
	const live = v.live.get(dot);
	const frame = v.frames.get(dot);

	useEffect(() => {
		let stopped = false;
		const open = async (): Promise<void> => {
			const result = (await bridge.request("liveOpen", { dot }).catch(() => ({ ok: false }))) as Pick<
				VosCallResult,
				"ok"
			>;
			if (!stopped && !result.ok) setFallback(true);
		};
		void open();
		const renew = setInterval(() => void open(), 15_000);
		return () => {
			stopped = true;
			clearInterval(renew);
			void bridge.request("liveClose", { dot }).catch(() => {});
		};
	}, [dot]);

	useEffect(() => {
		if (live === "unavailable" || live === "closed") setFallback(true);
	}, [live]);

	useEffect(() => {
		if (!fallback) return;
		let stopped = false;
		const poll = async (): Promise<void> => {
			const value = await vosCall<{ screens?: Screen[] }>("GET", "/screens").catch(() => undefined);
			const screen = value?.screens?.find((s) => s.id === dot);
			if (!stopped && screen) setSnapshot(screenImage(screen));
		};
		void poll();
		const timer = setInterval(() => void poll(), 1200);
		return () => {
			stopped = true;
			clearInterval(timer);
		};
	}, [fallback, dot]);

	const image = frame && !fallback ? frame.image : (snapshot ?? frame?.image);
	const point = (event: { clientX: number; clientY: number }) => {
		const rect = box.current?.getBoundingClientRect();
		if (!rect) return { x: 0.5, y: 0.5 };
		return {
			x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
			y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
		};
	};
	const input = (payload: Record<string, unknown>): void => {
		// Over the live line when it is open; otherwise the plain API takes the same fields.
		if (live === "open" && !fallback) void bridge.request("liveInput", { dot, input: payload }).catch(() => {});
		else void vosCall("POST", "/computer/input", payload, dot).catch(() => {});
	};

	return (
		<div
			ref={box}
			// biome-ignore lint/a11y/noNoninteractiveTabindex: while driving, keys go to the remote computer
			tabIndex={interactive ? 0 : undefined}
			className={cn(
				"relative overflow-hidden rounded-xl border bg-background-deep",
				interactive && "cursor-crosshair focus-visible:ring-2 focus-visible:ring-ring",
				className,
			)}
			style={{ aspectRatio: frame ? `${frame.w} / ${frame.h}` : "16 / 10" }}
			onClick={interactive ? (e) => input({ kind: "tap", ...point(e) }) : undefined}
			onWheel={interactive ? (e) => input({ kind: "scroll", ...point(e), dy: Math.sign(e.deltaY) * 3 }) : undefined}
			onKeyDown={
				interactive
					? (e) => {
							if (e.ctrlKey || e.metaKey) return;
							e.preventDefault();
							if (KEYS.has(e.key)) input({ kind: "key", keys: e.key });
							else if (e.key.length === 1) input({ kind: "type", text: e.key });
						}
					: undefined
			}
		>
			{image ? (
				<img src={image} alt="The vos's screen" className="size-full object-contain" draggable={false} />
			) : (
				<div className="flex size-full items-center justify-center text-[13px] text-faint">
					{fallback ? "Not at a computer right now" : "Connecting to the screen…"}
				</div>
			)}
			<span
				className={cn(
					"absolute top-2 left-2 rounded-full px-2 py-0.5 text-[10.5px] font-semibold tracking-wide uppercase backdrop-blur",
					live === "open" && !fallback ? "bg-destructive/85 text-white" : "bg-black/45 text-white/85",
				)}
			>
				{live === "open" && !fallback ? "Live" : "Snapshot"}
			</span>
		</div>
	);
}
