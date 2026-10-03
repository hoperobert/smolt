import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionSecrets } from "../../core/extensions/types.ts";
import { DEFAULT_VOS_URL, normalizeBaseUrl } from "./client.ts";
import type { VosKeySource } from "./types.ts";

/**
 * Where the Vos extension keeps its connection.
 *
 * The server address is not a secret: it lives in `~/.smolt/vos.json`
 * (`{ "url": "https://vos-api.vosgrau.com" }`), shared by the terminal and the
 * desktop app.
 *
 * The device key is, so it goes to the extension secret store the host
 * provides (`smolt.secrets`): the operating system's keystore when the desktop
 * app runs the agent, a 0600 file in the terminal. Each host keeps its own
 * key, as each was paired as a device of its own. VOS_API_KEY in the
 * environment still wins over both.
 *
 * Older versions kept the terminal's key in vos.json (`apiKey`, `deviceName`)
 * and the desktop's encrypted with Electron safeStorage (`encryptedKey`,
 * `desktopDeviceName`). `migrateFileKey` moves the former into the secret
 * store once; the desktop app migrates the latter itself, since only it can
 * decrypt it.
 */

export interface VosFile {
	url?: string;
	/** Legacy: the desktop's key, encrypted by Electron safeStorage. Migrated by the desktop app. */
	encryptedKey?: string;
	/** Legacy: the terminal's key. Migrated into the secret store. */
	apiKey?: string;
	/** Legacy: what the terminal was paired as. */
	deviceName?: string;
	/** Legacy: what the desktop was paired as. */
	desktopDeviceName?: string;
}

/** The secret store's keys. */
export const SECRET_KEY = "apiKey";
export const SECRET_DEVICE = "deviceName";

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
		if (typeof raw.deviceName === "string") out.deviceName = raw.deviceName;
		if (typeof raw.desktopDeviceName === "string") out.desktopDeviceName = raw.desktopDeviceName;
		return out;
	} catch {
		return {};
	}
}

/** Write the file owner-only, replacing it in one step so a crash never leaves half of it. */
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

/** The server address: VOS_URL, then the file, then the default. */
export function resolveVosUrl(env: NodeJS.ProcessEnv = process.env): string {
	const path = vosConfigPath(env);
	const file = existsSync(path) ? readVosFile(path) : {};
	try {
		return normalizeBaseUrl(env.VOS_URL?.trim() || file.url || DEFAULT_VOS_URL);
	} catch {
		return DEFAULT_VOS_URL;
	}
}

/** Remember the server address for next time. */
export function saveVosUrl(url: string, env: NodeJS.ProcessEnv = process.env): void {
	const path = vosConfigPath(env);
	const file = readVosFile(path);
	if (file.url === url) return;
	writeVosFile({ ...file, url }, path);
}

export type { VosKeySource } from "./types.ts";

export interface ResolvedVosConfig {
	url: string;
	apiKey?: string;
	/** Where the key came from, for messages. */
	keySource: VosKeySource;
	path: string;
	/** What this host was paired as, when its key came from pairing. */
	deviceName?: string;
}

/**
 * Move a key the terminal kept in vos.json into the secret store, once. The
 * file keeps only the address afterwards.
 */
export async function migrateFileKey(secrets: ExtensionSecrets, env: NodeJS.ProcessEnv = process.env): Promise<void> {
	const path = vosConfigPath(env);
	if (!existsSync(path)) return;
	const file = readVosFile(path);
	const legacy = file.apiKey?.trim();
	if (!legacy) return;
	if (!(await secrets.get(SECRET_KEY))) {
		await secrets.set(SECRET_KEY, legacy);
		if (file.deviceName) await secrets.set(SECRET_DEVICE, file.deviceName);
	}
	delete file.apiKey;
	delete file.deviceName;
	writeVosFile(file, path);
}

/** The address and key this host should use right now. */
export async function resolveVosConfig(
	secrets: ExtensionSecrets,
	env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedVosConfig> {
	const path = vosConfigPath(env);
	const url = resolveVosUrl(env);
	const envKey = env.VOS_API_KEY?.trim();
	if (envKey) return { url, apiKey: envKey, keySource: "env", path };
	await migrateFileKey(secrets, env).catch(() => {});
	const stored = (await secrets.get(SECRET_KEY).catch(() => undefined))?.trim();
	if (!stored) return { url, keySource: "none", path };
	const deviceName = await secrets.get(SECRET_DEVICE).catch(() => undefined);
	const backend = await secrets.backend().catch(() => "memory" as const);
	return { url, apiKey: stored, keySource: backend, path, ...(deviceName ? { deviceName } : {}) };
}
