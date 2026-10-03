import { type ClassValue, clsx } from "clsx";
import { type ComponentProps, type ReactNode, useEffect, useRef, useState } from "react";
import { twMerge } from "tailwind-merge";
import { icon } from "./icons.ts";

/**
 * The desktop app's UI primitives, as the Vos view needs them: the same
 * classes on the same theme tokens, so the view looks like the app it sits
 * in. Popups are plain DOM here (no portal library): the view is one frame.
 */

export function cn(...inputs: ClassValue[]): string {
	return twMerge(clsx(inputs));
}

type Variant = "default" | "destructive" | "outline" | "secondary" | "ghost" | "link";
type Size = "default" | "sm" | "xs" | "lg" | "icon";

const VARIANTS: Record<Variant, string> = {
	default: "bg-primary text-primary-foreground hover:bg-primary/90",
	destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
	outline: "border bg-transparent text-muted-foreground hover:bg-accent hover:text-accent-foreground",
	secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
	ghost: "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
	link: "text-primary underline-offset-4 hover:underline",
};
const SIZES: Record<Size, string> = {
	default: "h-9 px-4 py-2",
	sm: "h-8 rounded-lg px-3",
	xs: "h-7 rounded-md px-2 text-xs",
	lg: "h-10 rounded-lg px-8",
	icon: "size-8",
};

export function Button({
	className,
	variant = "default",
	size = "default",
	title,
	"aria-label": ariaLabel,
	type = "button",
	...props
}: ComponentProps<"button"> & { variant?: Variant; size?: Size }) {
	const quiet = size === "icon" && (variant === "ghost" || variant === "outline") ? "text-faint hover:text-foreground" : "";
	return (
		<button
			data-slot="button"
			// biome-ignore lint/a11y/useButtonType: the type is a prop, "button" unless a form says otherwise
			type={type}
			title={title}
			aria-label={ariaLabel ?? title}
			className={cn(
				"inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-colors outline-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
				VARIANTS[variant],
				SIZES[size],
				quiet,
				className,
			)}
			{...props}
		/>
	);
}

export function Input({ className, ...props }: ComponentProps<"input">) {
	return (
		<input
			data-slot="input"
			className={cn(
				"flex h-9 w-full min-w-0 rounded-lg border bg-transparent px-3 py-1 text-sm transition-colors placeholder:text-faint focus-visible:border-border-strong focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50",
				className,
			)}
			{...props}
		/>
	);
}

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
	return (
		<textarea
			data-slot="textarea"
			className={cn(
				"flex w-full rounded-lg border bg-transparent px-3 py-2 text-sm placeholder:text-faint focus-visible:border-border-strong focus-visible:outline-none disabled:opacity-50",
				className,
			)}
			{...props}
		/>
	);
}

export function Switch({
	checked,
	onCheckedChange,
	className,
	...props
}: Omit<ComponentProps<"button">, "onChange"> & { checked: boolean; onCheckedChange: (next: boolean) => void }) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			data-state={checked ? "checked" : "unchecked"}
			onClick={() => onCheckedChange(!checked)}
			className={cn(
				"peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors outline-none disabled:cursor-not-allowed disabled:opacity-50",
				checked ? "bg-primary" : "bg-input",
				className,
			)}
			{...props}
		>
			<span
				className={cn(
					"pointer-events-none block size-4 rounded-full bg-background shadow-lg ring-0 transition-transform",
					checked ? "translate-x-4" : "translate-x-0.5",
				)}
			/>
		</button>
	);
}

/** A native select in the app's field style: the frame has no portal for a custom one. */
export function Select<T extends string>({
	value,
	onChange,
	options,
	className,
	label,
}: {
	value: T;
	onChange: (value: T) => void;
	options: { value: T; label: string }[];
	className?: string;
	label?: string;
}) {
	return (
		<select
			data-slot="select-trigger"
			aria-label={label}
			value={value}
			onChange={(e) => onChange(e.target.value as T)}
			className={cn(
				"flex h-9 w-full min-w-0 cursor-pointer appearance-none rounded-lg border bg-transparent bg-[length:14px] bg-[right_10px_center] bg-no-repeat px-3 pr-8 text-sm focus-visible:border-border-strong focus-visible:outline-none",
				"bg-[image:var(--select-chevron)]",
				className,
			)}
		>
			{options.map((option) => (
				<option key={option.value} value={option.value} className="bg-popover text-popover-foreground">
					{option.label}
				</option>
			))}
		</select>
	);
}

/** The app's own line icons, 16px, currentColor. */
export function Icon({ name, className }: { name: string; className?: string }) {
	return (
		<span
			className={cn("inline-flex shrink-0 [&>svg]:size-4 [&>svg]:shrink-0", className)}
			aria-hidden="true"
			// The markup is our own static SVG table, never remote content.
			dangerouslySetInnerHTML={{ __html: icon(name) }}
		/>
	);
}

/** A small menu under a trigger; closes on pick, outside click or Escape. */
export function Menu({
	trigger,
	label,
	children,
	align = "end",
	className,
}: {
	trigger: ReactNode;
	label: string;
	children: (close: () => void) => ReactNode;
	align?: "start" | "end";
	className?: string;
}) {
	const [open, setOpen] = useState(false);
	const box = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!open) return;
		const away = (event: MouseEvent) => {
			if (!box.current?.contains(event.target as Node)) setOpen(false);
		};
		const key = (event: KeyboardEvent) => {
			if (event.key === "Escape") setOpen(false);
		};
		document.addEventListener("mousedown", away);
		document.addEventListener("keydown", key);
		return () => {
			document.removeEventListener("mousedown", away);
			document.removeEventListener("keydown", key);
		};
	}, [open]);
	return (
		<div ref={box} className="relative">
			<button
				type="button"
				aria-label={label}
				title={label}
				aria-expanded={open}
				onClick={() => setOpen(!open)}
				className="flex size-8 items-center justify-center rounded-lg text-faint transition-colors hover:bg-accent hover:text-foreground"
			>
				{trigger}
			</button>
			{open && (
				<div
					role="menu"
					className={cn(
						"absolute top-full z-50 mt-1 min-w-52 rounded-xl border bg-popover p-1 text-popover-foreground shadow-[0_12px_32px_-12px_rgba(var(--shadow-rgb),0.45)]",
						align === "end" ? "right-0" : "left-0",
						className,
					)}
				>
					{children(() => setOpen(false))}
				</div>
			)}
		</div>
	);
}

export function MenuItem({
	onSelect,
	children,
	destructive,
}: {
	onSelect: () => void;
	children: ReactNode;
	destructive?: boolean;
}) {
	return (
		<button
			type="button"
			role="menuitem"
			onClick={onSelect}
			className={cn(
				"flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors hover:bg-accent",
				destructive && "text-destructive",
			)}
		>
			{children}
		</button>
	);
}

export const MenuSeparator = () => <div className="my-1 h-px bg-border" />;
