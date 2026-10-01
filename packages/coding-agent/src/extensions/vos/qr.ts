/**
 * A small QR code encoder: byte mode, any version, error correction L/M/Q/H,
 * with the standard mask choice. It exists so pairing smolt with Vos can draw
 * its QR locally (an SVG on the desktop, half blocks in the terminal) without
 * a dependency or an outside service. Follows the ISO/IEC 18004 construction
 * as laid out in Project Nayuki's reference encoder.
 *
 * No Node imports: the desktop renderer bundles this file.
 */

export type QrEcc = "L" | "M" | "Q" | "H";

/** Rows of modules, true = dark. Square, without the quiet zone. */
export type QrMatrix = boolean[][];

const ECC_ORDINAL: Record<QrEcc, number> = { L: 0, M: 1, Q: 2, H: 3 };
/** The two format bits for each level. */
const ECC_FORMAT_BITS: Record<QrEcc, number> = { L: 1, M: 0, Q: 3, H: 2 };

/** Error-correction codewords per block, by [level][version]; version 0 is unused. */
const ECC_CODEWORDS_PER_BLOCK: number[][] = [
	[
		-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30,
		30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
	],
	[
		-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28,
		28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
	],
	[
		-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30,
		30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
	],
	[
		-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30,
		30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
	],
];
/** Error-correction blocks, by [level][version]; version 0 is unused. */
const NUM_ERROR_CORRECTION_BLOCKS: number[][] = [
	[
		-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18,
		19, 19, 20, 21, 22, 24, 25,
	],
	[
		-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31,
		33, 35, 37, 38, 40, 43, 45, 47, 49,
	],
	[
		-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40,
		43, 45, 48, 51, 53, 56, 59, 62, 65, 68,
	],
	[
		-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48,
		51, 54, 57, 60, 63, 66, 70, 74, 77, 81,
	],
];

function rawDataModules(ver: number): number {
	let result = (16 * ver + 128) * ver + 64;
	if (ver >= 2) {
		const numAlign = Math.floor(ver / 7) + 2;
		result -= (25 * numAlign - 10) * numAlign - 55;
		if (ver >= 7) result -= 36;
	}
	return result;
}

function dataCodewords(ver: number, ecl: number): number {
	return (
		Math.floor(rawDataModules(ver) / 8) -
		(ECC_CODEWORDS_PER_BLOCK[ecl]?.[ver] ?? 0) * (NUM_ERROR_CORRECTION_BLOCKS[ecl]?.[ver] ?? 0)
	);
}

// ---------------------------------------------------------------- Reed-Solomon over GF(2^8/0x11D)

function rsMultiply(x: number, y: number): number {
	let z = 0;
	for (let i = 7; i >= 0; i--) {
		z = (z << 1) ^ ((z >>> 7) * 0x11d);
		z ^= ((y >>> i) & 1) * x;
	}
	return z & 0xff;
}

function rsDivisor(degree: number): number[] {
	const result = new Array<number>(degree).fill(0);
	result[degree - 1] = 1;
	let root = 1;
	for (let i = 0; i < degree; i++) {
		for (let j = 0; j < result.length; j++) {
			result[j] = rsMultiply(result[j] ?? 0, root);
			if (j + 1 < result.length) result[j] = (result[j] ?? 0) ^ (result[j + 1] ?? 0);
		}
		root = rsMultiply(root, 0x02);
	}
	return result;
}

function rsRemainder(data: number[], divisor: number[]): number[] {
	const result = divisor.map(() => 0);
	for (const b of data) {
		const factor = b ^ (result.shift() ?? 0);
		result.push(0);
		divisor.forEach((coef, i) => {
			result[i] = (result[i] ?? 0) ^ rsMultiply(coef, factor);
		});
	}
	return result;
}

// ---------------------------------------------------------------- encoding

function utf8(text: string): number[] {
	return Array.from(new TextEncoder().encode(text));
}

