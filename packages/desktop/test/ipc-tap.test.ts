import crypto from "node:crypto";
import type { BrowserWindow } from "electron";
import { describe, expect, test, vi } from "vitest";

const fake = vi.hoisted(() => {
	const registered = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
	const ipcMain = {
		handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) {
			registered.set(channel, listener);
		},
		on(_channel: string, _listener: unknown) {},
	};
	return { ipcMain, registered };
});
vi.mock("electron", () => ({ ipcMain: fake.ipcMain }));

import { inProcessTransport, invokeHandler, mirrorWindow, onWindowSend, tapIpc } from "../src/main/ipc-tap.ts";
import { selfSignedWithNode, spkiFingerprint } from "../src/main/mobile/tls.ts";
import { DesktopClient, DesktopError } from "../src/main/mobile/transport.ts";

/**
 * The iPhone bridge reaches the desktop in-process: the handlers the window
 * calls, recorded by the tap, and the messages the window is sent, fanned
 * out by the mirror. These pin that seam with a stand-in for ipcMain.
 */

function fakeWindow() {
	const sent: [string, unknown[]][] = [];
	const win = {
		webContents: {
			send: (channel: string, ...args: unknown[]) => {
				sent.push([channel, args]);
			},
		},
	};
	return { win: win as unknown as BrowserWindow, sent };
}

describe("ipc tap and the in-process transport", () => {
	tapIpc();
	const state = { rows: [{ id: "a", title: "One" }] };
	fake.ipcMain.handle("app:sessions", (_event, query) =>
		query === "boom" ? Promise.reject(new Error("boom")) : state.rows,
	);
	fake.ipcMain.handle("agent:call", (_event, method, args) =>
		method === "fail" ? { ok: false, error: "No API key" } : { ok: true, value: { method, args } },
	);

	test("handlers registered after the tap are recorded and still registered with Electron", () => {
		expect(invokeHandler("app:sessions")).toBeTypeOf("function");
		expect(fake.registered.has("app:sessions")).toBe(true);
	});

	test("invoke calls the recorded handler directly; an unknown channel is refused", async () => {
		const transport = inProcessTransport();
		expect(await transport.invoke("app:sessions")).toBe(state.rows);
		await expect(transport.invoke("app:nope")).rejects.toThrow("no handler: app:nope");
	});

	test("the bridge's client sees JSON copies, desktop errors as -32006, and agent failures thrown", async () => {
		const client = new DesktopClient(inProcessTransport());
		const rows = await client.invoke<{ id: string; title: string }[]>("app:sessions", undefined);
		expect(rows).toEqual(state.rows);
		rows[0]!.title = "changed by the phone";
		expect(state.rows[0]!.title).toBe("One");
		const error = await client.invoke("app:sessions", "boom").catch((e: unknown) => e);
		expect(error).toBeInstanceOf(DesktopError);
		expect((error as DesktopError).code).toBe(-32006);
		expect(await client.call("getState", 1, undefined)).toEqual({ method: "getState", args: [1, null] });
		await expect(client.call("fail")).rejects.toThrow("No API key");
	});

	test("what the window is sent reaches the listeners too, once, even if one of them throws", () => {
		const { win, sent } = fakeWindow();
		mirrorWindow(win);
		mirrorWindow(win);
		const heard: [string, unknown[]][] = [];
		const stopThrowing = onWindowSend(() => {
			throw new Error("listener trouble");
		});
		const stop = onWindowSend((channel, args) => heard.push([channel, args]));
		win.webContents.send("agent:busy", ["/a.jsonl"]);
		expect(sent).toEqual([["agent:busy", [["/a.jsonl"]]]]);
		expect(heard).toEqual([["agent:busy", [["/a.jsonl"]]]]);
		stop();
		stopThrowing();
		win.webContents.send("agent:busy", []);
		expect(heard).toHaveLength(1);
		expect(sent).toHaveLength(2);
	});

	test("the bridge's client gets the window's messages as copies, and stops on close", async () => {
		const { win } = fakeWindow();
		mirrorWindow(win);
		const client = new DesktopClient(inProcessTransport());
		const events: [string, unknown[]][] = [];
		client.on("event", (channel: string, args: unknown[]) => events.push([channel, args]));
		const up = new Promise((resolve) => client.once("up", resolve));
		client.start();
		expect(await up).toEqual({ restarted: false });
		const payload = { type: "agent_start" };
		win.webContents.send("agent:event", payload, 3);
		expect(events).toEqual([["agent:event", [{ type: "agent_start" }, 3]]]);
		expect(events[0]![1][0]).not.toBe(payload);
		client.close();
		win.webContents.send("agent:event", payload, 3);
		expect(events).toHaveLength(1);
	});
});

describe("the certificate made without openssl", () => {
	test("is a self-signed P-256 certificate whose SPKI hash is the pinned fingerprint", () => {
		const { cert, key } = selfSignedWithNode("Smolt");
		const x509 = new crypto.X509Certificate(cert);
		expect(x509.verify(x509.publicKey)).toBe(true);
		expect(x509.publicKey.asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
		expect(x509.checkPrivateKey(crypto.createPrivateKey(key))).toBe(true);
		const spki = crypto.createPublicKey(key).export({ type: "spki", format: "der" });
		expect(spkiFingerprint(cert)).toBe(crypto.createHash("sha256").update(spki).digest("base64url"));
	});
});
