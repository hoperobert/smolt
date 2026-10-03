import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { DesktopSecretStore, type KeyCipher, migrateLegacyVosKey } from "../src/main/secret-store.ts";
import { bridgeScript, isViewInfo, VIEW_CSP, ViewHost, viewDocument } from "../src/main/views.ts";

/** A stand-in for safeStorage: reversible, and obviously not the plain value. */
const cipher = (available = true): KeyCipher => ({
	available: () => available,
	encrypt: (plain) => Buffer.from(`enc:${plain}`).toString("base64"),
	decrypt: (encoded) => Buffer.from(encoded, "base64").toString().replace(/^enc:/, ""),
});

describe("DesktopSecretStore", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "desktop-secrets-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	test("seals values with the keystore, per scope, in an owner-only file", () => {
		const path = join(dir, "desktop-secrets.json");
		const store = new DesktopSecretStore(cipher(), path);
		expect(store.handle({ method: "secrets_backend" })).toBe("keychain");
		store.handle({ method: "secrets_set", scope: "vos", key: "apiKey", value: "k1" });
		store.handle({ method: "secrets_set", scope: "other", key: "apiKey", value: "k2" });
		const file = readFileSync(path, "utf-8");
		expect(file).not.toContain("k1");
		expect(new DesktopSecretStore(cipher(), path).get("vos", "apiKey")).toBe("k1");
		expect(store.handle({ method: "secrets_get", scope: "other", key: "apiKey" })).toBe("k2");
		if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
		store.handle({ method: "secrets_delete", scope: "vos", key: "apiKey" });
		expect(store.handle({ method: "secrets_get", scope: "vos", key: "apiKey" })).toBeNull();
		expect(() => store.handle({ method: "secrets_set", scope: "vos", key: "x" })).toThrow();
		expect(() => store.handle({ method: "nope" })).toThrow("Unknown host request");
	});

	test("without a keystore, values live in memory only and the backend says so", () => {
		const path = join(dir, "desktop-secrets.json");
		const store = new DesktopSecretStore(cipher(false), path);
		store.set("vos", "apiKey", "k");
		expect(store.get("vos", "apiKey")).toBe("k");
		expect(store.backend()).toBe("memory");
		expect(() => readFileSync(path)).toThrow();
	});

	test("the old built-in Vos key moves into the extension's secrets once; the address stays", () => {
		const vosPath = join(dir, "vos.json");
		writeFileSync(
			vosPath,
			JSON.stringify({
				url: "https://vos.test",
				encryptedKey: cipher().encrypt("old"),
				desktopDeviceName: "smolt on X",
			}),
		);
		const store = new DesktopSecretStore(cipher(), join(dir, "desktop-secrets.json"));
		expect(migrateLegacyVosKey(store, cipher(), vosPath)).toBe(true);
		expect(store.get("vos", "apiKey")).toBe("old");
		expect(store.get("vos", "deviceName")).toBe("smolt on X");
		expect(JSON.parse(readFileSync(vosPath, "utf-8"))).toEqual({ url: "https://vos.test" });
		expect(migrateLegacyVosKey(store, cipher(), vosPath)).toBe(false);
	});
});

describe("view documents", () => {
	test("the bridge and the no-network CSP go first in the head", () => {
		const doc = viewDocument(
			"<!doctype html><html><head><title>x</title></head><body>hi</body></html>",
			"vos",
			"light",
		);
		const head = doc.slice(doc.indexOf("<head>"), doc.indexOf("<title>"));
		expect(head).toContain(`content="${VIEW_CSP}"`);
		expect(head).toContain("window.smolt");
		expect(VIEW_CSP).toContain("connect-src 'none'");
		expect(viewDocument("<p>bare</p>", "v", "dark")).toMatch(/^<!doctype html><html><head>.*<body><p>bare<\/p>/s);
	});

	test("the bridge script talks only to its parent, under its own view id", () => {
		const script = bridgeScript('a"b', "dark");
		expect(script).toContain('var id = "a\\"b";');
		expect(script).toContain("event.source !== parent");
		expect(script).toContain("m.smoltViewHost !== id");
		// It must parse as a script.
		expect(() => new Function(script)).not.toThrow();
	});
});

describe("ViewHost", () => {
	type Listener = (event: unknown) => void;
	const fakeBridge = (views: unknown[]) => {
		const listeners: Listener[] = [];
		const calls: { method: string; args: unknown[] }[] = [];
		let stopped = false;
		return {
			calls,
			emit: (event: unknown) => {
				for (const listener of listeners) listener(event);
			},
			get stopped() {
				return stopped;
			},
			bridge: {
				onEvent: (listener: Listener) => listeners.push(listener),
				onExit: () => () => {},
				call: async (method: string, args: unknown[]) => {
					calls.push({ method, args });
					if (method === "listViews") return { views };
					if (method === "getView") return { html: "<html><head></head><body>page</body></html>" };
					if (method === "viewRequest") return { echoed: args };
					return undefined;
				},
				stop: async () => {
					stopped = true;
				},
			},
		};
	};

	test("lists and attaches, serves documents, routes requests and events, restarts", async () => {
		const sent: { channel: string; payload: unknown }[] = [];
		const notes: unknown[] = [];
		const vos = { id: "vos", extension: "vos", title: "Vos", location: "sidebar", order: -10 };
		const first = fakeBridge([vos]);
		const second = fakeBridge([]);
		const queue = [first, second];
		const host = new ViewHost({
			start: async () => (queue.shift()?.bridge ?? null) as never,
			send: (channel, payload) => sent.push({ channel, payload }),
			notify: (request) => notes.push(request),
			openUrl: () => {},
		});
		await host.ensure();
		expect(host.list()).toEqual([vos]);
		expect(first.calls.map((c) => c.method)).toEqual(["listViews", "attachViews"]);
		expect(await host.document("vos", "dark")).toContain("page");
		expect(await host.request("vos", "status", { a: 1 })).toEqual({ echoed: ["vos", "status", { a: 1 }] });

		first.emit({ type: "view_event", viewId: "vos", event: "inbox", data: { n: 1 } });
		first.emit({ type: "views_changed", views: [{ ...vos, badge: 2 }, { bogus: true }] });
		first.emit({ type: "extension_ui_request", method: "notify", message: "hi", native: true });
		expect(sent).toContainEqual({
			channel: "views:event",
			payload: { viewId: "vos", event: "inbox", data: { n: 1 } },
		});
		expect(host.list()).toEqual([{ ...vos, badge: 2 }]);
		expect(notes).toEqual([{ type: "extension_ui_request", method: "notify", message: "hi", native: true }]);

		// Switching the extension off: the host restarts and its views leave.
		expect(await host.restart()).toEqual([]);
		expect(first.stopped).toBe(true);
		expect(sent.at(-1)).toEqual({ channel: "views:changed", payload: [] });
		expect(isViewInfo({ id: "x" })).toBe(false);
	});
});
