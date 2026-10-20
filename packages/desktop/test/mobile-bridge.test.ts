import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TLSSocket } from "node:tls";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import { MobileBridge, type MobileState } from "../src/main/mobile/bridge.ts";
import { AUTH_PREFIX } from "../src/main/mobile/protocol.ts";
import { FakeSmoltDesktop } from "./fake-smolt-desktop.ts";

/**
 * Smolt for iPhone, end to end inside the test process: the bridge the desktop
 * runs (mobile/bridge.ts) on a real WSS port, a fake desktop behind the same
 * in-process transport the app gives it (handlers called directly, the
 * window's messages fanned out), and a phone speaking the mobile protocol:
 * pairing with the pinned certificate, the lockout, challenge/verify, then
 * every mapping of the desktop (chats, streaming, steer, approvals, prompts,
 * following the desktop, forks, projects, settings) and removal.
 */

type Frame = {
	jsonrpc: "2.0";
	id?: number;
	method?: string;
	params?: any;
	result?: any;
	error?: { code: number; message: string };
};

class RpcFailure extends Error {
	code: number;
	constructor(code: number, message: string) {
		super(`${code} ${message}`);
		this.code = code;
	}
}

class Phone {
	ws!: WebSocket;
	frames: Frame[] = [];
	/** SPKI SHA-256 (base64url) of the certificate the server presented. */
	fingerprint = "";
	closeCode = 0;
	private nextId = 1;
	private waiters: (() => void)[] = [];

	static async connect(url: string): Promise<Phone> {
		const p = new Phone();
		// The phone pins the certificate's key instead of trusting a CA: accept it, then compare.
		p.ws = new WebSocket(url, { rejectUnauthorized: false, maxPayload: 64 * 1024 * 1024 });
		p.ws.on("upgrade", (res) => {
			const cert = (res.socket as TLSSocket).getPeerX509Certificate?.();
			if (cert) {
				const spki = cert.publicKey.export({ type: "spki", format: "der" });
				p.fingerprint = crypto.createHash("sha256").update(spki).digest("base64url");
			}
		});
		p.ws.on("message", (d) => {
			p.frames.push(JSON.parse(String(d)));
			for (const w of p.waiters.splice(0)) w();
		});
		p.ws.on("close", (code) => {
			p.closeCode = code;
			for (const w of p.waiters.splice(0)) w();
		});
		await new Promise<void>((resolve, reject) => {
			p.ws.once("open", () => resolve());
			p.ws.once("error", reject);
		});
		return p;
	}

	async waitFor(pred: (f: Frame) => boolean, what: string, timeoutMs = 10_000, from = 0): Promise<Frame> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const hit = this.frames.slice(from).find(pred);
			if (hit) return hit;
			if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
			await new Promise<void>((r) => {
				this.waiters.push(r);
				setTimeout(r, 200);
			});
		}
	}

	async call(method: string, params: object = {}): Promise<any> {
		const id = this.nextId++;
		this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
		const f = await this.waitFor((f) => f.id === id, `response to ${method}`, 20_000);
		if (f.error) throw new RpcFailure(f.error.code, f.error.message);
		return f.result;
	}

	async expectError(code: number, method: string, params: object = {}): Promise<string> {
		try {
			await this.call(method, params);
		} catch (e) {
			if (e instanceof RpcFailure && e.code === code) return e.message;
			throw new Error(`${method}: expected error ${code}, got ${(e as Error).message}`);
		}
		throw new Error(`${method}: expected error ${code}, got success`);
	}

	async streamOf(messageId: string, timeoutMs = 20_000) {
		await this.waitFor(
			(f) =>
				f.method === "stream.event" && f.params.messageId === messageId && f.params.event.type === "message_stop",
			`message_stop for ${messageId}`,
			timeoutMs,
		);
		return this.events(messageId);
	}

	events(messageId: string): any[] {
		return this.frames
			.filter((f) => f.method === "stream.event" && f.params.messageId === messageId)
			.map((f) => f.params);
	}

	/** Index of the next frame, to wait only for what comes after this point. */
	get mark(): number {
		return this.frames.length;
	}

	async closed(timeoutMs = 5000): Promise<number> {
		const deadline = Date.now() + timeoutMs;
		while (this.ws.readyState !== WebSocket.CLOSED) {
			if (Date.now() > deadline) throw new Error("timed out waiting for the socket to close");
			await new Promise((r) => setTimeout(r, 20));
		}
		return this.closeCode;
	}

	close() {
		this.ws.terminate();
	}
}

