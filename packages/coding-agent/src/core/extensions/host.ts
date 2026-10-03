/**
 * What an extension needs from the program hosting it, beyond the session:
 * somewhere to keep secrets, and a front end that can show its views.
 *
 * The terminal is its own host: secrets go to a file only the user can read,
 * and views have nowhere to appear. A front end that runs the agent in RPC
 * mode (the desktop app) replaces both: secrets are kept by the operating
 * system's keystore in the front end's process, and views are drawn there.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "../../config.ts";

/**
 * Where a secret ends up: the OS keystore, a 0600 file, or (when the host has
 * no keystore it trusts) only this process's memory, gone when it exits.
 */
export type SecretBackend = "keychain" | "file" | "memory";

/** Secrets by scope (an extension's id) and key. */
export interface SecretStore {
	get(scope: string, key: string): Promise<string | undefined>;
	set(scope: string, key: string, value: string): Promise<void>;
	delete(scope: string, key: string): Promise<void>;
	backend(): Promise<SecretBackend>;
}

export interface ExtensionHost {
	/** Push an event to a view the front end shows. Without a front end it goes nowhere. */
	postToView(viewId: string, event: string, data: unknown): void;
	/** The set of views, or a badge on one, changed. */
	viewsChanged(): void;
	secrets: SecretStore;
}

type SecretFile = Record<string, Record<string, string>>;

/** The default file: beside the agent's own auth.json, owner-only. */
export function defaultSecretsPath(): string {
	return join(getAgentDir(), "extension-secrets.json");
}

/**
 * Secrets in one JSON file, mode 0600, replaced in one step so a crash never
 * leaves half a value. The same protection the agent gives its own provider
 * keys in auth.json: readable by the user's account and nobody else.
 */
export class FileSecretStore implements SecretStore {
	private readonly path: () => string;

	constructor(path?: string) {
		this.path = path ? () => path : defaultSecretsPath;
	}

	private read(): SecretFile {
		try {
			const parsed: unknown = JSON.parse(readFileSync(this.path(), "utf-8"));
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
			const out: SecretFile = {};
			for (const [scope, entries] of Object.entries(parsed as Record<string, unknown>)) {
				if (!entries || typeof entries !== "object" || Array.isArray(entries)) continue;
				const kept: Record<string, string> = {};
				for (const [key, value] of Object.entries(entries as Record<string, unknown>)) {
					if (typeof value === "string") kept[key] = value;
				}
				out[scope] = kept;
			}
			return out;
		} catch {
			return {};
		}
	}

	private write(data: SecretFile): void {
		const path = this.path();
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

	async get(scope: string, key: string): Promise<string | undefined> {
		return this.read()[scope]?.[key];
	}

	async set(scope: string, key: string, value: string): Promise<void> {
		const data = this.read();
		data[scope] = { ...data[scope], [key]: value };
		this.write(data);
	}

	async delete(scope: string, key: string): Promise<void> {
		const data = this.read();
		const entries = data[scope];
		if (!entries || !(key in entries)) return;
		delete entries[key];
		if (Object.keys(entries).length === 0) delete data[scope];
		this.write(data);
	}

	async backend(): Promise<SecretBackend> {
		return "file";
	}
}

/** The terminal's host: secrets in a file, views nowhere. */
export function createDefaultExtensionHost(secrets: SecretStore = new FileSecretStore()): ExtensionHost {
	return {
		postToView: () => {},
		viewsChanged: () => {},
		secrets,
	};
}
