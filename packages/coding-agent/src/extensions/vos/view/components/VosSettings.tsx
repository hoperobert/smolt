import { useState } from "react";
import { disconnectVos, useVos } from "../store.ts";
import { Button } from "../ui.tsx";

/**
 * The settings section: who this host is connected as, and the way out.
 * Connecting happens in the Vos view itself, where the QR has room. The
 * section is a short frame, so disconnecting confirms in place, not in a dialog.
 */
export function VosSettings() {
	const v = useVos();
	const [confirming, setConfirming] = useState(false);
	const connection = v.connection;
	const hint = !connection
		? "Checking…"
		: !connection.connected
			? "Not connected. Open Vos in the sidebar to pair with your iPhone."
			: connection.deviceName
				? `Connected as ${connection.deviceName} · ${connection.url.replace(/^https?:\/\//, "")}`
				: `Connected with ${connection.keySource === "env" ? "VOS_API_KEY" : "an API key"} · ${connection.url.replace(/^https?:\/\//, "")}`;
	const where =
		connection?.keySource === "keychain"
			? "The key is kept by your operating system's keystore."
			: connection?.keySource === "memory"
				? "This system has no keystore smolt can use: the key is kept for this session only."
				: connection?.keySource === "file"
					? "The key is kept in a file only you can read."
					: "";
	return (
		<div className="flex items-center justify-between gap-4 py-1">
			<div className="min-w-0">
				<div className="text-[13.5px] font-medium">Vos</div>
				<div className="text-[12.5px] text-muted-foreground">{hint}</div>
				{connection?.connected && where && <div className="text-[12px] text-faint">{where}</div>}
			</div>
			{connection?.connected && connection.keySource !== "env" && (
				<div className="flex flex-none items-center gap-2">
					{confirming && (
						<Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
							Cancel
						</Button>
					)}
					<Button
						size="sm"
						variant={confirming ? "destructive" : "outline"}
						title={
							connection.deviceName
								? "smolt forgets this device's key; revoke it in the Vos app (Settings › Connected devices)."
								: "smolt forgets the API key; your vos and their work stay on the server."
						}
						onClick={async () => {
							if (!confirming) return setConfirming(true);
							setConfirming(false);
							await disconnectVos();
						}}
					>
						{confirming ? "Disconnect for real" : "Disconnect"}
					</Button>
				</div>
			)}
		</div>
	);
}