/** A device key as the phone makes it: P-256, public half as the X9.63 point, base64. */
function makeDeviceKey() {
	const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
	const jwk = publicKey.export({ format: "jwk" });
	const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]);
	const sign = (nonce: string) =>
		crypto
			.sign("sha256", Buffer.from(AUTH_PREFIX + nonce, "utf8"), { key: privateKey, dsaEncoding: "der" })
			.toString("base64");
	return { publicKey: raw.toString("base64"), sign };
}

/** seq 1..n, message_start first, message_stop last with this status; blocks started before use. */
function expectWellFormedStream(events: any[], status: string) {
	expect(events.length).toBeGreaterThanOrEqual(2);
	expect(events.map((e) => e.seq)).toEqual(events.map((_e, i) => i + 1));
	expect(events[0].event.type).toBe("message_start");
	expect(events[0].event.message.status).toBe("streaming");
	const last = events[events.length - 1].event;
	expect(last.type).toBe("message_stop");
	expect(last.status).toBe(status);
	const started = new Set<number>();
	for (const { event: e } of events) {
		if (e.type === "block_start") {
			expect(e.index).toBe(started.size);
			started.add(e.index);
		} else if (e.type === "block_delta" || e.type === "block_stop") {
			expect(started.has(e.index)).toBe(true);
		}
	}
}

const textFrom = (events: any[]) =>
	events
		.filter((e) => e.event.type === "block_delta" && e.event.delta.type === "text_delta")
		.map((e) => e.event.delta.text)
		.join("");
const blockTypes = (events: any[]) =>
	events.filter((e) => e.event.type === "block_start").map((e) => e.event.block.type);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, what: string, ms = 5000) {
	const deadline = Date.now() + ms;
	while (!cond()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await sleep(20);
	}
}

const COMPUTER = "Test Mac";

