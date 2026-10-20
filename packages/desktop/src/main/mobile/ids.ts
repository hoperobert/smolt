import { randomBytes } from "node:crypto";

// Prefixed ULIDs: 10 chars of time + 16 chars of randomness, Crockford base32.
// They sort by creation time, which is handy when reading the JSON file.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export type IdPrefix = "msg" | "fil" | "dev";

export function ulid(time = Date.now()): string {
	let t = "";
	for (let i = 0; i < 10; i++) {
		t = ALPHABET[time % 32] + t;
		time = Math.floor(time / 32);
	}
	const bytes = randomBytes(16);
	let r = "";
	for (let i = 0; i < 16; i++) r += ALPHABET[bytes[i] % 32];
	return t + r;
}

export function newId(prefix: IdPrefix, time?: number): string {
	return `${prefix}_${ulid(time)}`;
}
