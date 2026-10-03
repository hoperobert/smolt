import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPackageDir } from "../../config.ts";

/**
 * The Vos view's page: one self-contained HTML file (React, the components and
 * their stylesheet inlined) built from ./view by `npm run build:vos-view`.
 *
 * Where it is depends on how smolt runs: beside this module when running the
 * TypeScript source, under dist/ for the npm package (copy-assets puts it
 * there), and beside the executable for the Bun binary.
 */

export const VIEW_FILE = "vos-view.html";

export function viewCandidates(): string[] {
	const here = dirname(fileURLToPath(import.meta.url));
	const pkg = getPackageDir();
	return [
		join(here, "view", "dist", VIEW_FILE),
		join(here, VIEW_FILE),
		join(pkg, "src", "extensions", "vos", "view", "dist", VIEW_FILE),
		join(pkg, "dist", "extensions", "vos", VIEW_FILE),
		join(pkg, "extensions", "vos", VIEW_FILE),
	];
}

const MISSING = `<!doctype html><html><head><meta charset="utf-8" /><style>
body{margin:0;display:flex;align-items:center;justify-content:center;height:100vh;font:14px/1.5 system-ui,sans-serif;
background:var(--background,#0f0f11);color:var(--muted-foreground,#a3a3ab)}code{color:var(--foreground,#ededea)}
</style></head><body><p>The Vos view is not built. Run <code>npm run build:vos-view</code> in packages/coding-agent.</p></body></html>`;

/** The built page, or a page saying how to build it. */
export function loadViewHtml(): string {
	for (const candidate of viewCandidates()) {
		if (existsSync(candidate)) return readFileSync(candidate, "utf-8");
	}
	return MISSING;
}