describe("iPhone bridge (in-process transport)", { timeout: 30_000 }, () => {
	const desktop = new FakeSmoltDesktop();
	let dataDir = "";
	let bridge: MobileBridge;
	const states: MobileState[] = [];
	let phone!: Phone;
	let device = makeDeviceKey();
	let deviceId = "";
	let url = "";
	const agentCallsSince = (n: number) => desktop.agentCalls.slice(n).map((c) => c.method);
	const loginId = `cnv_${desktop.sessionByName("Fix the login bug").id}`;
	const websiteId = `cnv_${desktop.active.id}`;
	let loginMessages: any[] = [];
	let sentAssistant = "";

	const makeBridge = () =>
		new MobileBridge({
			dataDir,
			transport: desktop.transport(),
			computerName: COMPUTER,
			osName: "macOS 26.0",
			bonjour: false,
			writeLinkFile: true,
			host: "127.0.0.1",
			log: () => {},
			onState: (state) => states.push(state),
		});

	beforeAll(() => {
		dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "smolt-mobile-"));
		// Port 0: a free one, read back from the state.
		fs.writeFileSync(path.join(dataDir, "mobile.json"), JSON.stringify({ enabled: false, port: 0 }));
		bridge = makeBridge();
	});

	afterAll(async () => {
		phone?.close();
		await bridge?.stop();
		fs.rmSync(dataDir, { recursive: true, force: true });
	});

	test("off by default: nothing listens, no code, no devices", () => {
		const fresh = new MobileBridge({
			dataDir: path.join(dataDir, "never"),
			transport: desktop.transport(),
			computerName: COMPUTER,
			osName: "macOS",
			log: () => {},
		});
		const state = fresh.state();
		expect(state.enabled).toBe(false);
		expect(state.running).toBe(false);
		expect(state.port).toBe(7350);
		expect(state.pairing).toBeUndefined();
		expect(state.devices).toEqual([]);
		expect(fs.existsSync(path.join(dataDir, "never"))).toBe(false);
	});

	test("switching it on: wss with a pinned P-256 certificate, a pairing link, a QR, a code", async () => {
		const state = await bridge.setEnabled(true);
		expect(state.enabled && state.running && state.secure).toBe(true);
		expect(JSON.parse(fs.readFileSync(path.join(dataDir, "mobile.json"), "utf8")).enabled).toBe(true);
		expect(state.port).toBeGreaterThan(0);
		const pairing = state.pairing!;
		expect(pairing.code).toMatch(/^\d{6}$/);
		expect(pairing.expiresAt).toBeGreaterThan(Date.now() + 4 * 60_000);
		expect(pairing.qrSvg.startsWith("<svg")).toBe(true);
		const link = new URL(pairing.link);
		expect(link.protocol).toBe("smolt:");
		expect(link.searchParams.get("v")).toBe("1");
		expect(link.searchParams.get("n")).toBe(COMPUTER);
		expect(link.searchParams.get("p")).toBe(String(state.port));
		expect(link.searchParams.get("c")).toBe(pairing.code);
		expect(link.searchParams.get("h")!.split(",")).toEqual(state.addresses.map((a) => a.host));
		expect(link.searchParams.get("fp")).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(fs.readFileSync(path.join(dataDir, "pair-link.txt"), "utf8").trim()).toBe(pairing.link);
		const cert = new crypto.X509Certificate(fs.readFileSync(path.join(dataDir, "tls-cert.pem")));
		expect(cert.publicKey.asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
		expect(states.at(-1)?.running).toBe(true);
		url = `wss://127.0.0.1:${state.port}/smolt`;
	});

	test("the server presents the certificate the link pins", async () => {
		phone = await Phone.connect(url);
		expect(phone.fingerprint).toBe(new URL(bridge.state().pairing!.link).searchParams.get("fp"));
	});

	test("everything but pairing and auth waits for authentication", async () => {
		await phone.expectError(-32001, "bootstrap");
		await phone.expectError(-32001, "conversations.list");
		await phone.expectError(-32601, "no.such.method");
	});

	test("five wrong codes lock pairing until a new code is asked for", async () => {
		const real = bridge.state().pairing!.code;
		const wrong = real === "000000" ? "111111" : "000000";
		for (let i = 0; i < 5; i++) {
			await phone.expectError(-32002, "pair.request", { code: wrong, deviceName: "x", publicKey: device.publicKey });
		}
		const locked = bridge.state();
		expect(locked.lockedOut).toBe(true);
		expect(locked.pairing).toBeUndefined();
		expect(fs.existsSync(path.join(dataDir, "pair-link.txt"))).toBe(false);
		// Even the right code no longer works.
		await phone.expectError(-32002, "pair.request", { code: real, deviceName: "x", publicKey: device.publicKey });
		const renewed = bridge.newCode();
		expect(renewed.lockedOut).toBe(false);
		expect(renewed.pairing?.code).toMatch(/^\d{6}$/);
	});

	test("a bad public key is refused before the code is spent", async () => {
		const code = bridge.state().pairing!.code;
		await phone.expectError(-32602, "pair.request", {
			code,
			deviceName: "x",
			publicKey: Buffer.from("nope").toString("base64"),
		});
		expect(bridge.state().pairing?.code).toBe(code);
	});

	test("pairing with the code from the link: one use, the device listed, a new code made", async () => {
		const code = new URL(bridge.state().pairing!.link).searchParams.get("c");
		const res = await phone.call("pair.request", {
			code,
			deviceName: "Rob's iPhone",
			deviceModel: "iPhone17,1",
			publicKey: device.publicKey,
		});
		expect(res.deviceId).toMatch(/^dev_/);
		expect(res.computerName).toBe(COMPUTER);
		deviceId = res.deviceId;
		const state = bridge.state();
		expect(state.pairing?.code).not.toBe(code);
		expect(state.devices).toHaveLength(1);
		expect(state.devices[0]).toMatchObject({
			id: deviceId,
			name: "Rob's iPhone",
			model: "iPhone17,1",
			connected: true,
		});
		// The code is spent: a second phone cannot reuse it.
		const other = await Phone.connect(url);
		await other.expectError(-32002, "pair.request", { code, deviceName: "y", publicKey: makeDeviceKey().publicKey });
		other.close();
	});

	test("a new connection proves the device with an ECDSA signature over the nonce", async () => {
		const second = await Phone.connect(url);
		await second.expectError(-32001, "auth.challenge", { deviceId: "dev_unknown" });
		const { nonce } = await second.call("auth.challenge", { deviceId });
		// A signature by another key fails, and the nonce is gone with it.
		await second.expectError(-32001, "auth.verify", { deviceId, signature: makeDeviceKey().sign(nonce) });
		await second.expectError(-32001, "auth.verify", { deviceId, signature: device.sign(nonce) });
		const fresh = await second.call("auth.challenge", { deviceId });
		const ok = await second.call("auth.verify", { deviceId, signature: device.sign(fresh.nonce) });
		expect(ok.computerName).toBe(COMPUTER);
		expect(ok.features).toContain("follows_desktop");
		await second.call("bootstrap");
		second.close();
	});

	test("bootstrap: Smolt's models (provider, thinking levels), settings, features, permission modes", async () => {
		const b = await phone.call("bootstrap");
		expect(b.computer).toEqual({ name: COMPUTER, os: "macOS 26.0" });
		for (const f of [
			"follows_desktop",
			"thinking_levels",
			"prompts",
			"approvals",
			"files",
			"search",
			"steer",
			"permission_modes",
			"projects",
			"project_folders",
		]) {
			expect(b.features).toContain(f);
		}
		for (const f of ["artifacts", "styles", "web_search"]) expect(b.features).not.toContain(f);
		const models = b.models;
		expect(models.some((m: any) => m.provider === "openai")).toBe(false);
		const opus = models.find((m: any) => m.id === "anthropic/claude-opus-5-5");
		expect(opus).toMatchObject({
			isDefault: true,
			provider: "anthropic",
			supportsImages: true,
			supportsThinking: true,
		});
		expect(opus.thinkingLevels).toEqual(["auto", "off", "low", "medium", "high", "xhigh", "max"]);
		const fake = models.find((m: any) => m.id === "fake/fake-1");
		expect(fake.supportsImages).toBe(false);
		expect(fake.thinkingLevels).toEqual(["auto", "off"]);
		expect(b.settings.defaultModel).toBe("anthropic/claude-opus-5-5");
		expect(b.settings.thinkingLevel).toBe("medium");
		expect(b.settings.permissionMode).toBe("auto");
		expect(b.permissionModes.map((m: any) => m.id).join()).toBe("auto,acceptEdits,manual,plan,bypass");
		expect(Array.isArray(b.pendingApprovals) && Array.isArray(b.pendingPrompts)).toBe(true);
		await phone.expectError(-32601, "artifacts.list");
	});

	test("conversations.list: Smolt's sessions, newest first, stable ids, the open one marked", async () => {
		const r = await phone.call("conversations.list");
		expect(r.items).toHaveLength(2);
		expect(r.items.map((c: any) => c.id)).toEqual([websiteId, loginId]);
		expect(r.items[0].title).toBe("");
		expect(r.items[1].title).toBe("Fix the login bug");
		expect(r.items[0].desktopActive).toBe(true);
		expect(r.items[1].desktopActive).toBeFalsy();
		expect(r.items[1].preview).toMatch(/^Why does login fail/);
		const again = await phone.call("conversations.list");
		expect(again.items[1].id).toBe(loginId);
	});

	test("conversations.get maps the transcript: user + image, one assistant turn with thinking, tool_use, tool_result", async () => {
		const r = await phone.call("conversations.get", { id: loginId });
		loginMessages = r.messages;
		expect(r.messages).toHaveLength(2);
		const [u, a] = r.messages;
		expect(u.role).toBe("user");
		expect(u.content[0].text).toMatch(/^Why does login fail/);
		expect(u.parentId).toBeUndefined();
		expect(u.attachments).toHaveLength(1);
		expect(u.attachments[0]).toMatchObject({ kind: "image", width: 2 });
		expect(a).toMatchObject({
			role: "assistant",
			parentId: u.id,
			status: "complete",
			model: "anthropic/claude-opus-5-5",
		});
		expect(a.content.map((b: any) => b.type).join()).toBe("thinking,text,tool_use,tool_result,text");
		expect(a.content[2]).toMatchObject({
			name: "read",
			status: "done",
			title: "Reading src/auth.ts",
			input: { path: "src/auth.ts" },
		});
		expect(a.content[3].toolUseId).toBe("toolu_01");
		expect(a.content[3].content).toContain("return false");
		expect(r.conversation.currentLeafId).toBe(a.id);
		const file = await phone.call("files.download", { id: u.attachments[0].id });
		expect(file.mimeType).toBe("image/png");
		expect(file.data.length).toBeGreaterThan(10);
		const search = await phone.call("conversations.search", { query: "check()" });
		expect(search.items).toHaveLength(1);
		expect(search.items[0].conversation.id).toBe(loginId);
		expect(search.items[0].snippet).toContain("check()");
	});

	test("chat.send to another chat switches the desktop to it, then streams thinking, text, a tool call and its result", async () => {
		const before = desktop.agentCalls.length;
		const from = phone.mark;
		const r = await phone.call("chat.send", {
			conversationId: loginId,
			text: "Run the tests please",
			options: { thinkingLevel: "high" },
		});
		expect(r.conversationId).toBe(loginId);
		expect(r.userMessageId).toMatch(/^msg_/);
		expect(r.assistantMessageId).toMatch(/^msg_/);
		const calls = agentCallsSince(before);
		expect(calls.indexOf("switchSession")).toBeGreaterThanOrEqual(0);
		expect(calls.indexOf("switchSession")).toBeLessThan(calls.indexOf("prompt"));
		expect(calls).toContain("setThinkingLevel");
		expect(desktop.thinking).toBe("high");
		const prompt = desktop.agentCalls.find((c, i) => i >= before && c.method === "prompt")!;
		expect(prompt.args[0]).toBe("Run the tests please");
		expect(prompt.args[2]).toBe("steer");
		const events = await phone.streamOf(r.assistantMessageId);
		expectWellFormedStream(events, "complete");
		const response = phone.frames.findIndex(
			(f) => f.id !== undefined && f.result?.assistantMessageId === r.assistantMessageId,
		);
		const firstEvent = phone.frames.findIndex(
			(f) => f.method === "stream.event" && f.params.messageId === r.assistantMessageId,
		);
		expect(response).toBeLessThan(firstEvent);
		expect(events[0].event.message.parentId).toBe(r.userMessageId);
		expect(blockTypes(events).join()).toBe("thinking,text,tool_use,tool_result,text");
		expect(
			events.some(
				(e) =>
					e.event.type === "block_delta" &&
					e.event.delta.type === "thinking_delta" &&
					e.event.delta.thinking === "think.",
			),
		).toBe(true);
		expect(events.some((e) => e.event.type === "block_delta" && e.event.delta.type === "input_json_delta")).toBe(
			true,
		);
		const toolStops = events.filter((e) => e.event.type === "block_stop" && e.event.block?.type === "tool_use");
		expect(toolStops.at(-1).event.block).toMatchObject({ status: "done", input: { command: "echo hi" } });
		expect(textFrom(events)).toBe("I'll run a command.Done: it printed hi.");
		expect(
			phone.frames
				.slice(from)
				.some(
					(f) =>
						f.method === "conversation.updated" &&
						f.params.conversation.id === loginId &&
						f.params.reason === "desktop_switched",
				),
		).toBe(true);
		const got = await phone.call("conversations.get", { id: loginId });
		const ids = got.messages.map((m: any) => m.id);
		expect(ids).toContain(r.userMessageId);
		expect(ids).toContain(r.assistantMessageId);
		const a = got.messages.find((m: any) => m.id === r.assistantMessageId);
		expect(a.content.map((b: any) => b.type).join()).toBe("thinking,text,tool_use,tool_result,text");
		expect(a.status).toBe("complete");
		expect(got.conversation.isGenerating).toBe(false);
		sentAssistant = r.assistantMessageId;
	});

	test("chat.stop: a slow reply mid-stream (get shows it streaming with seq), stopped; a busy send is -32004", async () => {
		const r = await phone.call("chat.send", { conversationId: loginId, text: "write something slow" });
		await phone.waitFor(
			(f) =>
				f.method === "stream.event" &&
				f.params.messageId === r.assistantMessageId &&
				f.params.event.type === "block_delta",
			"first delta",
		);
		await phone.expectError(-32004, "chat.send", { conversationId: loginId, text: "another" });
		const snap = await phone.call("conversations.get", { id: loginId });
		const live = snap.messages.find((m: any) => m.id === r.assistantMessageId);
		expect(live.status).toBe("streaming");
		expect(live.seq).toBeGreaterThanOrEqual(1);
		expect(snap.conversation.isGenerating).toBe(true);
		expect(snap.messages.filter((m: any) => m.id === r.userMessageId)).toHaveLength(1);
		await phone.call("chat.stop", { conversationId: loginId });
		expectWellFormedStream(await phone.streamOf(r.assistantMessageId), "stopped");
		const got = await phone.call("conversations.get", { id: loginId });
		expect(got.messages.find((m: any) => m.id === r.assistantMessageId)?.status).toBe("stopped");
	});

	test("steer: a message sent while the reply streams goes into it (options.deliver)", async () => {
		const r = await phone.call("chat.send", { conversationId: loginId, text: "another slow one" });
		await phone.waitFor(
			(f) =>
				f.method === "stream.event" &&
				f.params.messageId === r.assistantMessageId &&
				f.params.event.type === "block_delta",
			"first delta",
		);
		const s = await phone.call("chat.send", {
			conversationId: loginId,
			text: "use tabs",
			options: { deliver: "steer" },
		});
		expect(s.assistantMessageId).toBe("");
		expect(s.userMessageId).toMatch(/^msg_/);
		const prompt = desktop.agentCalls.filter((c) => c.method === "prompt").at(-1)!;
		expect(prompt.args[0]).toBe("use tabs");
		expect(prompt.args[2]).toBe("steer");
		await phone.streamOf(r.assistantMessageId);
		const user = await phone.waitFor(
			(f) =>
				f.method === "stream.event" &&
				f.params.messageId === s.userMessageId &&
				f.params.event.type === "message_start",
			"steered message",
		);
		expect(user.params.event.message.content[0].text).toBe("use tabs");
		const next = await phone.waitFor(
			(f) =>
				f.method === "stream.event" &&
				f.params.event.type === "message_start" &&
				f.params.event.message.parentId === s.userMessageId,
			"reply to the steer",
		);
		expect(textFrom(await phone.streamOf(next.params.messageId))).toBe("Got it: use tabs");
		const got = await phone.call("conversations.get", { id: loginId });
		expect(got.messages.some((m: any) => m.id === s.userMessageId)).toBe(true);
	});

	test("approvals: permission:request -> approval.requested; allow_once -> app:permission-reply 'allow'", async () => {
		const from = phone.mark;
		const r = await phone.call("chat.send", { conversationId: loginId, text: "please approve the cleanup" });
		const req = await phone.waitFor((f) => f.method === "approval.requested", "approval.requested", 10_000, from);
		const a = req.params.approval;
		expect(a).toMatchObject({
			toolName: "bash",
			title: "Run a command",
			conversationId: loginId,
			messageId: r.assistantMessageId,
		});
		expect(a.detail).toContain("rm -rf build");
		expect(a.detail).toContain("recursive force delete");
		expect(a.expiresAt).toBeGreaterThan(Date.now() + 4 * 60_000);
		const b = await phone.call("bootstrap");
		expect(b.pendingApprovals.some((x: any) => x.id === a.id)).toBe(true);
		await phone.call("approvals.respond", { id: a.id, decision: "allow_once" });
		const reply = desktop.invokes.filter((i) => i.channel === "app:permission-reply").at(-1)!;
		expect(reply.args).toEqual([a.id, "allow"]);
		await phone.waitFor(
			(f) => f.method === "approval.resolved" && f.params.id === a.id,
			"approval.resolved",
			5000,
			from,
		);
		const events = await phone.streamOf(r.assistantMessageId);
		expect(
			events.some(
				(e) =>
					e.event.type === "block_start" &&
					e.event.block.type === "tool_result" &&
					e.event.block.content === "removed build/",
			),
		).toBe(true);
		await phone.expectError(-32003, "approvals.respond", { id: a.id, decision: "deny" });
	});

	test("prompts: extension confirm -> prompt.requested; prompts.respond -> respondExtensionUI with slotId", async () => {
		const from = phone.mark;
		const r = await phone.call("chat.send", { conversationId: loginId, text: "ask before deploying" });
		const req = await phone.waitFor((f) => f.method === "prompt.requested", "prompt.requested", 10_000, from);
		const p = req.params.prompt;
		expect(p).toMatchObject({
			kind: "confirm",
			title: "Deploy now?",
			message: "This pushes to production.",
			conversationId: loginId,
		});
		const b = await phone.call("bootstrap");
		expect(b.pendingPrompts.some((x: any) => x.id === p.id)).toBe(true);
		await phone.call("prompts.respond", { id: p.id, confirmed: true });
		const call = desktop.agentCalls.filter((c) => c.method === "respondExtensionUI").at(-1)!;
		expect(call.args[0]).toMatchObject({ id: p.id, confirmed: true, slotId: desktop.slot });
		await phone.waitFor((f) => f.method === "prompt.resolved" && f.params.id === p.id, "prompt.resolved", 5000, from);
		expect(textFrom(await phone.streamOf(r.assistantMessageId))).toBe("confirmed: true");
		await phone.expectError(-32003, "prompts.respond", { id: p.id, confirmed: false });
	});

	test("the desktop switching chats is announced (desktop_switched); a turn typed on the desktop streams to the phone", async () => {
		const from = phone.mark;
		desktop.pcSwitch([...desktop.sessions.values()].find((s) => `cnv_${s.id}` === websiteId)!.path);
		const upd = await phone.waitFor(
			(f) =>
				f.method === "conversation.updated" &&
				f.params.reason === "desktop_switched" &&
				f.params.conversation.id === websiteId,
			"switch announced",
			5000,
			from,
		);
		expect(upd.params.conversation.desktopActive).toBe(true);
		await phone.call("conversations.subscribe", { id: websiteId });
		desktop.pcPrompt("typed on the PC");
		const user = await phone.waitFor(
			(f) =>
				f.method === "stream.event" &&
				f.params.conversationId === websiteId &&
				f.params.event.type === "message_start" &&
				f.params.event.message.role === "user",
			"the desktop's message",
			10_000,
			from,
		);
		expect(user.params.event.message.content[0].text).toBe("typed on the PC");
		const reply = await phone.waitFor(
			(f) =>
				f.method === "stream.event" &&
				f.params.conversationId === websiteId &&
				f.params.event.type === "message_start" &&
				f.params.event.message.role === "assistant",
			"the desktop's reply",
			10_000,
			from,
		);
		expect(reply.params.event.message.parentId).toBe(user.params.messageId);
		expectWellFormedStream(await phone.streamOf(reply.params.messageId), "complete");
		const got = await phone.call("conversations.get", { id: websiteId });
		expect(got.messages.at(-1).id).toBe(reply.params.messageId);
		expect(got.messages.at(-2).id).toBe(user.params.messageId);
	});

	test("chat.retry forks before the user message and resends it; the reply is in a new conversation", async () => {
		const before = desktop.agentCalls.length;
		const from = phone.mark;
		const r = await phone.call("chat.retry", { conversationId: loginId, messageId: sentAssistant });
		expect(r.conversationId).toBeTruthy();
		expect(r.conversationId).not.toBe(loginId);
		expect(r.assistantMessageId).toMatch(/^msg_/);
		const calls = agentCallsSince(before);
		expect(calls.indexOf("getForkMessages")).toBeLessThan(calls.indexOf("fork"));
		expect(calls.indexOf("fork")).toBeLessThan(calls.indexOf("prompt"));
		const fork = desktop.agentCalls.find((c, i) => i >= before && c.method === "fork")!;
		const forkedFrom = desktop.sessionByName("Fix the login bug");
		expect(forkedFrom.entries.find((e) => e.id === fork.args[0])?.message.content[0].text).toBe(
			"Run the tests please",
		);
		expect(desktop.agentCalls.filter((c) => c.method === "prompt").at(-1)!.args[0]).toBe("Run the tests please");
		await phone.streamOf(r.assistantMessageId);
		await phone.waitFor(
			(f) => f.method === "conversation.updated" && f.params.conversation.id === r.conversationId,
			"new conversation announced",
			5000,
			from,
		);
		const got = await phone.call("conversations.get", { id: r.conversationId });
		expect(got.messages).toHaveLength(4);
		expect(got.messages[1].id).toBe(loginMessages[1].id);
		expect(got.messages.at(-1).id).toBe(r.assistantMessageId);
		expect(got.messages.at(-2).content[0].text).toBe("Run the tests please");
	});

	test("edit (chat.send with parentId) forks too; a new chat (no conversationId) is newSession", async () => {
		const r = await phone.call("chat.send", { conversationId: loginId, parentId: "", text: "Why does signup fail?" });
		expect(r.conversationId).not.toBe(loginId);
		await phone.streamOf(r.assistantMessageId);
		const got = await phone.call("conversations.get", { id: r.conversationId });
		expect(got.messages).toHaveLength(2);
		expect(got.messages[0].content[0].text).toBe("Why does signup fail?");
		const before = desktop.agentCalls.length;
		const n = await phone.call("chat.send", { text: "brand new chat" });
		expect(agentCallsSince(before)[0]).toBe("newSession");
		await phone.streamOf(n.assistantMessageId);
		const list = await phone.call("conversations.list");
		expect(list.items[0].id).toBe(n.conversationId);
	});

	test("projects are Smolt's folders; conversations filter by folder; chat.send with projectId opens the folder", async () => {
		const pr = await phone.call("projects.list");
		expect(pr.items).toHaveLength(2);
		expect(pr.items[0]).toMatchObject({ name: "smolt-mobile", description: "/work/smolt-mobile" });
		const website = pr.items.find((p: any) => p.name === "website");
		const inWebsite = await phone.call("conversations.list", { projectId: website.id });
		expect(inWebsite.items.some((c: any) => c.id === websiteId)).toBe(true);
		expect(inWebsite.items.some((c: any) => c.id === loginId)).toBe(false);
		expect(inWebsite.items.every((c: any) => c.projectId === website.id)).toBe(true);
		await phone.expectError(-32601, "projects.create", { name: "x" });
		expect((await phone.call("projects.update", { id: website.id, starred: true })).starred).toBe(true);
		const r = await phone.call("chat.send", { projectId: website.id, text: "in the website folder" });
		expect(desktop.invokes.filter((i) => i.channel === "app:open-project").at(-1)!.args[0]).toBe("/work/website");
		await phone.streamOf(r.assistantMessageId);
		const got = await phone.call("conversations.get", { id: r.conversationId });
		expect(got.conversation.projectId).toBe(website.id);
	});

	test("update title/starred, settings (model, level, permission mode), feedback, documents, delete", async () => {
		const u = await phone.call("conversations.update", { id: loginId, title: "Login bug (renamed)", starred: true });
		expect(u.title).toBe("Login bug (renamed)");
		expect(u.starred).toBe(true);
		expect(desktop.sessionByName("Login bug (renamed)")).toBeTruthy();
		const starred = await phone.call("conversations.list", { starred: true });
		expect(starred.items.map((c: any) => c.id)).toEqual([loginId]);
		const s = await phone.call("settings.update", {
			defaultModel: "anthropic/claude-haiku-4-5",
			thinkingLevel: "low",
			permissionMode: "manual",
			nickname: "Rob",
		});
		expect(s).toMatchObject({
			defaultModel: "anthropic/claude-haiku-4-5",
			thinkingLevel: "low",
			permissionMode: "manual",
			nickname: "Rob",
		});
		expect(desktop.agentCalls.filter((c) => c.method === "setModel").at(-1)!.args).toEqual([
			"anthropic",
			"claude-haiku-4-5",
			true,
		]);
		expect(desktop.permissionMode).toBe("manual");
		await phone.expectError(-32602, "settings.update", { defaultModel: "openai/nope" });
		await phone.call("messages.feedback", { conversationId: loginId, messageId: loginMessages[1].id, rating: "up" });
		const got = await phone.call("conversations.get", { id: loginId });
		expect(got.messages[1].feedback).toBe("up");
		const txt = await phone.call("files.upload", {
			name: "notes.md",
			mimeType: "text/markdown",
			data: Buffer.from("# Notes\nhello").toString("base64"),
		});
		const r = await phone.call("chat.send", { conversationId: loginId, text: "read this", attachments: [txt.id] });
		const prompt = desktop.agentCalls.filter((c) => c.method === "prompt").at(-1)!;
		expect(prompt.args[0]).toContain('<file name="notes.md">');
		expect(prompt.args[0]).toContain("# Notes");
		await phone.streamOf(r.assistantMessageId);
		const pdf = await phone.call("files.upload", {
			name: "a.pdf",
			mimeType: "application/pdf",
			data: Buffer.from("%PDF-1.4").toString("base64"),
		});
		expect(
			await phone.expectError(-32602, "chat.send", { conversationId: loginId, text: "read", attachments: [pdf.id] }),
		).toContain("images");
		const from = phone.mark;
		await phone.call("conversations.delete", { id: websiteId });
		await phone.waitFor(
			(f) => f.method === "conversation.deleted" && f.params.id === websiteId,
			"conversation.deleted",
			5000,
			from,
		);
		expect(desktop.invokes.some((i) => i.channel === "app:session-delete")).toBe(true);
		await phone.expectError(-32003, "conversations.get", { id: websiteId });
	});

	test("a desktop handler that fails reaches the phone as -32006 with its message", async () => {
		desktop.broken = "app:sessions";
		try {
			expect(await phone.expectError(-32006, "conversations.list")).toContain("app:sessions is broken");
		} finally {
			desktop.broken = undefined;
		}
		expect((await phone.call("conversations.list")).items.length).toBeGreaterThan(0);
	});

	test("an agent that keeps failing is not asked again and again (each failed call re-announces the slot)", async () => {
		const before = desktop.agentCalls.length;
		desktop.agentDown = true;
		try {
			desktop.pcSwitch(desktop.active.path);
			await sleep(1000);
			const asked = agentCallsSince(before).filter((m) => m === "getState").length;
			expect(asked).toBeGreaterThanOrEqual(1);
			expect(asked).toBeLessThanOrEqual(2);
		} finally {
			desktop.agentDown = false;
		}
		// Once the agent answers again, the bridge follows the desktop again.
		await sleep(3000);
		const from = phone.mark;
		const other = [...desktop.sessions.values()].find((s) => s.written && s.path !== desktop.activePath)!;
		desktop.pcSwitch(other.path);
		await phone.waitFor(
			(f) =>
				f.method === "conversation.updated" &&
				f.params.reason === "desktop_switched" &&
				f.params.conversation.id === `cnv_${other.id}`,
			"the switch announced again",
			8000,
			from,
		);
	});

	test("switching it off closes the port; on again, the paired device signs in with its key", async () => {
		const port = bridge.state().port;
		const off = await bridge.setEnabled(false);
		expect(off.running).toBe(false);
		expect(off.pairing).toBeUndefined();
		expect(await phone.closed()).toBe(1001);
		expect(desktop.subscribers).toBe(0);
		await expect(Phone.connect(url)).rejects.toThrow();
		expect(off.devices.map((d) => d.id)).toEqual([deviceId]);
		expect(off.devices[0]!.connected).toBe(false);
		// A new bridge, as after relaunching the app, on the same port and data.
		fs.writeFileSync(path.join(dataDir, "mobile.json"), JSON.stringify({ enabled: true, port }));
		bridge = makeBridge();
		await bridge.start();
		const fp = new URL(bridge.state().pairing!.link).searchParams.get("fp");
		phone = await Phone.connect(url);
		expect(phone.fingerprint).toBe(fp);
		const { nonce } = await phone.call("auth.challenge", { deviceId });
		await phone.call("auth.verify", { deviceId, signature: device.sign(nonce) });
		expect((await phone.call("conversations.list")).items.length).toBeGreaterThan(0);
		await until(() => bridge.state().devices[0]?.connected === true, "the device to show as connected");
	});

	test("Remove: the phone is told (device.revoked), closed with 4401, and cannot sign in again", async () => {
		const state = bridge.removeDevice(deviceId);
		expect(state.devices).toEqual([]);
		await phone.waitFor((f) => f.method === "device.revoked", "device.revoked");
		expect(await phone.closed()).toBe(4401);
		const again = await Phone.connect(url);
		await again.expectError(-32001, "auth.challenge", { deviceId });
		again.close();
		device = makeDeviceKey();
	});
});
