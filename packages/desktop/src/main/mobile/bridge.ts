// Smolt for iPhone, served by the desktop itself: the switch in Settings, the protocol server
// behind it, and what Settings shows (addresses, the pairing code and its QR, paired iPhones).
//
// Nothing listens until the person turns it on. While it is on, a WSS server (pinned
// self-signed certificate) listens on every interface at `port` (7350) and Bonjour advertises
// `_smolt._tcp`; turning it off closes both. The phone talks to the desktop through a
// DesktopTransport, which the app makes in-process (ipc-tap.ts). This file imports no Electron.
//
// <dataDir> keeps: mobile.json {enabled, port}; smolt-mobile.json (devices, the phone's name
// settings, uploaded files' records) and files/; smolt-desktop.json (stars, id mappings);
// tls-cert.pem / tls-key.pem; and, when `writeLinkFile` is set (development builds),
// pair-link.txt with the current pairing link for the iOS Simulator.

import fs from "node:fs";
import path from "node:path";
import { encodeQr, qrSvgPath } from "../../../../coding-agent/src/extensions/vos/qr.ts";
import { SmoltDesktopSource } from "./desktop-source.ts";
import { advertise, isTailscaleAddress, lanAddresses, pairingLink } from "./discovery.ts";
import { MobileServer, WS_PATH } from "./server.ts";
import { Store } from "./store.ts";
import { loadOrCreateTls, type TlsIdentity } from "./tls.ts";
import type { DesktopTransport } from "./transport.ts";

export const DEFAULT_MOBILE_PORT = 7350;

export interface MobileSettings {
	enabled: boolean;
	port: number;
}

export interface MobileDevice {
	id: string;
	name: string;
	model: string;
	pairedAt: number;
	lastSeenAt: number;
	/** Connected right now. */
	connected: boolean;
}

export interface MobileAddress {
	host: string;
	kind: "lan" | "tailscale" | "local";
}

/** What Settings shows. Sent on `mobile:state` whenever any of it changes. */
export interface MobileState {
	enabled: boolean;
	running: boolean;
	port: number;
	/** wss:// with a pinned certificate; false only in the development-only insecure mode. */
	secure: boolean;
	/** Where the phone can reach this computer, best first (also the link's `h`). */
	addresses: MobileAddress[];
	/** The current pairing code, while the server runs and the code is not locked out. */
	pairing?: {
		code: string;
		expiresAt: number;
		/** smolt://pair?v=1&n=…&h=…&p=…&fp=…&c=… */
		link: string;
		/** The link as a QR code: a complete SVG document, dark modules on white. */
		qrSvg: string;
	};
	/** Five wrong tries burned the code; a new one is made only on request. */
	lockedOut: boolean;
	devices: MobileDevice[];
	error?: string;
}

export interface MobileBridgeOptions {
	/** Where everything lives (userData/mobile in the app). */
	dataDir: string;
	transport: DesktopTransport;
	computerName: string;
	osName: string;
	/** Plain ws:// and no `fp` in the link, for debug builds of the phone app only. */
	insecure?: boolean;
	/** Advertise over Bonjour (default true). */
	bonjour?: boolean;
	/** Keep the current pairing link in <dataDir>/pair-link.txt. */
	writeLinkFile?: boolean;
	/** Interface to bind; every interface by default, so the phone can reach it. */
	host?: string;
	log: (line: string) => void;
	onState?: (state: MobileState) => void;
}

export function readMobileSettings(file: string): MobileSettings {
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<MobileSettings>;
		return {
			enabled: parsed.enabled === true,
			port:
				typeof parsed.port === "number" && parsed.port >= 0 && parsed.port < 65536
					? Math.floor(parsed.port)
					: DEFAULT_MOBILE_PORT,
		};
	} catch {
		return { enabled: false, port: DEFAULT_MOBILE_PORT };
	}
}

export class MobileBridge {
	private readonly options: MobileBridgeOptions;
	private readonly settingsFile: string;
	private readonly linkFile: string;
	private storeInstance: Store | undefined;
	private server: MobileServer | undefined;
	private tls: TlsIdentity | undefined;
	private stopBonjour: (() => Promise<void>) | undefined;
	/** A start or stop in flight; the next one waits for it. */
	private moving: Promise<unknown> = Promise.resolve();
	private error: string | undefined;
	private qrCache: { link: string; svg: string } | undefined;

	constructor(options: MobileBridgeOptions) {
		this.options = options;
		this.settingsFile = path.join(options.dataDir, "mobile.json");
		this.linkFile = path.join(options.dataDir, "pair-link.txt");
	}

	settings(): MobileSettings {
		return readMobileSettings(this.settingsFile);
	}

