import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Extension secrets for the desktop's agents, kept in this process.
 *
 * Every agent the app starts runs with SMOLT_RPC_HOST_SECRETS=1, so when an
 * extension calls `smolt.secrets.set("apiKey", ...)` the agent asks this
 * process (an RPC host_request) instead of writing a file of its own. Values
 * are encrypted with Electron's safeStorage (DPAPI on Windows, the Keychain on
 * macOS, the Secret Service on Linux) and written to one JSON file of
 * ciphertexts; where safeStorage has no real keystore (Linux falling back to
 * plain text), values live in memory for this run only and the backend says
 * "memory".
 */

/** What safeStorage offers, injectable so this file can be tested without Electron. */
export interface KeyCipher {
	available(): boolean;
	encrypt(plain: string): string;
	decrypt(encoded: string): string;
}

export type SecretBackend = "keychain" | "memory";

type Sealed = Record<string, Record<string, string>>;

export class DesktopSecretStore {
	private readonly cipher: KeyCipher;
	private readonly path: string;
	/** Values held for this run when there is no keystore, and plain copies of what was read. */
	private readonly memory = new Map<string, string>();

	constructor(cipher: KeyCipher, path: string) {
		this.cipher = cipher;
		this.path = path;
	}

	backend(): SecretBackend {
		return this.cipher.available() ? "keychain" : "memory";
	}

	private read(): Sealed {
		try {
			const parsed: unknown = JSON.parse(readFileSync(this.path, "utf-8"));
			return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Sealed) : {};
		} catch {
			return {};
		}
	}

	private write(data: Sealed): void {
		mkdirSync(dirname(this.path), { recursive: true });
		const temp = `${this.path}.${process.pid}.tmp`;
		writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
		renameSync(temp, this.path);
		try {
			chmodSync(this.path, 0o600);
		} catch {
			// Windows has no POSIX modes; the file sits in the user's own profile.
		}
	}

	get(scope: string, key: string): string | undefined {
		const id = `${scope}\u0000${key}`;
		if (this.memory.has(id)) return this.memory.get(id);
		if (!this.cipher.available()) return undefined;
		const sealed = this.read()[scope]?.[key];
		if (typeof sealed !== "string") return undefined;
		try {
			return this.cipher.decrypt(sealed);
		} catch {
			// Sealed by another account or machine: as good as absent.
			return undefined;
		}
	}

	set(scope: string, key: string, value: string): void {
		const id = `${scope}\u0000${key}`;
		if (!this.cipher.available()) {
			this.memory.set(id, value);
			return;
		}
		this.memory.delete(id);
		const data = this.read();
		data[scope] = { ...data[scope], [key]: this.cipher.encrypt(value) };
		this.write(data);
	}

	delete(scope: string, key: string): void {
		this.memory.delete(`${scope}\u0000${key}`);
		if (!existsSync(this.path)) return;
		const data = this.read();
		const entries = data[scope];
		if (!entries || !(key in entries)) return;
		delete entries[key];
		if (Object.keys(entries).length === 0) delete data[scope];
		this.write(data);
	}

	/** Answer an agent's host_request. */
	handle(request: { method: string; scope?: string; key?: string; value?: string }): unknown {
		const scope = String(request.scope ?? "");
		const key = String(request.key ?? "");
		switch (request.method) {
			case "secrets_backend":
				return this.backend();
			case "secrets_get":
				return this.get(scope, key) ?? null;
			case "secrets_set":
				if (typeof request.value !== "string") throw new Error("A secret's value must be a string");
				this.set(scope, key, request.value);
				return null;
			case "secrets_delete":
				this.delete(scope, key);
				return null;
			default:
				throw new Error(`Unknown host request: ${request.method}`);
		}
	}
}

/**
 * One-time move of the key the desktop's old built-in Vos section kept in
 * ~/.smolt/vos.json (`encryptedKey`, sealed with this same safeStorage) into
 * the Vos extension's secrets. Only this process can open that ciphertext, so
 * the extension cannot migrate it itself. The address stays in vos.json.
 */
export function migrateLegacyVosKey(store: DesktopSecretStore, cipher: KeyCipher, vosConfigPath: string): boolean {
	let file: Record<string, unknown>;
	try {
		file = JSON.parse(readFileSync(vosConfigPath, "utf-8")) as Record<string, unknown>;
	} catch {
		return false;
	}
	if (!file || typeof file.encryptedKey !== "string") return false;
	if (!cipher.available()) return false;
	let key: string | undefined;
	try {
		key = cipher.decrypt(file.encryptedKey);
	} catch {
		key = undefined;
	}
	if (key && !store.get("vos", "apiKey")) {
		store.set("vos", "apiKey", key);
		if (typeof file.desktopDeviceName === "string") store.set("vos", "deviceName", file.desktopDeviceName);
	}
	delete file.encryptedKey;
	delete file.desktopDeviceName;
	mkdirSync(dirname(vosConfigPath), { recursive: true });
	writeFileSync(vosConfigPath, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
	return true;
}
