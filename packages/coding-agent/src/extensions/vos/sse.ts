/**
 * An incremental parser for server-sent events.
 *
 * Bytes arrive in arbitrary chunks: an event can be split across reads, and a
 * read can end in the middle of a line or of a CRLF pair. The parser keeps
 * the unfinished tail and emits an event only at the blank line that ends it,
 * following the WHATWG event-stream rules smolt needs: `event`, `data`
 * (joined with newlines), `id`, and comments (lines starting with ":"),
 * which are ignored. `retry` is ignored too; callers own their backoff.
 */

export interface SseEvent {
	/** The event name; "message" when the stream gave none. */
	event: string;
	data: string;
	/** The id this event set, when it set one. */
	id?: string;
}

export class SseParser {
	private buffer = "";
	private event = "";
	private data: string[] = [];
	private id: string | undefined;
	/** The last id the stream set, kept across events for Last-Event-ID. */
	lastEventId: string | undefined;

	/** Feed a chunk; returns the events it completed, in order. */
	push(chunk: string): SseEvent[] {
		this.buffer += chunk;
		const out: SseEvent[] = [];
		for (;;) {
			const match = /\r\n|\r|\n/.exec(this.buffer);
			if (!match) break;
			// A chunk ending in a bare CR might be the first half of CRLF: wait
			// for the next chunk rather than reading an empty line out of it.
			if (match[0] === "\r" && match.index === this.buffer.length - 1) break;
			const line = this.buffer.slice(0, match.index);
			this.buffer = this.buffer.slice(match.index + match[0].length);
			const event = this.line(line);
			if (event) out.push(event);
		}
		return out;
	}

	private line(line: string): SseEvent | undefined {
		if (line === "") {
			if (this.data.length === 0) {
				this.event = "";
				this.id = undefined;
				return undefined;
			}
			const event: SseEvent = { event: this.event || "message", data: this.data.join("\n") };
			if (this.id !== undefined) event.id = this.id;
			this.event = "";
			this.data = [];
			this.id = undefined;
			return event;
		}
		if (line.startsWith(":")) return undefined;
		const colon = line.indexOf(":");
		const field = colon === -1 ? line : line.slice(0, colon);
		let value = colon === -1 ? "" : line.slice(colon + 1);
		if (value.startsWith(" ")) value = value.slice(1);
		if (field === "event") this.event = value;
		else if (field === "data") this.data.push(value);
		else if (field === "id" && !value.includes("\0")) {
			this.id = value;
			this.lastEventId = value;
		}
		return undefined;
	}
}
