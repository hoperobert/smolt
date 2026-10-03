/**
 * Kept apart from views.ts so the renderer can import it without pulling in
 * the main process's agent bridge.
 */

/** The theme tokens a view receives as CSS custom properties on :root. */
export const THEME_TOKENS = [
	"background",
	"background-deep",
	"foreground",
	"card",
	"card-foreground",
	"popover",
	"popover-foreground",
	"primary",
	"primary-foreground",
	"secondary",
	"secondary-foreground",
	"muted",
	"muted-foreground",
	"accent",
	"accent-foreground",
	"destructive",
	"destructive-foreground",
	"border",
	"border-strong",
	"input",
	"ring",
	"ok",
	"warn",
	"tint",
	"tint-text",
	"salmon",
	"faint",
	"radius",
	"shadow-rgb",
] as const;
