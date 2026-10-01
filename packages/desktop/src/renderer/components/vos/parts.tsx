import type { ReactNode } from "react";
import { initials, isBusy, linkify, vosColor } from "../../../../../coding-agent/src/extensions/vos/format.ts";
import type { Look, Mood } from "../../../../../coding-agent/src/extensions/vos/types.ts";
import { cn } from "../../lib/cn.ts";
import { renderMarkdown } from "../../markdown.ts";

/** A vos's avatar: a circle in its look's colour with its initials, and a mood dot. */
export function VosAvatar({
	name,
	look,
	id = "",
	size = 28,
	mood,
	className,
}: {
	name: string;
	look?: Look;
	id?: string;
	size?: number;
	mood?: Mood;
	className?: string;
}) {
	const color = vosColor(look, id || name);
	const square = look?.shape === "square";
	return (
		<span className={cn("relative inline-flex flex-none", className)} style={{ width: size, height: size }}>
			<span
				aria-hidden
				className={cn(
					"flex size-full items-center justify-center font-semibold text-white select-none",
					square ? "rounded-[30%]" : "rounded-full",
				)}
				style={{
					background: `linear-gradient(160deg, color-mix(in oklab, ${color} 82%, white), ${color})`,
					fontSize: Math.max(9, Math.round(size * 0.38)),
					boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${color} 60%, black)`,
				}}
			>
				{initials(name)}
			</span>
			{mood && mood !== "idle" && (
				<span
					aria-hidden
					className={cn(
						"absolute -right-0.5 -bottom-0.5 rounded-full border-2 border-[var(--vos-avatar-ring,var(--background))]",
						isBusy(mood) && "animate-pulse-soft bg-tint",
						mood === "needsYou" && "bg-warn",
						mood === "paused" && "bg-faint",
						mood === "celebrating" && "bg-ok",
						mood === "sad" && "bg-destructive",
					)}
					style={{ width: Math.max(8, size * 0.32), height: Math.max(8, size * 0.32) }}
				/>
			)}
		</span>
	);
}

/** A vos's message text: markdown with links that open in the browser. */
export function VosText({ text, className }: { text: string; className?: string }) {
	return (
		<div
			className={cn("md text-[14px] leading-relaxed", className)}
			// The in-house renderer escapes HTML before adding markup.
			dangerouslySetInnerHTML={{ __html: renderMarkdown(linkify(text)) }}
		/>
	);
}

/** A page heading with an optional line under it and actions on the right. */
export function PageHeader({ title, detail, children }: { title: string; detail?: ReactNode; children?: ReactNode }) {
	return (
		<div className="mb-5 flex flex-wrap items-end justify-between gap-3">
			<div className="min-w-0">
				<h2 className="text-[17px] font-semibold tracking-[-0.01em] text-foreground">{title}</h2>
				{detail && <p className="mt-1 text-[13px] text-muted-foreground">{detail}</p>}
			</div>
			{children && <div className="flex flex-none items-center gap-2">{children}</div>}
		</div>
	);
}

/** A soft card: the section's one surface. */
export function Card({ className, children }: { className?: string; children: ReactNode }) {
	return <div className={cn("rounded-xl border bg-card/60 p-4", className)}>{children}</div>;
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
	return (
		// biome-ignore lint/a11y/noLabelWithoutControl: the control is the child
		<label className="flex flex-col gap-1.5">
			<span className="text-[12px] font-medium text-muted-foreground">{label}</span>
			{children}
			{hint && <span className="text-[12px] text-faint">{hint}</span>}
		</label>
	);
}

/** An empty page, said plainly. */
export function Empty({ children }: { children: ReactNode }) {
	return (
		<div className="rounded-xl border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
			{children}
		</div>
	);
}

/** A small toggle button group: one choice of a few. */
export function Segmented<T extends string>({
	value,
	options,
	onChange,
	label,
}: {
	value: T;
	options: { value: T; label: string }[];
	onChange: (value: T) => void;
	label: string;
}) {
	return (
		<div role="radiogroup" aria-label={label} className="inline-flex rounded-lg border bg-background p-0.5">
			{options.map((option) => (
				<button
					key={option.value}
					type="button"
					role="radio"
					aria-checked={value === option.value}
					onClick={() => onChange(option.value)}
					className={cn(
						"rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors",
						value === option.value
							? "bg-accent text-foreground shadow-[0_1px_0_rgba(var(--shadow-rgb),0.08)]"
							: "text-muted-foreground hover:text-foreground",
					)}
				>
					{option.label}
				</button>
			))}
		</div>
	);
}
