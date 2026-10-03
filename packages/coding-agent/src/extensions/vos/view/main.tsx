import { createRoot } from "react-dom/client";
import { bridge } from "./bridge.ts";
import { Dialogs } from "./components/Dialogs.tsx";
import { VosSettings } from "./components/VosSettings.tsx";
import { VosView } from "./components/VosView.tsx";
import { bootVos } from "./store.ts";

/**
 * The Vos view's entry. One bundle serves both of the extension's views: the
 * full section (sidebar) and the short settings row, told apart by the id
 * the host gives the page.
 */

// Links leave the sandbox through the host: the frame may not open windows itself.
document.addEventListener("click", (event) => {
	const anchor = (event.target as HTMLElement | null)?.closest?.("a[href]");
	if (!anchor) return;
	const href = anchor.getAttribute("href") ?? "";
	if (!/^https?:\/\//i.test(href)) return;
	event.preventDefault();
	bridge.openUrl(href);
});

const settings = bridge.view.id.endsWith("-settings");
document.documentElement.dataset.vosView = settings ? "settings" : "full";
bootVos({ connectionOnly: settings });

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		settings ? (
			<VosSettings />
		) : (
			<>
				<VosView />
				<Dialogs />
			</>
		),
	);
}
