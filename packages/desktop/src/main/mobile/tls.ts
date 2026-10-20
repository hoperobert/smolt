// TLS identity: a self-signed P-256 certificate made once and kept in the data dir.
// The phone pins fp = base64url(SHA-256(SubjectPublicKeyInfo DER)).
//
// The `openssl` CLI makes it when it is on PATH. Windows usually has none, so there is also a
// small pure-Node fallback that builds the X.509 DER by hand and signs it with node:crypto.
// Both produce the same kind of certificate.

import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type TlsIdentity = { cert: string; key: string; fp: string };

export async function loadOrCreateTls(dataDir: string, log: (s: string) => void): Promise<TlsIdentity> {
	const certPath = path.join(dataDir, "tls-cert.pem");
	const keyPath = path.join(dataDir, "tls-key.pem");
	if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
		fs.mkdirSync(dataDir, { recursive: true });
		if (!(await tryOpenssl(certPath, keyPath))) {
			const { cert, key } = selfSignedWithNode("Smolt");
			fs.writeFileSync(certPath, cert);
			fs.writeFileSync(keyPath, key, { mode: 0o600 });
		}
		log("made the TLS certificate the phone pins");
	}
	const cert = fs.readFileSync(certPath, "utf8");
	const key = fs.readFileSync(keyPath, "utf8");
	return { cert, key, fp: spkiFingerprint(cert) };
}

/** base64url (no padding) of SHA-256 over the certificate's SPKI DER. */
export function spkiFingerprint(certPem: string): string {
	const spki = new crypto.X509Certificate(certPem).publicKey.export({ type: "spki", format: "der" });
	return crypto.createHash("sha256").update(spki).digest("base64url");
}

function tryOpenssl(certPath: string, keyPath: string): Promise<boolean> {
	const args = [
		"req",
		"-x509",
		"-newkey",
		"ec",
		"-pkeyopt",
		"ec_paramgen_curve:prime256v1",
		"-nodes",
		"-keyout",
		keyPath,
		"-out",
		certPath,
		"-days",
		"3650",
		"-sha256",
		"-subj",
		"/CN=Smolt",
	];
	return new Promise((resolve) => {
		try {
			execFile("openssl", args, { windowsHide: true }, (error) => {
				if (error) {
					fs.rmSync(certPath, { force: true });
					fs.rmSync(keyPath, { force: true });
					resolve(false);
					return;
				}
				try {
					fs.chmodSync(keyPath, 0o600);
				} catch {
					// Windows has no modes; the user-data folder is the user's own.
				}
				resolve(fs.existsSync(certPath) && fs.existsSync(keyPath));
			});
		} catch {
			resolve(false);
		}
	});
}

// ---- minimal DER encoder, just enough for a self-signed certificate ----

function der(tag: number, body: Buffer): Buffer {
	const len = body.length;
	let head: Buffer;
	if (len < 0x80) head = Buffer.from([tag, len]);
	else if (len < 0x100) head = Buffer.from([tag, 0x81, len]);
	else head = Buffer.from([tag, 0x82, len >> 8, len & 0xff]);
	return Buffer.concat([head, body]);
}
const seq = (...items: Buffer[]) => der(0x30, Buffer.concat(items));
const set = (...items: Buffer[]) => der(0x31, Buffer.concat(items));

function oid(dotted: string): Buffer {
	const parts = dotted.split(".").map(Number);
	const bytes = [40 * parts[0]! + parts[1]!];
	for (const n of parts.slice(2)) {
		const chunk = [n & 0x7f];
		for (let v = n >> 7; v > 0; v >>= 7) chunk.unshift((v & 0x7f) | 0x80);
		bytes.push(...chunk);
	}
	return der(0x06, Buffer.from(bytes));
}

function positiveInteger(bytes: Buffer): Buffer {
	return der(0x02, bytes[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes);
}

function time(d: Date): Buffer {
	// UTCTime for years before 2050, GeneralizedTime after (RFC 5280).
	const iso = `${d.toISOString().replace(/[-:T]/g, "").slice(0, 14)}Z`; // YYYYMMDDHHMMSSZ
	return d.getUTCFullYear() < 2050 ? der(0x17, Buffer.from(iso.slice(2))) : der(0x18, Buffer.from(iso));
}

export function selfSignedWithNode(commonName: string): { cert: string; key: string } {
	const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
	const ecdsaWithSha256 = seq(oid("1.2.840.10045.4.3.2"));
	const name = seq(set(seq(oid("2.5.4.3"), der(0x0c, Buffer.from(commonName, "utf8")))));
	const now = new Date();
	const later = new Date(now.getTime() + 3650 * 24 * 3600 * 1000);
	const tbs = seq(
		der(0xa0, positiveInteger(Buffer.from([2]))), // version v3
		positiveInteger(crypto.randomBytes(16)),
		ecdsaWithSha256,
		name,
		seq(time(now), time(later)),
		name,
		publicKey.export({ type: "spki", format: "der" }),
	);
	const signature = crypto.sign("sha256", tbs, { key: privateKey, dsaEncoding: "der" });
	const certDer = seq(tbs, ecdsaWithSha256, der(0x03, Buffer.concat([Buffer.from([0]), signature])));
	const b64 = certDer.toString("base64").replace(/.{64}/g, "$&\n");
	return {
		cert: `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`.replace("\n\n", "\n"),
		key: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
	};
}
