#!/usr/bin/env node
/**
 * Build the Vos extension's view into one self-contained HTML file:
 * src/extensions/vos/view/dist/vos-view.html.
 *
 * The view is a React page drawn by graphical front ends in a sandboxed frame
 * whose CSP allows inline script and style only, so everything is inlined:
 * esbuild bundles the TSX (React included), Tailwind compiles the stylesheet
 * from the classes the components use. The same tools the desktop app builds
 * with; their versions are pinned in this package's devDependencies.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const viewDir = join(here, "..", "src", "extensions", "vos", "view");
const outDir = join(viewDir, "dist");
const scratch = mkdtempSync(join(tmpdir(), "vos-view-"));

try {
	const result = await build({
		entryPoints: [join(viewDir, "main.tsx")],
		bundle: true,
		platform: "browser",
		format: "iife",
		jsx: "automatic",
		minify: true,
		write: false,
		legalComments: "none",
		target: "es2022",
		define: { "process.env.NODE_ENV": '"production"' },
		tsconfigRaw: { compilerOptions: { jsx: "react-jsx" } },
	});
	const script = result.outputFiles[0]?.text ?? "";

	const require = createRequire(import.meta.url);
	const tailwindBin = require.resolve("@tailwindcss/cli/package.json").replace(/package\.json$/, "dist/index.mjs");
	const cssOut = join(scratch, "view.css");
	const tailwind = spawnSync(process.execPath, [tailwindBin, "-i", join(viewDir, "view.css"), "-o", cssOut, "--minify"], {
		cwd: viewDir,
		stdio: ["ignore", "ignore", "inherit"],
	});
	if (tailwind.status !== 0) process.exit(tailwind.status ?? 1);
	const css = readFileSync(cssOut, "utf-8");

	// A closing tag inside the inlined code would end the element early.
	const safeScript = script.replaceAll("</script", "<\\/script");
	const safeCss = css.replaceAll("</style", "<\\/style");
	const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Vos</title>
<style>${safeCss}</style>
</head>
<body>
<div id="root"></div>
<script>${safeScript}</script>
</body>
</html>
`;
	mkdirSync(outDir, { recursive: true });
	writeFileSync(join(outDir, "vos-view.html"), html);
	console.log(`vos view: ${(html.length / 1024).toFixed(0)} KB -> ${join(outDir, "vos-view.html")}`);
} finally {
	rmSync(scratch, { recursive: true, force: true });
}
