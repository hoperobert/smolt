import { useState } from "react";
import type { Plugin } from "../../types.ts";
import { bridge } from "../bridge.ts";
import { attempt, bumpVos, loadPlugins, requestConfirm, useVos, vos, vosCall } from "../store.ts";
import { Button, cn, Icon, Switch } from "../ui.tsx";
import { Card, Empty, PageHeader } from "./parts.tsx";

function ConnectorCard({ dot, plugin }: { dot: string; plugin: Plugin }) {
	const [waiting, setWaiting] = useState(false);
	const update = async (patch: { scopes?: string[]; enabled?: boolean }): Promise<void> => {
		const next = await attempt(() => vosCall<Plugin>("PATCH", `/plugins/${encodeURIComponent(plugin.id)}`, patch, dot));
		if (!next?.id) return void loadPlugins(dot);
		vos.plugins.set(dot, (vos.plugins.get(dot) ?? []).map((p) => (p.id === next.id ? next : p)));
		bumpVos();
	};
	const connect = async (): Promise<void> => {
		const result = await attempt(() =>
			vosCall<{ url?: string; authUrl?: string }>("POST", `/plugins/${encodeURIComponent(plugin.id)}/connect`, {}, dot),
		);
		if (!result) return;
		const url = result.url ?? result.authUrl;
		if (url) {
			// Sign-in happens in the user's browser; the list catches up when they come back.
			bridge.openUrl(url);
			setWaiting(true);
			const again = () => {
				if (document.visibilityState !== "visible") return;
				document.removeEventListener("visibilitychange", again);
				setWaiting(false);
				void loadPlugins(dot);
			};
			document.addEventListener("visibilitychange", again);
			setTimeout(() => void loadPlugins(dot), 8000);
		} else {
			void loadPlugins(dot);
		}
	};
	const available = plugin.availableScopes ?? [];
	const scopes = plugin.scopes ?? [];
	const enabled = plugin.enabled ?? plugin.connected;
	return (
		<Card className={cn(!plugin.connected && "bg-transparent")}>
			<div className="flex items-start gap-3">
				<span className="flex size-9 flex-none items-center justify-center rounded-lg bg-muted text-[14px] font-semibold text-muted-foreground">
					{plugin.icon && plugin.icon.length <= 2 ? plugin.icon : plugin.name.slice(0, 1).toUpperCase()}
				</span>
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2">
						<span className="text-[14px] font-medium">{plugin.name}</span>
						{plugin.connected && (
							<span className="rounded-full bg-ok/12 px-2 py-0.5 text-[11px] font-medium text-ok">Connected</span>
						)}
						{plugin.needsSignIn && plugin.account && (
							<span className="rounded-full bg-warn/15 px-2 py-0.5 text-[11px] font-medium text-warn">Sign in again</span>
						)}
						{!plugin.connected && enabled && !plugin.needsSignIn && (
							<span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
								Not set up on the server
							</span>
						)}
					</div>
					{plugin.description && <p className="mt-0.5 text-[13px] text-muted-foreground">{plugin.description}</p>}
					{plugin.account && <p className="mt-0.5 text-[12px] text-faint">as {plugin.account}</p>}
				</div>
				<div className="flex flex-none items-center gap-2">
					{/* Only an app with an account to sign in to has a sign-in; the rest are a switch. */}
					{plugin.needsSignIn && !plugin.account && (
						<Button size="sm" disabled={waiting} onClick={() => void connect()}>
							{waiting ? "Waiting for sign-in…" : "Connect"}
						</Button>
					)}
					<Switch
						checked={!!enabled}
						aria-label={enabled ? `Turn ${plugin.name} off` : `Turn ${plugin.name} on`}
						onCheckedChange={(next) => void update({ enabled: next })}
					/>
					{plugin.account && (
						<Button
							size="xs"
							variant="ghost"
							className="text-destructive hover:text-destructive"
							onClick={async () => {
								const ok = await requestConfirm({
									title: `Disconnect ${plugin.name}?`,
									message: "Your vos lose access to it until you connect it again.",
									actionLabel: "Disconnect",
									destructive: true,
								});
								if (!ok) return;
								const done = await attempt(() =>
									vosCall("POST", `/plugins/${encodeURIComponent(plugin.id)}/disconnect`, {}, dot),
								);
								if (done !== undefined) void loadPlugins(dot);
							}}
						>
							Disconnect
						</Button>
					)}
				</div>
			</div>
			{enabled && available.length > 1 && (
				<div className="mt-3 flex flex-wrap items-center gap-1.5 border-t pt-3">
					<span className="mr-1 text-[12px] text-faint">Allowed to</span>
					{available.map((scope) => {
						const on = scopes.includes(scope);
						return (
							<button
								key={scope}
								type="button"
								aria-pressed={on}
								onClick={() => void update({ scopes: on ? scopes.filter((s) => s !== scope) : [...scopes, scope] })}
								className={cn(
									"rounded-full border px-2.5 py-0.5 text-[12px] transition-colors",
									on ? "border-tint/40 bg-tint/12 text-tint-text" : "text-muted-foreground hover:text-foreground",
								)}
							>
								{on && <Icon name="check" className="mr-1 [&>svg]:size-3" />}
								{scope}
							</button>
						);
					})}
				</div>
			)}
		</Card>
	);
}

/** The apps a vos can use: connect (sign-in opens in the browser), switch off, narrow what it may do, disconnect. */
export function VosConnectors({ dot, name }: { dot: string; name: string }) {
	const v = useVos();
	const plugins = v.plugins.get(dot);
	const sorted = [...(plugins ?? [])].sort(
		(a, b) => Number(b.connected) - Number(a.connected) || a.name.localeCompare(b.name),
	);
	return (
		<div className="mx-auto w-full max-w-[760px] px-6 pt-2 pb-10">
			<PageHeader
				title="Connectors"
				detail={`The apps ${name} can sign in to. Connections are shared by all your vos; scopes limit what they may do.`}
			>
				<Button size="sm" variant="ghost" onClick={() => void loadPlugins(dot)}>
					<Icon name="refresh" />
					Refresh
				</Button>
			</PageHeader>
			{!plugins && <p className="text-sm text-faint">Loading…</p>}
			{plugins && plugins.length === 0 && <Empty>No connectors on this server yet.</Empty>}
			<div className="flex flex-col gap-3">
				{sorted.map((plugin) => (
					<ConnectorCard key={plugin.id} dot={dot} plugin={plugin} />
				))}
			</div>
		</div>
	);
}
