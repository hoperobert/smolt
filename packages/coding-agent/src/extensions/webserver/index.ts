import type { ExtensionAPI } from "../../core/extensions/types.ts";
import {
	isBindableAddress,
	liveWebServerStatus,
	preferredWebServerUrl,
	readWebServerSettings,
	type WebServerSettings,
	webServerSettingsFile,
	writeWebServerSettings,
} from "./config.ts";

/**
 * The desktop app in a browser, switched from a terminal.
 *
 * The server itself is the desktop's: it serves that app's own renderer to the
 * machine and its Tailscale network, so a browser is one more window on the
 * same chats rather than a second app on the same data. What this extension
 * adds is the other half of the switch — `/webserver on|off` writes the
 * settings file the app watches, and reports the link — so the app never has
 * to be opened to reach it.
 *
 * It works from a terminal whether or not the app is running. The setting is
 * remembered either way, and the desktop picks it up when it starts.
 */

/** A report is for the reader only, never steered into the model's turn. */
const REPORT_DELIVERY = { triggerTurn: false } as const;

/** How long to give the desktop to notice a change before reporting what is. */
const APPLY_TIMEOUT_MS = 2000;

/** How often to look while waiting for it to notice. */
const APPLY_POLL_MS = 120;

/** The highest port whose HTTPS twin still fits, since HTTPS is port + 1. */
const MAX_PORT = 65534;

const USAGE = [
	"/webserver              whether the app is being served, and where",
	"/webserver on | off     serve the desktop app in a browser, or stop",
	`/webserver port <${1024}-${MAX_PORT}>  the port to serve on; HTTPS takes the next one up`,
	"/webserver lan off | on serve to the whole local network, not just localhost and Tailscale",
	"/webserver lan 10.0.0.3 serve on one address too, such as a VPN interface",
].join("\n");

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function sameSettings(a: WebServerSettings, b: WebServerSettings): boolean {
	return a.enabled === b.enabled && a.port === b.port && a.lan === b.lan;
}

/**
 * Wait for the desktop's own report to catch up with a change, or for it to be
 * clear that it will not.
 *
 * The clock is what makes this work for a first start and a restart at once: a
 * report written after the change is the one that answers it, so nothing here
 * has to know how long a start takes or which port HTTPS ends up on.
 */
async function waitForDesktop(settings: WebServerSettings, since: number): Promise<void> {
	const settled = (): boolean => {
		const status = liveWebServerStatus();
		// Switching off is over the moment the app stops publishing; switching on
		// is over only when a fresh report arrives, so an app that is about to
		// start serving is waited for rather than reported as missing.
		return settings.enabled ? status !== undefined && status.at >= since - 50 : status === undefined;
	};
	const deadline = Date.now() + APPLY_TIMEOUT_MS;
	while (!settled()) {
		if (Date.now() >= deadline) return;
		await sleep(APPLY_POLL_MS);
	}
}

/** What is running and where to open it, as one report for the transcript. */
function render(settings: WebServerSettings, note?: string): string {
	const lines: string[] = [];
	const status = liveWebServerStatus();
	if (!settings.enabled) {
		lines.push("Web server: off.");
		lines.push("The desktop app can serve its own window as a web page; /webserver on turns that on.");
	} else if (status) {
		const url = preferredWebServerUrl(status);
		lines.push(url === undefined ? "Web server: on." : `Web server: on. Open ${url}`);
		const others = status.urls.filter((candidate) => candidate !== url);
		if (others.length > 0) lines.push(`Also reachable at ${others.join(", ")}.`);
		if (!status.https) {
			lines.push("HTTP only: openssl was not found, so the microphone (dictation) is unavailable.");
		}
	} else {
		lines.push(`Web server: on, but nothing is serving port ${settings.port} yet.`);
		lines.push("The desktop app does the serving; it picks this setting up when it runs.");
	}
	if (note !== undefined) lines.push(note);
	return lines.join("\n");
}

/** Write the switch, then report what actually came of it. */
async function apply(settings: WebServerSettings, next: WebServerSettings, smolt: ExtensionAPI): Promise<void> {
	const since = Date.now();
	writeWebServerSettings(webServerSettingsFile(), next);
	if (!sameSettings(settings, next)) await waitForDesktop(next, since);
	smolt.sendMessage({ customType: "webserver-report", content: render(next), display: true }, REPORT_DELIVERY);
}

export default function webserverExtension(smolt: ExtensionAPI) {
	smolt.registerCommand("webserver", {
		description: "Serve the desktop app in a browser, and show the link",
		handler: async (args, ctx) => {
			const settings = readWebServerSettings(webServerSettingsFile());
			const [action = "", value = ""] = args.trim().split(/\s+/);
			switch (action) {
				case "":
				case "status":
					ctx.ui.notify(render(settings), "info");
					return;
				case "on":
				case "off":
					await apply(settings, { ...settings, enabled: action === "on" }, smolt);
					return;
				case "port": {
					const port = Number.parseInt(value, 10);
					if (!Number.isInteger(port) || port < 1024 || port > MAX_PORT) {
						ctx.ui.notify(`Expected a port from 1024 to ${MAX_PORT}, got "${value}".`, "error");
						return;
					}
					await apply(settings, { ...settings, port }, smolt);
					return;
				}
				case "lan": {
					// A bare `lan` answers the question it would otherwise look like
					// it was asking, rather than being a trap that only errors.
					if (value === "") {
						ctx.ui.notify(render(settings), "info");
						return;
					}
					if (value === "on" || value === "off") {
						await apply(settings, { ...settings, lan: value === "on" }, smolt);
						return;
					}
					if (!isBindableAddress(value)) {
						ctx.ui.notify(`Expected on, off, or an IPv4 address, got "${value}".`, "error");
						return;
					}
					await apply(settings, { ...settings, lan: value }, smolt);
					return;
				}
				default:
					ctx.ui.notify(USAGE, "info");
			}
		},
	});
}
