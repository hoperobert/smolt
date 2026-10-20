// Pairing codes and device authentication (§2).

import crypto from "node:crypto";
import { AUTH_PREFIX } from "./protocol.ts";

/**
 * Turn the phone's public key (base64 of the 65-byte X9.63 point 04‖X‖Y) into a Node KeyObject.
 * Throws if it isn't a valid P-256 point.
 */
export function importDeviceKey(publicKeyB64: string): crypto.KeyObject {
	const raw = Buffer.from(publicKeyB64, "base64");
	if (raw.length !== 65 || raw[0] !== 0x04) throw new Error("publicKey must be a 65-byte uncompressed P-256 point");
	return crypto.createPublicKey({
		format: "jwk",
		key: {
			kty: "EC",
			crv: "P-256",
			x: raw.subarray(1, 33).toString("base64url"),
			y: raw.subarray(33, 65).toString("base64url"),
		},
	});
}

/** Check a DER ECDSA/SHA-256 signature over UTF-8("smolt-auth-v1:" + nonce). */
export function verifyDeviceSignature(publicKeyB64: string, nonce: string, signatureB64: string): boolean {
	try {
		return crypto.verify(
			"sha256",
			Buffer.from(AUTH_PREFIX + nonce, "utf8"),
			{ key: importDeviceKey(publicKeyB64), dsaEncoding: "der" },
			Buffer.from(signatureB64, "base64"),
		);
	} catch {
		return false;
	}
}

/** Outstanding auth.challenge nonces: one use each, valid for 60 s. */
export class NonceBook {
	private nonces = new Map<string, { nonce: string; expiresAt: number }>();

	issue(deviceId: string): string {
		const nonce = crypto.randomBytes(32).toString("base64");
		this.nonces.set(deviceId, { nonce, expiresAt: Date.now() + 60_000 });
		return nonce;
	}

	/** Returns the nonce for this device and forgets it, or undefined if none is valid. */
	take(deviceId: string): string | undefined {
		const n = this.nonces.get(deviceId);
		this.nonces.delete(deviceId);
		return n && n.expiresAt > Date.now() ? n.nonce : undefined;
	}
}

/**
 * The current 6-digit pairing code. It lasts 5 minutes and works once; a used or expired
 * code is replaced at once. Five wrong tries burn it and leave no code at all until someone
 * at the computer asks for a new one: renewing on lockout would hand a guesser on the
 * network a fresh code every five tries, and a million codes fall to that in minutes.
 * `onChange` fires whenever the code changes, so Settings can show it.
 */
export class PairingCode {
	static readonly LIFETIME_MS = 5 * 60_000;
	static readonly MAX_WRONG = 5;

	code = "";
	expiresAt = 0;
	/** True after five wrong tries, until renew(). */
	lockedOut = false;
	private wrong = 0;
	private timer: NodeJS.Timeout | undefined;
	private onChange: () => void;

	constructor(onChange: () => void) {
		this.onChange = onChange;
	}

	renew() {
		this.code = crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
		this.expiresAt = Date.now() + PairingCode.LIFETIME_MS;
		this.wrong = 0;
		this.lockedOut = false;
		clearTimeout(this.timer);
		this.timer = setTimeout(() => this.renew(), PairingCode.LIFETIME_MS);
		this.timer.unref();
		this.onChange();
	}

	/** Check a code; a right answer consumes it, the fifth wrong one burns it. */
	attempt(code: unknown): boolean {
		if (this.lockedOut || this.code === "") return false;
		const ok =
			typeof code === "string" &&
			/^\d{6}$/.test(code) &&
			Date.now() < this.expiresAt &&
			crypto.timingSafeEqual(Buffer.from(code), Buffer.from(this.code));
		if (ok) {
			this.renew();
			return true;
		}
		if (++this.wrong >= PairingCode.MAX_WRONG) this.lockOut();
		return false;
	}

	private lockOut() {
		clearTimeout(this.timer);
		this.code = "";
		this.expiresAt = 0;
		this.lockedOut = true;
		this.onChange();
	}

	stop() {
		clearTimeout(this.timer);
		this.code = "";
		this.expiresAt = 0;
	}
}
