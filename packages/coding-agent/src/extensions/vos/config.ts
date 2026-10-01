import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_VOS_URL, normalizeBaseUrl } from "./client.ts";

/**
 * Where smolt keeps the Vos connection: `~/.smolt/vos.json`.
 *
 *   { "url": "https://vos-api.vosgrau.com",
 *     "encryptedKey": "<base64>",   // written by the desktop app: Electron safeStorage (OS keychain/DPAPI)
 *     "apiKey": "<key>" }           // optional, written by the user for the TUI
 *
 * The desktop app stores the key encrypted with the operating system's
 * keystore, which only the desktop app can decrypt. The TUI therefore reads
 * the key from the VOS_API_KEY environment variable, or from an `apiKey` the
 * user wrote into this file themselves (the file is kept 0600, like the
 * agent's own auth.json). The server address is shared by both.
 */

export interface VosFile {
	url?: string;
	encryptedKey?: string;
	apiKey?: string;
}

export function vosConfigPath(env: NodeJS.ProcessEnv = process.env): string {
	const override = env.SMOLT_VOS_CONFIG?.trim();
	return override ? override : join(homedir(), ".smolt", "vos.json");
}

export function readVosFile(path: string = vosConfigPath()): VosFile {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
		if (!parsed || typeof parsed !== "object") return {};
		const raw = parsed as Record<string, unknown>;
		const out: VosFile = {};
		if (typeof raw.url === "string") out.url = raw.url;
		if (typeof raw.encryptedKey === "string") out.encryptedKey = raw.encryptedKey;
		if (typeof raw.apiKey === "string") out.apiKey = raw.apiKey;
		return out;
	} catch {
		return {};
	}
}

/** Write the file owner-only, replacing it in one step so a crash never leaves half a key. */
export function writeVosFile(data: VosFile, path: string = vosConfigPath()): void {
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
	renameSync(temp, path);
	try {
		chmodSync(path, 0o600);
	} catch {
		// Windows has no POSIX modes; the file sits in the user's own profile.
	}
}

export interface ResolvedVosConfig {
	url: string;
	apiKey?: string;
	/** Where the key came from, for messages. */
	keySource?: "env" | "file";
	/** The file holds only the desktop app's encrypted key, which the TUI cannot read. */
	desktopOnly: boolean;
	path: string;
}

export function resolveVosConfig(env: NodeJS.ProcessEnv = process.env): ResolvedVosConfig {
	const path = vosConfigPath(env);
	const file = existsSync(path) ? readVosFile(path) : {};
	let url = DEFAULT_VOS_URL;
	try {
		url = normalizeBaseUrl(env.VOS_URL?.trim() || file.url || DEFAULT_VOS_URL);
	} catch {
		url = DEFAULT_VOS_URL;
	}
	const envKey = env.VOS_API_KEY?.trim();
	if (envKey) return { url, apiKey: envKey, keySource: "env", desktopOnly: false, path };
	const fileKey = file.apiKey?.trim();
	if (fileKey) return { url, apiKey: fileKey, keySource: "file", desktopOnly: false, path };
	return { url, desktopOnly: !!file.encryptedKey, path };
}
