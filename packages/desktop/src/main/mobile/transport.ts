// How the bridge reaches the Smolt desktop: the same channels the desktop's own window uses.
//
//   invoke(channel, ...args)   any ipcMain.handle in the main process (preload.ts names them)
//   subscribe(listener)        every webContents.send to the window, as (channel, args)
//
// Inside the desktop the transport is in-process (ipc-tap.ts calls the recorded handlers and
// fans the window's sends out); the tests drive a fake handler map. Nothing here imports
// Electron.

import { EventEmitter } from "node:events";
import { ErrorCode, RpcError } from "./protocol.ts";

export interface DesktopTransport {
	invoke(channel: string, ...args: unknown[]): Promise<unknown>;
	/** Every message the desktop sends its window. Returns a function that stops listening. */
	subscribe(listener: (channel: string, args: unknown[]) => void): () => void;
}

/** The desktop answered with an error (or `{ok: false, error}` from an agent call). Sent to the phone as -32006. */
export class DesktopError extends RpcError {
	constructor(message: string) {
		super(ErrorCode.Upstream, message);
	}
}

/**
 * The desktop as the bridge sees it.
 *
 * Values cross as JSON, exactly as they would over Electron's IPC: the bridge never holds a
 * reference into the desktop's own objects, and what it reads has the shape the window reads.
 *
 * Events:
 *   "event"  (channel: string, args: unknown[])   every message the window is sent
 *   "up"     ({restarted: boolean})               listening (always restarted: false in-process)
 */
export class DesktopClient extends EventEmitter {
	private transport: DesktopTransport;
	private unsubscribe: (() => void) | undefined;
	private log: ((s: string) => void) | undefined;

	constructor(transport: DesktopTransport, log?: (s: string) => void) {
		super();
		this.transport = transport;
		this.log = log;
	}

	/** Call an ipcMain.handle channel, as the window does. */
	async invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
		let value: unknown;
		try {
			value = await this.transport.invoke(channel, ...cloneArgs(args));
		} catch (err) {
			throw new DesktopError(err instanceof Error ? err.message : String(err));
		}
		return (value === undefined ? null : JSON.parse(JSON.stringify(value))) as T;
	}

	/**
	 * Call an agent RPC method through `agent:call` (packages/desktop/src/main/agent-bridge.ts
	 * names them: prompt, abort, getState, switchSession, fork, respondExtensionUI…). Throws on
	 * `{ok: false}`.
	 */
	async call<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
		const r = await this.invoke<{ ok?: boolean; value?: unknown; error?: string } | null>("agent:call", method, args);
		if (!r || r.ok !== true) throw new DesktopError(r?.error ?? `${method} failed`);
		return r.value as T;
	}

	start() {
		this.unsubscribe ??= this.transport.subscribe((channel, args) => {
			let copy: unknown[];
			try {
				copy = cloneArgs(args);
			} catch {
				return; // not representable as JSON: the window could not have been sent it either
			}
			// A listener that throws must never reach the desktop code that sent the message.
			try {
				this.emit("event", channel, copy);
			} catch (err) {
				this.log?.(
					`event handler failed for ${channel}: ${err instanceof Error ? (err.stack ?? err.message) : err}`,
				);
			}
		});
		queueMicrotask(() => this.emit("up", { restarted: false }));
	}

	close() {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
	}
}

function cloneArgs(args: unknown[]): unknown[] {
	// As the web server's JSON did: undefined in a list becomes null, an undefined field is left out.
	return args.length === 0 ? [] : (JSON.parse(JSON.stringify(args)) as unknown[]);
}
