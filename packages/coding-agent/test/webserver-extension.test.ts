import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import {
	liveWebServerStatus,
	preferredWebServerUrl,
	readWebServerSettings,
	webServerSettingsFile,
	webServerStatusFile,
	writeWebServerSettings,
	writeWebServerStatus,
} from "../src/extensions/webserver/config.ts";
import webserverExtension from "../src/extensions/webserver/index.ts";

/**
 * The web server's switch, from a terminal.
 *
 * The server itself runs in the desktop app, so what is tested here is the
 * contract between them: the settings file both sides write, the status file
 * the app publishes, and what `/webserver` says about them. The link a reader
 * is given has to be one that works, and a status left behind by an app that
 * has since exited has to read as off rather than promise a dead link.
 */

interface FakeContext {
	notices: { text: string; type?: string }[];
	ui: { notify: (text: string, type?: "info" | "warning" | "error") => void };
}

class FakeSmolt {
	commands = new Map<string, { description?: string; handler: (args: string, ctx: FakeContext) => Promise<void> }>();
	reports: string[] = [];

	registerCommand(
		name: string,
		options: { description?: string; handler: (args: string, ctx: FakeContext) => Promise<void> },
	): void {
		this.commands.set(name, options);
	}

	sendMessage(message: { content: string }): void {
		this.reports.push(message.content);
	}
}

let agentDir: string;
let previousAgentDir: string | undefined;
let smolt: FakeSmolt;

function command(): (args: string, ctx: FakeContext) => Promise<void> {
	return smolt.commands.get("webserver")!.handler;
}

function context(): FakeContext {
	const notices: { text: string; type?: string }[] = [];
	return { notices, ui: { notify: (text, type) => notices.push({ text, type }) } };
}

function publishedAt(pid: number): void {
	writeWebServerStatus({
		running: true,
		https: true,
		urls: ["https://localhost:7333", "https://100.64.0.1:7333"],
		pid,
		at: Date.now(),
	});
}

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "smolt-web-agent-"));
	previousAgentDir = process.env.SMOLT_CODING_AGENT_DIR;
	process.env.SMOLT_CODING_AGENT_DIR = agentDir;
	smolt = new FakeSmolt();
	webserverExtension(smolt as unknown as ExtensionAPI);
});

afterEach(() => {
	if (previousAgentDir === undefined) delete process.env.SMOLT_CODING_AGENT_DIR;
	else process.env.SMOLT_CODING_AGENT_DIR = previousAgentDir;
	rmSync(agentDir, { recursive: true, force: true });
});

describe("web server settings", () => {
	it("is off, on the default port, on localhost only, when nothing is configured", () => {
		expect(readWebServerSettings(webServerSettingsFile())).toEqual({
			enabled: false,
			port: 7332,
			lan: false,
		});
	});

	it("round-trips what was written", () => {
		writeWebServerSettings(webServerSettingsFile(), { enabled: true, port: 7444, lan: "10.0.0.3" });
		expect(readWebServerSettings(webServerSettingsFile())).toEqual({
			enabled: true,
			port: 7444,
			lan: "10.0.0.3",
		});
	});

	it("drops a hand-edited address it could not serve on", () => {
		writeWebServerSettings(webServerSettingsFile(), { enabled: true, port: 7332, lan: "0.0.0.0" });
		expect(readWebServerSettings(webServerSettingsFile()).lan).toBe(false);
		writeWebServerSettings(webServerSettingsFile(), { enabled: true, port: 7332, lan: "not-an-address" });
		expect(readWebServerSettings(webServerSettingsFile()).lan).toBe(false);
	});

	it("falls back rather than trusting a file that was hand-edited into nonsense", () => {
		writeWebServerSettings(webServerSettingsFile(), { enabled: true, port: 80, lan: true });
		// A privileged port is not one this was ever given; the default is safer
		// than an unusable value that reads as intentional.
		expect(readWebServerSettings(webServerSettingsFile()).port).toBe(7332);
	});
});

