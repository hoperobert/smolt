import { THEME_TOKENS } from "../../main/view-tokens.ts";
import { api, type ViewInfo } from "../lib/api.ts";
import { app, bump, toast } from "./app.ts";

/**
 * Extension views in the window: the list (kept current by the main
 * process), which one has the main pane, and the events their extensions
 * push, routed to the frames that show them. See main/views.ts.
 */

type FrameListener = (event: string, data: unknown) => void;
const frames = new Map<string, Set<FrameListener>>();

/** A frame showing `viewId` hears its extension's events while mounted. */
export function listenToView(viewId: string, listener: FrameListener): () => void {
	const set = frames.get(viewId) ?? new Set<FrameListener>();
	set.add(listener);
	frames.set(viewId, set);
	return () => {
		set.delete(listener);
	};
}

function setViews(views: ViewInfo[]): void {
	app.views = Array.isArray(views) ? views : [];
	// A view that left (its extension switched off) cannot keep the pane.
	if (app.viewOpen && !app.views.some((v) => v.id === app.viewOpen)) app.viewOpen = null;
	bump();
}

export function openView(viewId: string): void {
	app.viewOpen = viewId;
	bump();
}

export function closeView(): void {
	app.viewOpen = null;
	bump();
}

/** After an extension is switched on or off: its views come and go at once. */
export async function reloadViews(): Promise<void> {
	setViews(await api.viewsReload().catch(() => app.views));
}

let wired = false;

export function bootViews(): void {
	if (wired) return;
	wired = true;
	api.onViewsChanged((views) => setViews(views));
	api.onViewEvent(({ viewId, event, data }) => {
		for (const listener of frames.get(viewId) ?? []) listener(event, data);
	});
	api.onViewNotify((request) => toast(request.message, request.notifyType === "error" ? "error" : "default"));
	api.onViewOpen((viewId) => openView(viewId));
	void api.views().then(setViews, () => {});
}

/** The app's theme tokens as a view receives them: CSS variables, read from the window's own. */
export function themeVars(): { vars: Record<string, string>; theme: "light" | "dark" } {
	const style = getComputedStyle(document.documentElement);
	const vars: Record<string, string> = {};
	for (const name of THEME_TOKENS) {
		const value = style.getPropertyValue(`--${name}`).trim();
		if (value) vars[name] = value;
	}
	return { vars, theme: document.documentElement.dataset.theme === "light" ? "light" : "dark" };
}
