// How the phone finds the computer: addresses for the QR link, and Bonjour (_smolt._tcp).

import os from "node:os";
import { Bonjour } from "bonjour-service";
import { PROTOCOL_VERSION } from "./protocol.ts";

/** Every non-internal IPv4 address, best first: LAN ranges, then Tailscale (100.64/10), then the rest. */
export function lanAddresses(): string[] {
	const all: string[] = [];
	for (const entries of Object.values(os.networkInterfaces())) {
		for (const entry of entries ?? []) {
			if (entry.family === "IPv4" && !entry.internal) all.push(entry.address);
		}
	}
	const rank = (ip: string) => {
		const [a, b] = ip.split(".").map(Number) as [number, number];
		if (a === 192 && b === 168) return 0;
		if (a === 10) return 1;
		if (a === 172 && b >= 16 && b <= 31) return 2;
		if (a === 100 && b >= 64 && b <= 127) return 3;
		if (a === 169 && b === 254) return 5; // link-local, last resort
		return 4;
	};
	return [...new Set(all)].sort((x, y) => rank(x) - rank(y));
}

/** A Tailscale address (100.64/10) is listed as such in Settings. */
export function isTailscaleAddress(ip: string): boolean {
	const [a, b] = ip.split(".").map(Number) as [number, number];
	return a === 100 && b >= 64 && b <= 127;
}

export function pairingLink(o: { name: string; hosts: string[]; port: number; fp?: string; code: string }): string {
	const q = [
		`v=${PROTOCOL_VERSION}`,
		`n=${encodeURIComponent(o.name)}`,
		`h=${o.hosts.map(encodeURIComponent).join(",")}`,
		`p=${o.port}`,
		...(o.fp ? [`fp=${o.fp}`] : []),
		`c=${o.code}`,
	];
	return `smolt://pair?${q.join("&")}`;
}

/** Advertise _smolt._tcp with TXT v, name, fp. Returns a stop function, or undefined if Bonjour is unavailable. */
export function advertise(
	o: { name: string; port: number; fp?: string },
	log: (s: string) => void,
): (() => Promise<void>) | undefined {
	try {
		const report = (err: Error) => log(`Bonjour error: ${err.message}`);
		const bonjour = new Bonjour({}, report);
		// multicast-dns emits "error" when it cannot bind 5353; unheard, that would take the
		// whole main process down. Bonjour only routes its own errors to the callback.
		(
			bonjour as unknown as { server?: { mdns?: { on(event: "error", cb: (err: Error) => void): void } } }
		).server?.mdns?.on("error", report);
		const txt: Record<string, string> = { v: String(PROTOCOL_VERSION), name: o.name };
		if (o.fp) txt.fp = o.fp;
		const service = bonjour.publish({ name: o.name, type: "smolt", protocol: "tcp", port: o.port, txt });
		service.on("error", report);
		return () =>
			new Promise<void>((resolve) => {
				bonjour.unpublishAll(() => {
					bonjour.destroy();
					resolve();
				});
			});
	} catch (err) {
		log(`Bonjour unavailable (${(err as Error).message}); the QR code still works`);
		return undefined;
	}
}
