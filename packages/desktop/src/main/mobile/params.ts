// Small helpers for reading JSON-RPC params, shared by methods.ts and the sources.

import { badParams } from "./protocol.ts";
import type { Params } from "./source.ts";

export function str(
	p: Params,
	key: string,
	opts: { optional?: boolean; allowEmpty?: boolean } = {},
): string | undefined {
	const v = p[key];
	if (v === undefined || v === null) {
		if (opts.optional) return undefined;
		throw badParams(`${key} is required`);
	}
	if (typeof v !== "string" || (!opts.allowEmpty && v === "")) throw badParams(`${key} must be a non-empty string`);
	return v;
}

export const req = (p: Params, key: string) => str(p, key) as string;

export function bool(p: Params, key: string): boolean | undefined {
	const v = p[key];
	if (v === undefined || v === null) return undefined;
	if (typeof v !== "boolean") throw badParams(`${key} must be a boolean`);
	return v;
}

/** About 120 characters around the first match, with ellipses where cut. */
export function makeSnippet(text: string, query: string): string | undefined {
	const flat = text.replace(/\s+/g, " ");
	const at = flat.toLowerCase().indexOf(query);
	if (at < 0) return undefined;
	const start = Math.max(0, at - 50);
	const end = Math.min(flat.length, at + query.length + 70);
	return (start > 0 ? "…" : "") + flat.slice(start, end).trim() + (end < flat.length ? "…" : "");
}
