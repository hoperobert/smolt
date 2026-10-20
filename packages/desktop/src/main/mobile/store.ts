// What the bridge keeps for itself: paired devices, the phone's own settings (name, nickname,
// preferences) and uploaded files. One JSON file (<data>/smolt-mobile.json) plus file bytes in
// <data>/files/. Writes are debounced and atomic (a temp file renamed over the old one).

import fs from "node:fs";
import path from "node:path";
import { DEFAULT_SETTINGS, type FileRef, notFound, type Settings } from "./protocol.ts";

export type Device = {
	deviceId: string;
	deviceName: string;
	deviceModel: string;
	/** base64 X9.63 point, as sent by the phone. */
	publicKey: string;
	pairedAt: number;
	lastSeenAt: number;
};

export type StoredFile = FileRef & { createdAt: number };

export type Data = {
	schema: 1;
	settings: Settings;
	devices: Device[];
	files: StoredFile[];
};

const emptyData = (): Data => ({ schema: 1, settings: { ...DEFAULT_SETTINGS }, devices: [], files: [] });

export class Store {
	readonly dir: string;
	readonly filesDir: string;
	readonly file: string;
	data: Data;
	private timer: NodeJS.Timeout | undefined;

	constructor(dir: string) {
		this.dir = path.resolve(dir);
		this.filesDir = path.join(this.dir, "files");
		this.file = path.join(this.dir, "smolt-mobile.json");
		fs.mkdirSync(this.filesDir, { recursive: true });
		let saved: Partial<Data> = {};
		try {
			saved = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<Data>;
		} catch {
			// First run, or unreadable: start empty.
		}
		const empty = emptyData();
		this.data = {
			schema: 1,
			settings: { ...empty.settings, ...saved.settings },
			devices: Array.isArray(saved.devices) ? saved.devices : [],
			files: Array.isArray(saved.files) ? saved.files : [],
		};
	}

	/** Schedule a save. Many changes in quick succession become one write. */
	save() {
		if (this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.flush();
		}, 300);
	}

	/** Write now, atomically. */
	flush() {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		const tmp = `${this.file}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1), { mode: 0o600 });
		fs.renameSync(tmp, this.file);
	}

	fileMeta(id: unknown): StoredFile {
		const f = this.data.files.find((f) => f.id === id);
		if (!f) throw notFound("File");
		return f;
	}

	private blobPath(id: string) {
		return path.join(this.filesDir, id);
	}

	writeBlob(id: string, bytes: Buffer) {
		fs.writeFileSync(this.blobPath(id), bytes);
	}

	readBlob(id: string): Buffer {
		return fs.readFileSync(this.blobPath(id));
	}

	fileRef(f: StoredFile): FileRef {
		const { createdAt: _createdAt, ...ref } = f;
		return ref;
	}
}
