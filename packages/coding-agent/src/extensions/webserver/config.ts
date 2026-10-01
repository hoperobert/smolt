import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * The web server's settings and its published state, in one module because two
 * processes share them: the desktop app runs the server, and `/webserver` in a
 * terminal is how a reader turns it on without opening the app's settings.
 *
 * A file is the only channel between them, so the shape here is the contract.
 * The agent directory is resolved here rather than imported from
 * `src/config.ts`, which the desktop could not use: its main process is
 * bundled as CommonJS, and `config.ts` reads `import.meta.url` at module
 * scope, which that format empties.
 */

/** The port the app is served on. HTTPS takes the next port up. */
export const DEFAULT_WEB_PORT = 7332;

/** What the desktop should do: serve the app in a browser, or not. */
export interface WebServerSettings {
	enabled: boolean;
	/** HTTP port. HTTPS listens on port + 1 when a certificate exists. */
	port: number;
	/**
	 * Which interfaces to serve on: `false` for localhost and Tailscale alone,
	 * `true` for every interface, or one IPv4 address to serve on as well. The
	 * address is the narrow way to reach one interface — a WireGuard or other
	 * VPN address — where `true` would take the machine's whole network with it.
	 */
	lan: boolean | string;
}

/**
 * What the desktop last reported about the server it is running.
 *
 * The server runs inside the desktop process, so a terminal cannot ask it
 * directly. The settings say what should be running; this says what is.
 */
export interface WebServerStatus {
	running: boolean;
	https: boolean;
	/** Where to open it, best first. */
	urls: string[];
	/** The process serving it, so a file outliving its app reads as off. */
	pid: number;
	/** When it was written. */
	at: number;
}

function agentDir(): string {
	const override = process.env.SMOLT_CODING_AGENT_DIR;
	if (override !== undefined && override !== "") {
		return override.startsWith("~") ? path.join(os.homedir(), override.slice(1)) : override;
	}
	return path.join(os.homedir(), ".smolt", "agent");
}

/** The switch itself: the file `/webserver` and the app's settings page both write. */
export function webServerSettingsFile(): string {
	return path.join(agentDir(), "webserver.json");
}

/** Where the desktop publishes whether it is serving, and where. */
export function webServerStatusFile(): string {
	return path.join(agentDir(), "webserver-status.json");
}

export function defaultWebServerSettings(): WebServerSettings {
	return { enabled: false, port: DEFAULT_WEB_PORT, lan: false };
}

/**
 * Whether a value is a literal IPv4 worth binding: not every interface, which
 * is what `true` means, and not the loopback, which is bound already.
 */
export function isBindableAddress(value: string): boolean {
	const parts = value.split(".");
	if (parts.length !== 4) return false;
	if (!parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return false;
	return value !== "0.0.0.0" && value !== "127.0.0.1";
}

/** Settings, with anything missing or out of range falling back to the defaults. */
export function readWebServerSettings(file: string): WebServerSettings {
	const fallback = defaultWebServerSettings();
	let parsed: Partial<WebServerSettings>;
	try {
		parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<WebServerSettings>;
	} catch {
		return fallback;
	}
	return {
		enabled: parsed.enabled === true,
		port:
			typeof parsed.port === "number" && Number.isFinite(parsed.port) && parsed.port >= 1024
				? Math.floor(parsed.port)
				: fallback.port,
		lan:
			parsed.lan === true || (typeof parsed.lan === "string" && isBindableAddress(parsed.lan))
				? parsed.lan
				: fallback.lan,
	};
}

export function writeWebServerSettings(file: string, settings: WebServerSettings): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
}

/** Publish the running server, for the front ends that cannot ask this process. */
export function writeWebServerStatus(status: WebServerStatus): void {
	const file = webServerStatusFile();
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, `${JSON.stringify(status, null, 2)}\n`, "utf-8");
	} catch {
		// A status that cannot be written costs the link, not the server.
	}
}

export function clearWebServerStatus(): void {
	try {
		fs.unlinkSync(webServerStatusFile());
	} catch {
		// already gone
	}
}

/** The server a desktop reported, if the process that reported it is still running. */
export function liveWebServerStatus(): WebServerStatus | undefined {
	let parsed: Partial<WebServerStatus>;
	try {
		parsed = JSON.parse(fs.readFileSync(webServerStatusFile(), "utf-8")) as Partial<WebServerStatus>;
	} catch {
		return undefined;
	}
	if (parsed.running !== true) return undefined;
	if (typeof parsed.pid !== "number" || !processAlive(parsed.pid)) return undefined;
	return {
		running: true,
		https: parsed.https === true,
		urls: Array.isArray(parsed.urls) ? parsed.urls.filter((url): url is string => typeof url === "string") : [],
		pid: parsed.pid,
		at: typeof parsed.at === "number" ? parsed.at : 0,
	};
}

/**
 * Whether a process is still there, so a status file left behind by a crash
 * reads as off instead of promising a link that answers nothing.
 */
export function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means it exists and belongs to someone else; anything else is gone.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** This machine's own address, which is the one a reader at the keyboard wants. */
export function preferredWebServerUrl(status: WebServerStatus): string | undefined {
	return status.urls.find((url) => /\/\/(localhost|127\.0\.0\.1)[:/]/.test(url)) ?? status.urls[0];
}