	private writeSettings(settings: MobileSettings): void {
		fs.mkdirSync(this.options.dataDir, { recursive: true });
		fs.writeFileSync(this.settingsFile, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
	}

	private get store(): Store {
		this.storeInstance ??= new Store(this.options.dataDir);
		return this.storeInstance;
	}

	get running(): boolean {
		return this.server !== undefined;
	}

	/** The port the server is listening on, or the configured one when it is off. */
	get port(): number {
		return this.server?.port || this.settings().port;
	}

	state(): MobileState {
		const settings = this.settings();
		const server = this.server;
		const addresses = this.addresses();
		const pairing = server?.pairing;
		const online = server?.connectedDeviceIds() ?? new Set<string>();
		// Nothing is made on disk just to say there are no iPhones.
		const devices =
			this.storeInstance || fs.existsSync(path.join(this.options.dataDir, "smolt-mobile.json"))
				? this.store.data.devices
				: [];
		const state: MobileState = {
			enabled: settings.enabled,
			running: server !== undefined,
			port: server ? server.port : settings.port,
			secure: !this.options.insecure,
			addresses,
			lockedOut: pairing?.lockedOut === true,
			devices: devices
				.map((d) => ({
					id: d.deviceId,
					name: d.deviceName,
					model: d.deviceModel,
					pairedAt: d.pairedAt,
					lastSeenAt: d.lastSeenAt,
					connected: online.has(d.deviceId),
				}))
				.sort((a, b) => b.lastSeenAt - a.lastSeenAt),
			...(this.error ? { error: this.error } : {}),
		};
		if (server && pairing && pairing.code !== "") {
			const link = this.link(pairing.code);
			state.pairing = { code: pairing.code, expiresAt: pairing.expiresAt, link, qrSvg: this.qr(link) };
		}
		return state;
	}

	/** The pairing link for this code, with the addresses as they are now (Wi-Fi can change). */
	private link(code: string): string {
		return pairingLink({
			name: this.options.computerName,
			hosts: this.addresses().map((a) => a.host),
			port: this.port,
			fp: this.options.insecure ? undefined : this.tls?.fp,
			code,
		});
	}

	private addresses(): MobileAddress[] {
		const found = lanAddresses().map(
			(host): MobileAddress => ({ host, kind: isTailscaleAddress(host) ? "tailscale" : "lan" }),
		);
		return found.length > 0 ? found : [{ host: "127.0.0.1", kind: "local" }];
	}

	private qr(link: string): string {
		if (this.qrCache?.link !== link) {
			const matrix = encodeQr(link, "M");
			const size = matrix.length + 8;
			const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${qrSvgPath(matrix, 4)}" fill="#111113"/></svg>`;
			this.qrCache = { link, svg };
		}
		return this.qrCache.svg;
	}

	private changed(): void {
		const state = this.state();
		if (this.options.writeLinkFile) this.writeLinkFile(state);
		this.options.onState?.(state);
	}

	/** The link for `xcrun simctl openurl booted "$(cat pair-link.txt)"`; gone when there is no code. */
	private writeLinkFile(state: MobileState): void {
		try {
			if (state.pairing) fs.writeFileSync(this.linkFile, `${state.pairing.link}\n`, { mode: 0o600 });
			else fs.rmSync(this.linkFile, { force: true });
		} catch {
			// A debugging aid; never worth failing over.
		}
	}

	/** Flip the setting and make the server match it. */
	async setEnabled(enabled: boolean): Promise<MobileState> {
		this.writeSettings({ ...this.settings(), enabled });
		if (enabled) await this.start();
		else await this.stop();
		return this.state();
	}

	start(): Promise<void> {
		const run = this.moving.then(() => this.startNow());
		this.moving = run.catch(() => undefined);
		return run;
	}

	stop(): Promise<void> {
		const run = this.moving.then(() => this.stopNow());
		this.moving = run.catch(() => undefined);
		return run;
	}

	private async startNow(): Promise<void> {
		if (this.server) return;
		const { log } = this.options;
		this.error = undefined;
		const settings = this.settings();
		const store = this.store;
		let server: MobileServer | undefined;
		try {
			this.tls = this.options.insecure ? undefined : await loadOrCreateTls(this.options.dataDir, log);
			const source = new SmoltDesktopSource({ store, transport: this.options.transport });
			server = new MobileServer({
				store,
				source,
				computerName: this.options.computerName,
				osName: this.options.osName,
				tls: this.tls,
				log,
				onPairingChange: () => {
					if (this.server) this.changed();
				},
				onDevicesChanged: () => {
					if (this.server) this.changed();
				},
			});
			await server.listen(settings.port, this.options.host ?? "0.0.0.0");
			this.server = server;
			await source.start();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.error = /EADDRINUSE/.test(message)
				? `Port ${settings.port} is already in use (is another Smolt Mobile server running?)`
				: message;
			log(`could not start: ${this.error}`);
			this.server = undefined;
			await server?.close().catch(() => undefined);
			this.changed();
			return;
		}
		const scheme = this.tls ? "wss" : "ws";
		log(`listening on ${scheme}://0.0.0.0:${server.port}${WS_PATH}`);
		if (this.options.bonjour !== false) {
			this.stopBonjour = advertise({ name: this.options.computerName, port: server.port, fp: this.tls?.fp }, log);
		}
		if (this.options.writeLinkFile) log(`pairing link for the iOS Simulator: ${this.linkFile}`);
		this.changed();
	}

	private async stopNow(): Promise<void> {
		const server = this.server;
		const stopBonjour = this.stopBonjour;
		this.server = undefined;
		this.stopBonjour = undefined;
		this.error = undefined;
		if (stopBonjour) {
			// Saying goodbye on the network should be quick; never let it hold the switch.
			await Promise.race([stopBonjour().catch(() => undefined), new Promise((r) => setTimeout(r, 1500))]);
		}
		if (server) {
			await server.close().catch((error: unknown) => this.options.log(`stopping: ${String(error)}`));
			this.options.log("stopped");
		}
		this.changed();
	}

	/** A fresh pairing code (also after a lockout). */
	newCode(): MobileState {
		this.server?.pairing.renew();
		return this.state();
	}

	/** Forget an iPhone: it is told (device.revoked) and disconnected if it is connected now. */
	removeDevice(deviceId: string): MobileState {
		if (this.server) {
			this.server.revokeDevice(deviceId);
		} else {
			const data = this.store.data;
			data.devices = data.devices.filter((d) => d.deviceId !== deviceId);
			this.store.flush();
		}
		this.changed();
		return this.state();
	}
}
