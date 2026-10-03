import type { AgentBridge } from "./agent-bridge.ts";

export { THEME_TOKENS } from "./view-tokens.ts";

/**
 * Extension views in the desktop app.
 *
 * Extensions register views (`smolt.registerView`) in their own agent
 * process. The app runs one agent for them, the view host, apart from the
 * chat agents: its extensions keep their views' state (connections, streams)
 * however chats come and go, and a background job of theirs (a badge, a
 * notification) runs once rather than once per open chat.
 *
 * A view's page is drawn in a sandboxed iframe (scripts only: no same-origin,
 * no popups, no forms) from `smolt-view://<id>/` in the window and
 * `/view?id=` in the browser build. The document is the extension's HTML with
 * a CSP that allows inline script and style and no network at all, plus a
 * small bridge script that gives it `window.smolt`. Requests travel
 * frame → postMessage → renderer → IPC → this process → RPC → extension;
 * events come back the same way.
 */

export interface ViewInfo {
	id: string;
	extension: string;
	title: string;
	icon?: string;
	location: "sidebar" | "settings";
	order: number;
	badge?: number | string;
}

/** No network, no frames, no forms: a view reaches out only through `window.smolt`. */
export const VIEW_CSP =
	"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";

/**
 * The script injected ahead of the extension's own: `window.smolt` over
 * postMessage to the window that framed it. Messages carry the view id both
 * ways, and the frame only listens to its parent.
 */
export function bridgeScript(viewId: string, theme: "light" | "dark"): string {
	const id = JSON.stringify(viewId);
	return `(function () {
	var id = ${id};
	var seq = 0;
	var pending = new Map();
	var listeners = new Map();
	var root = document.documentElement;
	root.dataset.theme = ${JSON.stringify(theme)};
	root.style.visibility = "hidden";
	var shown = false;
	function show() { if (!shown) { shown = true; root.style.visibility = ""; } }
	setTimeout(show, 800);
	function post(message) { message.smoltView = id; parent.postMessage(message, "*"); }
	function applyTheme(vars, mode) {
		for (var name in vars) root.style.setProperty("--" + name, vars[name]);
		root.dataset.theme = mode;
		root.style.colorScheme = mode;
		window.smolt.view.theme = mode;
		show();
	}
	window.addEventListener("message", function (event) {
		if (event.source !== parent) return;
		var m = event.data;
		if (!m || m.smoltViewHost !== id) return;
		if (m.type === "response") {
			var p = pending.get(m.seq);
			if (!p) return;
			pending.delete(m.seq);
			if (m.ok) p.resolve(m.value); else p.reject(new Error(m.error || "Request failed"));
		} else if (m.type === "event") {
			(listeners.get(m.event) || []).slice().forEach(function (cb) { try { cb(m.data); } catch (e) { console.error(e); } });
		} else if (m.type === "theme") {
			applyTheme(m.vars || {}, m.theme === "light" ? "light" : "dark");
		}
	});
	window.smolt = {
		view: { id: id, theme: ${JSON.stringify(theme)} },
		request: function (method, params) {
			var n = ++seq;
			return new Promise(function (resolve, reject) {
				pending.set(n, { resolve: resolve, reject: reject });
				post({ type: "request", seq: n, method: String(method), params: params === undefined ? null : params });
			});
		},
		on: function (event, cb) {
			var list = listeners.get(event) || [];
			list.push(cb);
			listeners.set(event, list);
			return function () { listeners.set(event, (listeners.get(event) || []).filter(function (x) { return x !== cb; })); };
		},
		openUrl: function (url) { if (/^https?:\\/\\//i.test(String(url))) post({ type: "openUrl", url: String(url) }); },
		copy: function (text) { post({ type: "copy", text: String(text) }); return Promise.resolve(); }
	};
	function height() { post({ type: "height", height: Math.ceil(document.documentElement.scrollHeight) }); }
	window.addEventListener("load", height);
	if (typeof ResizeObserver !== "undefined") new ResizeObserver(height).observe(root);
	post({ type: "ready" });
})();`;
}

/** The served document: the extension's page with the CSP and the bridge in its head. */
export function viewDocument(html: string, viewId: string, theme: "light" | "dark"): string {
	const head = `<meta http-equiv="Content-Security-Policy" content="${VIEW_CSP}" />\n<script>${bridgeScript(viewId, theme).replaceAll("</script", "<\\/script")}</script>`;
	if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (open) => `${open}\n${head}`);
	if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (open) => `${open}\n<head>${head}</head>`);
	return `<!doctype html><html><head><meta charset="utf-8" />${head}</head><body>${html}</body></html>`;
}

/** A page for a view that could not be loaded, in the same frame and theme. */
export function errorDocument(message: string, viewId: string, theme: "light" | "dark"): string {
	const safe = message.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
	return viewDocument(
		`<!doctype html><html><head><meta charset="utf-8" /><style>body{margin:0;padding:32px;font:13px/1.5 system-ui,sans-serif;background:var(--background);color:var(--muted-foreground)}</style></head><body><p>${safe}</p></body></html>`,
		viewId,
		theme,
	);
}

