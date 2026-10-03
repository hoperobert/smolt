import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api.ts";
import { cn } from "../lib/cn.ts";
import { listenToView, themeVars } from "../state/views.ts";

/**
 * An extension's view, in a sandboxed frame.
 *
 * `sandbox="allow-scripts"` and nothing else: the page runs its script but
 * has an opaque origin (no cookies, no storage of the app's, no access to
 * this window), cannot open windows or submit forms, and its CSP allows no
 * network. Everything it does goes through `window.smolt`, which talks to
 * this component by postMessage; only messages from this frame's own window
 * are listened to, and only for this view's id.
 */
export function ExtensionView({
	viewId,
	className,
	autoHeight = false,
	title,
}: {
	viewId: string;
	className?: string;
	/** Size the frame to its content (settings sections). */
	autoHeight?: boolean;
	title: string;
}) {
	const frame = useRef<HTMLIFrameElement>(null);
	const [height, setHeight] = useState<number | undefined>(undefined);
	// The URL is fixed per mount: a theme change is sent as a message, not a reload.
	const [src] = useState(() => api.viewUrl(viewId, themeVars().theme));

	useEffect(() => {
		const target = (): Window | null | undefined => frame.current?.contentWindow;
		const send = (message: Record<string, unknown>): void => {
			target()?.postMessage({ smoltViewHost: viewId, ...message }, "*");
		};
		const sendTheme = (): void => send({ type: "theme", ...themeVars() });
		const onMessage = (event: MessageEvent): void => {
			if (!frame.current || event.source !== target()) return;
			const m = event.data as { smoltView?: string; type?: string; [key: string]: unknown } | null;
			if (!m || m.smoltView !== viewId) return;
			if (m.type === "ready") {
				sendTheme();
			} else if (m.type === "request") {
				const seq = m.seq;
				void api
					.viewRequest(viewId, String(m.method ?? ""), m.params)
					.then(
						(result) => send({ type: "response", seq, ok: result.ok, value: result.value, error: result.error }),
						(error: unknown) =>
							send({ type: "response", seq, ok: false, error: error instanceof Error ? error.message : String(error) }),
					);
			} else if (m.type === "openUrl" && typeof m.url === "string" && /^https?:\/\//i.test(m.url)) {
				void api.openUrl(m.url);
			} else if (m.type === "copy" && typeof m.text === "string") {
				void api.copyText(m.text);
			} else if (m.type === "height" && typeof m.height === "number") {
				setHeight(Math.min(2000, Math.max(24, m.height)));
			}
		};
		window.addEventListener("message", onMessage);
		const stop = listenToView(viewId, (event, data) => send({ type: "event", event, data }));
		// The user switches theme: the frame follows without reloading.
		const watcher = new MutationObserver(sendTheme);
		watcher.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
		return () => {
			window.removeEventListener("message", onMessage);
			stop();
			watcher.disconnect();
		};
	}, [viewId]);

	return (
		<iframe
			ref={frame}
			title={title}
			src={src}
			sandbox="allow-scripts"
			className={cn("block w-full border-0 bg-transparent", !autoHeight && "h-full", className)}
			style={autoHeight ? { height: height ?? 44 } : undefined}
		/>
	);
}