/** Encode `text` as a QR matrix at the smallest version that fits. */
export function encodeQr(text: string, ecc: QrEcc = "M"): QrMatrix {
	const ecl = ECC_ORDINAL[ecc];
	const bytes = utf8(text);
	let version = 1;
	for (; version <= 40; version++) {
		const countBits = version <= 9 ? 8 : 16;
		if (4 + countBits + bytes.length * 8 <= dataCodewords(version, ecl) * 8) break;
	}
	if (version > 40) throw new Error("Too much data for a QR code");

	// Mode (byte), count, data, terminator, pad to bytes, pad codewords.
	const bits: number[] = [];
	const push = (value: number, length: number): void => {
		for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
	};
	push(0x4, 4);
	push(bytes.length, version <= 9 ? 8 : 16);
	for (const b of bytes) push(b, 8);
	const capacity = dataCodewords(version, ecl) * 8;
	push(0, Math.min(4, capacity - bits.length));
	push(0, (8 - (bits.length % 8)) % 8);
	for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);
	const data: number[] = [];
	for (let i = 0; i < bits.length; i += 8) {
		let byte = 0;
		for (let j = 0; j < 8; j++) byte = (byte << 1) | (bits[i + j] ?? 0);
		data.push(byte);
	}

	// Split into blocks, add error correction, interleave.
	const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ecl]?.[version] ?? 1;
	const blockEccLen = ECC_CODEWORDS_PER_BLOCK[ecl]?.[version] ?? 0;
	const rawCodewords = Math.floor(rawDataModules(version) / 8);
	const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
	const shortBlockLen = Math.floor(rawCodewords / numBlocks);
	const divisor = rsDivisor(blockEccLen);
	const blocks: number[][] = [];
	for (let i = 0, k = 0; i < numBlocks; i++) {
		const dataLen = shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1);
		const chunk = data.slice(k, k + dataLen);
		k += dataLen;
		const ecc = rsRemainder(chunk, divisor);
		if (i < numShortBlocks) chunk.push(0);
		blocks.push(chunk.concat(ecc));
	}
	const codewords: number[] = [];
	for (let i = 0; i < (blocks[0]?.length ?? 0); i++) {
		blocks.forEach((block, j) => {
			if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) codewords.push(block[i] ?? 0);
		});
	}

	const qr = new Grid(version);
	qr.drawFunctionPatterns();
	qr.drawCodewords(codewords);
	// The mask with the lowest penalty wins.
	let best = 0;
	let bestPenalty = Number.POSITIVE_INFINITY;
	for (let mask = 0; mask < 8; mask++) {
		qr.applyMask(mask);
		qr.drawFormatBits(ECC_FORMAT_BITS[ecc], mask);
		const penalty = qr.penalty();
		if (penalty < bestPenalty) {
			best = mask;
			bestPenalty = penalty;
		}
		qr.applyMask(mask);
	}
	qr.applyMask(best);
	qr.drawFormatBits(ECC_FORMAT_BITS[ecc], best);
	return qr.modules.map((row) => [...row]);
}

class Grid {
	readonly version: number;
	readonly size: number;
	readonly modules: boolean[][];
	private readonly isFunction: boolean[][];

	constructor(version: number) {
		this.version = version;
		this.size = version * 4 + 17;
		this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
		this.isFunction = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
	}

	private set(x: number, y: number, dark: boolean): void {
		const row = this.modules[y];
		const fn = this.isFunction[y];
		if (!row || !fn) return;
		row[x] = dark;
		fn[x] = true;
	}

	drawFunctionPatterns(): void {
		for (let i = 0; i < this.size; i++) {
			this.set(6, i, i % 2 === 0);
			this.set(i, 6, i % 2 === 0);
		}
		this.finder(3, 3);
		this.finder(this.size - 4, 3);
		this.finder(3, this.size - 4);
		const positions = this.alignmentPositions();
		const n = positions.length;
		for (let i = 0; i < n; i++) {
			for (let j = 0; j < n; j++) {
				if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
				this.alignment(positions[i] ?? 0, positions[j] ?? 0);
			}
		}
		this.drawFormatBits(0, 0);
		this.drawVersion();
	}

