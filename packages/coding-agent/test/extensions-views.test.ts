/**
 * Extension views and secrets: the registration API, the runner's routing,
 * the terminal's file-backed secret store, and the RPC client's side of the
 * host protocol.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { FileSecretStore } from "../src/core/extensions/host.ts";
import { loadExtensions } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

describe("FileSecretStore", () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "smolt-secrets-"));
	});
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	it("keeps values per scope in an owner-only file and forgets them on delete", async () => {
		const file = path.join(dir, "nested", "secrets.json");
		const store = new FileSecretStore(file);
		expect(await store.get("vos", "apiKey")).toBeUndefined();
		await store.set("vos", "apiKey", "k1");
		await store.set("other", "apiKey", "k2");
		expect(await store.get("vos", "apiKey")).toBe("k1");
		expect(await store.get("other", "apiKey")).toBe("k2");
		expect(await store.backend()).toBe("file");
		if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
		await store.delete("vos", "apiKey");
		await store.delete("vos", "missing");
		expect(await store.get("vos", "apiKey")).toBeUndefined();
		expect(JSON.parse(fs.readFileSync(file, "utf-8"))).toEqual({ other: { apiKey: "k2" } });
	});

	it("reads a broken file as empty", async () => {
		const file = path.join(dir, "secrets.json");
		fs.writeFileSync(file, "{nope");
		expect(await new FileSecretStore(file).get("vos", "apiKey")).toBeUndefined();
	});
});

describe("extension views", () => {
	let tempDir: string;
	let sessionManager: SessionManager;
	let modelRegistry: ModelRegistry;

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "smolt-views-test-"));
		sessionManager = SessionManager.inMemory();
		modelRegistry = await createInMemoryModelRegistry(AuthStorage.inMemory());
	});
	afterEach(() => fs.rmSync(tempDir, { recursive: true, force: true }));

	const load = async (sources: Record<string, string>) => {
		const paths: string[] = [];
		for (const [name, source] of Object.entries(sources)) {
			const file = path.join(tempDir, name);
			fs.writeFileSync(file, source);
			paths.push(file);
		}
		const result = await loadExtensions(paths, tempDir);
		expect(result.errors).toEqual([]);
		const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
		return { runner, result };
	};

	it("lists views in order, serves their pages, and routes requests to the owning extension", async () => {
		fs.writeFileSync(path.join(tempDir, "page.html"), "<p>from a file</p>");
		const { runner } = await load({
			"alpha.ts": `export default function(smolt) {
	smolt.registerView({ id: "alpha", title: "Alpha", icon: "A", html: "<p>alpha</p>" });
	smolt.registerView({ id: "alpha-settings", title: "Alpha", location: "settings", path: "page.html" });
	smolt.onViewRequest("alpha", async (method, params, ctx) => ({ method, params, cwd: typeof ctx.cwd }));
}`,
			"beta.ts": `export default function(smolt) {
	smolt.registerView({ id: "beta", title: "Beta", order: -1, html: async () => "<p>beta</p>" });
	smolt.registerView({ id: "alpha", title: "Duplicate", html: "<p>ignored</p>" });
}`,
		});
		expect(runner.getViews()).toEqual([
			{ id: "beta", extension: "beta", title: "Beta", location: "sidebar", order: -1 },
			{ id: "alpha", extension: "alpha", title: "Alpha", icon: "A", location: "sidebar", order: 0 },
			{ id: "alpha-settings", extension: "alpha", title: "Alpha", location: "settings", order: 0 },
		]);
		expect(await runner.getViewHtml("alpha")).toBe("<p>alpha</p>");
		expect(await runner.getViewHtml("beta")).toBe("<p>beta</p>");
		expect(await runner.getViewHtml("alpha-settings")).toBe("<p>from a file</p>");
		await expect(runner.getViewHtml("nope")).rejects.toThrow('No view "nope"');
		expect(await runner.handleViewRequest("alpha", "ping", { n: 1 })).toEqual({
			method: "ping",
			params: { n: 1 },
			cwd: "string",
		});
		await expect(runner.handleViewRequest("beta", "ping", {})).rejects.toThrow("takes no requests");
	});

	it("rejects a view without an id or a page", async () => {
		const file = path.join(tempDir, "bad.ts");
		fs.writeFileSync(file, `export default function(smolt) { smolt.registerView({ id: "x", title: "X" }); }`);
		const result = await loadExtensions([file], tempDir);
		expect(result.errors[0]?.error).toContain("needs html or a path");
	});

	it("delivers postToView and badges through the host, and tells extensions when views attach", async () => {
		const { runner } = await load({
			"gamma.ts": `export default function(smolt) {
	smolt.registerView({ id: "gamma", title: "Gamma", html: "<p></p>" });
	smolt.on("views_attached", () => {
		smolt.postToView("gamma", "hello", { at: 1 });
		smolt.postToView("not-mine", "hello", {});
		smolt.setViewBadge("gamma", 3);
		smolt.setViewBadge("gamma", 3);
	});
}`,
		});
		const posted: unknown[] = [];
		const changed = vi.fn();
		runner.setHost({ postToView: (...args) => posted.push(args), viewsChanged: changed });
		await runner.emitViewsAttached();
		expect(posted).toEqual([["gamma", "hello", { at: 1 }]]);
		expect(changed).toHaveBeenCalledTimes(1);
		expect(runner.getViews()[0]?.badge).toBe(3);
	});

	it("scopes secrets by extension id, through whichever store the host provides", async () => {
		const { runner } = await load({
			"delta.ts": `export default function(smolt) {
	smolt.registerCommand("keep", { handler: async (value) => { await smolt.secrets.set("token", value); } });
	smolt.registerCommand("show", { handler: async () => { globalThis.__shown = [await smolt.secrets.get("token"), await smolt.secrets.backend()]; } });
}`,
		});
		const stored = new Map<string, string>();
		runner.setHost({
			secrets: {
				get: async (scope, key) => stored.get(`${scope}/${key}`),
				set: async (scope, key, value) => void stored.set(`${scope}/${key}`, value),
				delete: async (scope, key) => void stored.delete(`${scope}/${key}`),
				backend: async () => "keychain",
			},
		});
		const commands = new Map(runner.getRegisteredCommands().map((c) => [c.invocationName, c]));
		await commands.get("keep")?.handler("t-1", runner.createCommandContext());
		await commands.get("show")?.handler("", runner.createCommandContext());
		expect(stored.get("delta/token")).toBe("t-1");
		expect((globalThis as { __shown?: unknown }).__shown).toEqual(["t-1", "keychain"]);
	});
});

describe("RpcClient views and host requests", () => {
	type Private = {
		send: (command: { type: string }) => Promise<unknown>;
		getData: <T>(response: unknown) => T;
		handleLine: (line: string) => void;
		process: { stdin: { destroyed: boolean; writable: boolean; write: (data: string) => void } } | null;
	};

	it("sends the view commands", async () => {
		const client = new RpcClient();
		const p = client as unknown as Private;
		const sent: unknown[] = [];
		p.send = vi.fn(async (command) => {
			sent.push(command);
			return { data: command.type === "view_request" ? { value: 42 } : { views: [] } };
		});
		p.getData = <T>(response: unknown): T => (response as { data: T }).data;
		await client.listViews();
		await client.getView("vos");
		expect(await client.viewRequest("vos", "status", { a: 1 })).toBe(42);
		await client.attachViews();
		expect(sent).toEqual([
			{ type: "list_views" },
			{ type: "get_view", viewId: "vos" },
			{ type: "view_request", viewId: "vos", method: "status", params: { a: 1 } },
			{ type: "attach_views" },
		]);
	});

	it("answers host requests with the handler, or an error without one, and never as events", async () => {
		const written: string[] = [];
		const stdin = { destroyed: false, writable: true, write: (data: string) => written.push(data) };
		const events: unknown[] = [];
		const withHandler = new RpcClient({
			onHostRequest: (request) => (request.method === "secrets_get" ? `value-of-${request.key}` : null),
		});
		(withHandler as unknown as Private).process = { stdin };
		withHandler.onEvent((event) => events.push(event));
		(withHandler as unknown as Private).handleLine(
			JSON.stringify({ type: "host_request", id: "h1", method: "secrets_get", scope: "vos", key: "apiKey" }),
		);
		const bare = new RpcClient();
		(bare as unknown as Private).process = { stdin };
		(bare as unknown as Private).handleLine(
			JSON.stringify({ type: "host_request", id: "h2", method: "secrets_get" }),
		);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(written.map((line) => JSON.parse(line))).toEqual([
			{ type: "host_response", id: "h2", error: "This client keeps no secrets" },
			{ type: "host_response", id: "h1", value: "value-of-apiKey" },
		]);
		expect(events).toEqual([]);
	});
});