describe("the app's published status", () => {
	it("reads as off once the process that published it is gone", async () => {
		const child = spawn(process.execPath, ["-e", ""]);
		await new Promise((resolve) => child.on("exit", resolve));
		publishedAt(child.pid!);
		expect(liveWebServerStatus()).toBeUndefined();
	});

	it("reads as on while that process is running", () => {
		publishedAt(process.pid);
		expect(liveWebServerStatus()?.urls).toHaveLength(2);
	});

	it("offers the address of the machine the reader is on first", () => {
		publishedAt(process.pid);
		expect(preferredWebServerUrl(liveWebServerStatus()!)).toBe("https://localhost:7333");
	});
});

describe("/webserver", () => {
	it("turns the switch on and reports where to open it", async () => {
		// A report newer than the write is what a running desktop would publish
		// in response; without one this would wait for an app that is not there.
		writeWebServerStatus({
			running: true,
			https: true,
			urls: ["https://localhost:7333"],
			pid: process.pid,
			at: Date.now() + 60_000,
		});
		await command()("on", context());
		expect(readWebServerSettings(webServerSettingsFile()).enabled).toBe(true);
		expect(smolt.reports.join("\n")).toContain("https://localhost:7333");
	});

	it("turns it off again", async () => {
		writeWebServerSettings(webServerSettingsFile(), { enabled: true, port: 7332, lan: false });
		publishedAt(process.pid);
		await command()("off", context());
		expect(readWebServerSettings(webServerSettingsFile()).enabled).toBe(false);
		expect(smolt.reports.join("\n")).toContain("off");
	});

	it("says a link is not ready when nothing is serving it", async () => {
		await command()("on", context());
		expect(smolt.reports.join("\n")).toContain("nothing is serving port 7332");
	});

	it("refuses a port it could not serve HTTPS beside", async () => {
		const ctx = context();
		await command()("port 80", ctx);
		expect(ctx.notices[0]!.type).toBe("error");
		expect(readWebServerSettings(webServerSettingsFile()).port).toBe(7332);
	});

	it("refuses a lan value that is neither on, off, nor an address", async () => {
		const ctx = context();
		await command()("lan maybe", ctx);
		expect(ctx.notices[0]!.type).toBe("error");
	});

	it("serves one more address, for reaching it over a VPN", async () => {
		await command()("lan 10.0.0.3", context());
		expect(readWebServerSettings(webServerSettingsFile()).lan).toBe("10.0.0.3");
	});

	it("drops that address when lan is turned off", async () => {
		writeWebServerSettings(webServerSettingsFile(), { enabled: false, port: 7332, lan: "10.0.0.3" });
		await command()("lan off", context());
		expect(readWebServerSettings(webServerSettingsFile()).lan).toBe(false);
	});

	it("refuses an address that is not one", async () => {
		const ctx = context();
		await command()("lan 300.1.1.1", ctx);
		expect(ctx.notices[0]!.type).toBe("error");
		expect(readWebServerSettings(webServerSettingsFile()).lan).toBe(false);
	});

	it("answers a bare `lan` with what is being served, rather than an error", async () => {
		const ctx = context();
		await command()("lan", ctx);
		expect(ctx.notices[0]!.type).toBe("info");
		expect(ctx.notices[0]!.text).toContain("Web server: off");
	});

	it("shows what it can be asked to do when the action is not one", async () => {
		const ctx = context();
		await command()("frobnicate", ctx);
		expect(ctx.notices[0]!.text).toContain("/webserver on | off");
	});

	it("keeps the settings file the desktop reads where it says it is", () => {
		writeWebServerSettings(webServerSettingsFile(), { enabled: true, port: 7332, lan: false });
		expect(webServerSettingsFile().startsWith(agentDir)).toBe(true);
		expect(JSON.parse(readFileSync(webServerSettingsFile(), "utf-8"))).toMatchObject({ enabled: true });
		expect(webServerStatusFile().startsWith(agentDir)).toBe(true);
	});
});
