import { type BrowserWindow, ipcMain } from "electron";
import type { DesktopTransport } from "./mobile/transport.ts";

/**
 * What the window can ask and what it is told, for the app's other clients.
 *
 * Every `ipcMain.handle` the main process registers is recorded here, and
 * every `webContents.send` to the window is fanned out to listeners. The
 * in-app web server answers browsers with the same handlers and mirrors the
 * same messages to them; the iPhone bridge reaches the desktop the same way,
 * in-process (`inProcessTransport`). Either way another client sees exactly
 * what the window sees.
 */

export type InvokeHandler = (event: unknown, ...args: unknown[]) => unknown;
export type SendListener = (event: unknown, ...args: unknown[]) => void;
export type WindowSendListener = (channel: string, args: unknown[]) => void;

const invokeHandlers = new Map<string, InvokeHandler>();
const sendListeners = new Map<string, SendListener[]>();
const windowSendListeners = new Set<WindowSendListener>();
const mirrored = new WeakSet<BrowserWindow>();
let tapped = false;

/**
 * Record every IPC handler the main process registers, so another client
 * can call the same functions the window does. Must run before any
 * `ipcMain.handle` — main.ts calls it at import time.
 */
export function tapIpc(): void {
	if (tapped) return;
	tapped = true;
	const handle = ipcMain.handle.bind(ipcMain);
	ipcMain.handle = ((channel: string, listener: InvokeHandler) => {
		invokeHandlers.set(channel, listener);
		return handle(channel, listener as never);
	}) as typeof ipcMain.handle;
	const on = ipcMain.on.bind(ipcMain);
	ipcMain.on = ((channel: string, listener: SendListener) => {
		const list = sendListeners.get(channel) ?? [];
		list.push(listener);
		sendListeners.set(channel, list);
		return on(channel, listener as never);
	}) as typeof ipcMain.on;
}

/** The handler the window's `ipcRenderer.invoke(channel)` reaches, if one is registered. */
export function invokeHandler(channel: string): InvokeHandler | undefined {
	return invokeHandlers.get(channel);
}

/** The listeners the window's `ipcRenderer.send(channel)` reaches. */
export function sendListenersOf(channel: string): readonly SendListener[] {
	return sendListeners.get(channel) ?? [];
}

/**
 * Everything the window is sent, the listeners are sent too. The wrap is on
 * the instance, so every `win.webContents.send` in main.ts feeds it.
 */
export function mirrorWindow(win: BrowserWindow): void {
	if (mirrored.has(win)) return;
	mirrored.add(win);
	const contents = win.webContents;
	const send = contents.send.bind(contents);
	contents.send = ((channel: string, ...args: unknown[]) => {
		send(channel, ...args);
		for (const listener of windowSendListeners) {
			try {
				listener(channel, args);
			} catch {
				// Another client's trouble must never break what the window is sent.
			}
		}
	}) as typeof contents.send;
}

/** Listen to everything the window is sent. Returns a function that stops listening. */
export function onWindowSend(listener: WindowSendListener): () => void {
	windowSendListeners.add(listener);
	return () => {
		windowSendListeners.delete(listener);
	};
}

/** The desktop for the iPhone bridge: the recorded handlers, called directly, and the mirrored sends. */
export function inProcessTransport(): DesktopTransport {
	return {
		invoke: async (channel, ...args) => {
			const handler = invokeHandlers.get(channel);
			if (!handler) throw new Error(`no handler: ${channel}`);
			return await handler({}, ...args);
		},
		subscribe: (listener) => onWindowSend(listener),
	};
}