export function isViewInfo(value: unknown): value is ViewInfo {
	const v = value as ViewInfo | null;
	return !!v && typeof v.id === "string" && typeof v.title === "string";
}

type Send = (channel: string, payload: unknown) => void;

export interface ViewHostOptions {
	/** Start the dedicated agent; null when the CLI cannot start. */
	start: () => Promise<AgentBridge | null>;
	/** To the window (and the browser build, which mirrors it). */
	send: Send;
	/** An extension's notify, for native notifications and toasts. */
	notify: (request: {
		message: string;
		notifyType?: string;
		native?: boolean;
		title?: string;
		openView?: string;
	}) => void;
	/** An open_url request from an extension in the host. */
	openUrl: (url: string) => void;
	/** Why the host gave no views (for the crash log). */
	onError?: (reason: string) => void;
}

export class ViewHost {
	private readonly options: ViewHostOptions;
	private bridge: AgentBridge | null = null;
	private views: ViewInfo[] = [];
	private starting: Promise<void> | null = null;
	private generation = 0;

	constructor(options: ViewHostOptions) {
		this.options = options;
	}

	list(): ViewInfo[] {
		return this.views;
	}

	/** Start the host (once); concurrent callers share the start. */
	ensure(): Promise<void> {
		this.starting ??= this.boot();
		return this.starting;
	}

	private async boot(): Promise<void> {
		const generation = ++this.generation;
		const bridge = await this.options.start();
		if (generation !== this.generation) {
			await bridge?.stop();
			return;
		}
		if (!bridge) {
			this.failed("the agent did not start");
			return;
		}
		this.bridge = bridge;
		bridge.onEvent((raw) => this.onEvent(raw));
		bridge.onExit(() => {
			if (this.bridge !== bridge) return;
			this.bridge = null;
			this.starting = null;
			this.setViews([]);
		});
		try {
			const listed = (await bridge.call("listViews", [])) as { views?: unknown[] } | undefined;
			this.setViews((listed?.views ?? []).filter(isViewInfo));
			await bridge.call("attachViews", []);
		} catch (error) {
			this.setViews([]);
			this.failed(error instanceof Error ? error.message : String(error));
		}
	}

	/**
	 * Without the host no extension shows a view, and nothing else says why: an
	 * agent build older than the views API answers listViews with an error.
	 */
	private failed(reason: string): void {
		this.options.onError?.(reason);
		this.options.notify({
			message: `Extension views could not load (${reason}). Rebuild packages/coding-agent and restart.`,
			notifyType: "error",
		});
	}

	/**
	 * Start over: after an extension is switched on or off in settings, so a
	 * switched-off extension's views leave the app at once.
	 */
	async restart(): Promise<ViewInfo[]> {
		const old = this.bridge;
		this.bridge = null;
		this.starting = null;
		this.generation += 1;
		this.setViews([]);
		await old?.stop();
		await this.ensure();
		return this.views;
	}

	async stop(): Promise<void> {
		this.generation += 1;
		const old = this.bridge;
		this.bridge = null;
		this.starting = null;
		await old?.stop();
	}

	private setViews(views: ViewInfo[]): void {
		this.views = views;
		this.options.send("views:changed", views);
	}

	private onEvent(raw: unknown): void {
		const event = raw as { type?: string; [key: string]: unknown };
		if (event.type === "view_event") {
			this.options.send("views:event", { viewId: event.viewId, event: event.event, data: event.data });
		} else if (event.type === "views_changed" && Array.isArray(event.views)) {
			this.setViews(event.views.filter(isViewInfo));
		} else if (
			event.type === "extension_ui_request" &&
			event.method === "notify" &&
			typeof event.message === "string"
		) {
			this.options.notify(event as { message: string });
		} else if (
			event.type === "extension_ui_request" &&
			event.method === "open_url" &&
			typeof event.url === "string"
		) {
			this.options.openUrl(event.url);
		}
	}

	private async need(): Promise<AgentBridge> {
		await this.ensure();
		if (!this.bridge) throw new Error("The extension host is not running.");
		return this.bridge;
	}

	/** The served document for a view, ready for the frame. */
	async document(viewId: string, theme: "light" | "dark"): Promise<string> {
		try {
			const bridge = await this.need();
			const { html } = (await bridge.call("getView", [viewId])) as { html: string };
			return viewDocument(String(html ?? ""), viewId, theme);
		} catch (error) {
			return errorDocument(error instanceof Error ? error.message : String(error), viewId, theme);
		}
	}

	async request(viewId: string, method: string, params: unknown): Promise<unknown> {
		const bridge = await this.need();
		return await bridge.call("viewRequest", [viewId, method, params]);
	}
}