	private finder(x: number, y: number): void {
		for (let dy = -4; dy <= 4; dy++) {
			for (let dx = -4; dx <= 4; dx++) {
				const dist = Math.max(Math.abs(dx), Math.abs(dy));
				const xx = x + dx;
				const yy = y + dy;
				if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size) this.set(xx, yy, dist !== 2 && dist !== 4);
			}
		}
	}

	private alignment(x: number, y: number): void {
		for (let dy = -2; dy <= 2; dy++) {
			for (let dx = -2; dx <= 2; dx++) this.set(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
		}
	}

	private alignmentPositions(): number[] {
		if (this.version === 1) return [];
		const numAlign = Math.floor(this.version / 7) + 2;
		const step = this.version === 32 ? 26 : Math.ceil((this.version * 4 + 4) / (numAlign * 2 - 2)) * 2;
		const result = [6];
		for (let pos = this.size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
		return result;
	}

	drawFormatBits(eccBits: number, mask: number): void {
		const data = (eccBits << 3) | mask;
		let rem = data;
		for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
		const bits = ((data << 10) | rem) ^ 0x5412;
		const bit = (i: number): boolean => ((bits >>> i) & 1) !== 0;
		for (let i = 0; i <= 5; i++) this.set(8, i, bit(i));
		this.set(8, 7, bit(6));
		this.set(8, 8, bit(7));
		this.set(7, 8, bit(8));
		for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(i));
		for (let i = 0; i < 8; i++) this.set(this.size - 1 - i, 8, bit(i));
		for (let i = 8; i < 15; i++) this.set(8, this.size - 15 + i, bit(i));
		this.set(8, this.size - 8, true);
	}

	private drawVersion(): void {
		if (this.version < 7) return;
		let rem = this.version;
		for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
		const bits = (this.version << 12) | rem;
		for (let i = 0; i < 18; i++) {
			const dark = ((bits >>> i) & 1) !== 0;
			const a = this.size - 11 + (i % 3);
			const b = Math.floor(i / 3);
			this.set(a, b, dark);
			this.set(b, a, dark);
		}
	}

	drawCodewords(data: number[]): void {
		let i = 0;
		for (let right = this.size - 1; right >= 1; right -= 2) {
			if (right === 6) right = 5;
			for (let vert = 0; vert < this.size; vert++) {
				for (let j = 0; j < 2; j++) {
					const x = right - j;
					const upward = ((right + 1) & 2) === 0;
					const y = upward ? this.size - 1 - vert : vert;
					const row = this.modules[y];
					if (!row || this.isFunction[y]?.[x] || i >= data.length * 8) continue;
					row[x] = (((data[i >>> 3] ?? 0) >>> (7 - (i & 7))) & 1) !== 0;
					i++;
				}
			}
		}
	}

	applyMask(mask: number): void {
		for (let y = 0; y < this.size; y++) {
			const row = this.modules[y];
			if (!row) continue;
			for (let x = 0; x < this.size; x++) {
				if (this.isFunction[y]?.[x]) continue;
				let invert: boolean;
				switch (mask) {
					case 0:
						invert = (x + y) % 2 === 0;
						break;
					case 1:
						invert = y % 2 === 0;
						break;
					case 2:
						invert = x % 3 === 0;
						break;
					case 3:
						invert = (x + y) % 3 === 0;
						break;
					case 4:
						invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
						break;
					case 5:
						invert = ((x * y) % 2) + ((x * y) % 3) === 0;
						break;
					case 6:
						invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
						break;
					default:
						invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
				}
				if (invert) row[x] = !row[x];
			}
		}
	}

	/** The standard penalty score: runs, 2x2 blocks, finder-like patterns, balance. */
	penalty(): number {
		const n = this.size;
		const at = (x: number, y: number): boolean => this.modules[y]?.[x] === true;
		let result = 0;
		const line = (get: (i: number) => boolean): void => {
			let run = 1;
			for (let i = 1; i <= n; i++) {
				if (i < n && get(i) === get(i - 1)) run++;
				else {
					if (run >= 5) result += 3 + (run - 5);
					run = 1;
				}
			}
			// Finder-like 1:1:3:1:1 with four light modules on either side.
			for (let i = 0; i + 7 <= n; i++) {
				const core = get(i) && !get(i + 1) && get(i + 2) && get(i + 3) && get(i + 4) && !get(i + 5) && get(i + 6);
				if (!core) continue;
				const lightBefore = [1, 2, 3, 4].every((k) => i - k < 0 || !get(i - k));
				const lightAfter = [7, 8, 9, 10].every((k) => i + k >= n || !get(i + k));
				if (lightBefore || lightAfter) result += 40;
			}
		};
		for (let y = 0; y < n; y++) line((x) => at(x, y));
		for (let x = 0; x < n; x++) line((y) => at(x, y));
		let dark = 0;
		for (let y = 0; y < n; y++) {
			for (let x = 0; x < n; x++) {
				if (at(x, y)) dark++;
				if (x + 1 < n && y + 1 < n) {
					const c = at(x, y);
					if (c === at(x + 1, y) && c === at(x, y + 1) && c === at(x + 1, y + 1)) result += 3;
				}
			}
		}
		const total = n * n;
		const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
		result += Math.max(0, k) * 10;
		return result;
	}
}

/** The matrix as an SVG path ("M x y h1v1h-1z…"), one unit per module, inside a quiet zone of `margin`. */
export function qrSvgPath(matrix: QrMatrix, margin = 4): string {
	const parts: string[] = [];
	matrix.forEach((row, y) => {
		row.forEach((dark, x) => {
			if (dark) parts.push(`M${x + margin} ${y + margin}h1v1h-1z`);
		});
	});
	return parts.join("");
}

/**
 * The matrix as terminal text: two module rows per line with half blocks,
 * dark modules drawn as spaces on a light quiet zone so it scans on dark and
 * light terminals alike (inverted colours are what phone scanners expect).
 */
export function qrTerminal(matrix: QrMatrix, margin = 2): string[] {
	const size = matrix.length + margin * 2;
	const dark = (x: number, y: number): boolean => matrix[y - margin]?.[x - margin] === true;
	const lines: string[] = [];
	for (let y = 0; y < size; y += 2) {
		let line = "";
		for (let x = 0; x < size; x++) {
			const top = dark(x, y);
			const bottom = y + 1 < size ? dark(x, y + 1) : false;
			// Light is the drawn colour: "█" both light, "▀" top light, "▄" bottom light, " " both dark.
			line += !top && !bottom ? "█" : !top ? "▀" : !bottom ? "▄" : " ";
		}
		lines.push(line);
	}
	return lines;
}
