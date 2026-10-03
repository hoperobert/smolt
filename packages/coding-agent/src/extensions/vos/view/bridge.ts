/**
 * `window.smolt` as the host injects it into an extension view (see the
 * extension docs, "Views"). The view's only way out of its sandbox: requests
 * to the extension's Node side, and events pushed back.
 *
 * When the page is opened on its own (a browser tab, the screenshot harness)
 * there is no host: a stub answers every request with an error so the page
 * still renders its connect screen.
 */

export interface SmoltViewBridge {
	view: { id: string; theme: "light" | "dark" };
	request(method: string, params?: unknown): Promise<unknown>;
	on(event: string, cb: (data: unknown) => void): () => void;
	openUrl(url: string): void;
	copy(text: string): Promise<void>;
}

const standalone: SmoltViewBridge = {
	view: { id: "vos", theme: "dark" },
	request: async () => {
		throw new Error("No host: open this page from smolt.");
	},
	on: () => () => {},
	openUrl: (url) => {
		window.open(url, "_blank", "noopener");
	},
	copy: async (text) => {
		await navigator.clipboard.writeText(text);
	},
};

export const bridge: SmoltViewBridge = (window as unknown as { smolt?: SmoltViewBridge }).smolt ?? standalone;
