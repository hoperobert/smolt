import * as path from "node:path";

/**
 * Stable identity for switching an extension on and off in settings.
 * Built-ins arrive as `<inline:learning>`; a file extension is identified by
 * its own file name (or its directory, for an `index` entry) so the id keeps
 * working when the absolute path differs from one machine to the next.
 */
export function extensionId(extensionPath: string): string {
	const inline = /^<inline:(.+)>$/.exec(extensionPath);
	if (inline) return inline[1] as string;
	const base = path.basename(extensionPath).replace(/\.(?:[cm]?[jt]s)$/i, "");
	return base === "index" ? path.basename(path.dirname(extensionPath)) : base;
}
