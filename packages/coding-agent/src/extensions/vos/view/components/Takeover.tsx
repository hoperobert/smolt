import { nameOf, takeover, useVos } from "../store.ts";
import { Button, Icon } from "../ui.tsx";
import { LiveScreen } from "./LiveScreen.tsx";

/**
 * Taking over a vos's computer: when it hands off (a password, a 2FA code, a
 * CAPTCHA) the chat says so and offers the screen; while the user drives,
 * clicks, scrolls and keys go to the computer, and "Hand back" returns it.
 */
export function TakeoverBanner({ dot }: { dot: string }) {
	const v = useVos();
	const computer = v.computers.get(dot);
	if (!computer) return null;
	if (computer.userInControl) return <Driving dot={dot} />;
	if (!computer.handoffApprovalId) return null;
	return (
		<div
			data-vos-needs
			className="mx-auto mb-3 flex w-full max-w-[760px] items-center gap-3 rounded-xl border border-warn/35 bg-warn/[0.07] px-4 py-3"
		>
			<Icon name="hand" className="text-warn" />
			<div className="min-w-0 flex-1">
				<div className="text-[13.5px] font-medium">{nameOf(dot)} needs you to take over</div>
				<div className="text-[12.5px] text-muted-foreground">
					{computer.handoffReason ?? "Something only you should do: a password, a 2FA code or a CAPTCHA."}
				</div>
			</div>
			<Button size="sm" onClick={() => void takeover(dot, true)}>
				Take over
			</Button>
		</div>
	);
}

function Driving({ dot }: { dot: string }) {
	return (
		<div className="mx-auto mb-3 w-full max-w-[860px] rounded-xl border bg-card/60 p-3">
			<div className="mb-2 flex items-center gap-2">
				<span className="size-1.5 animate-pulse-soft rounded-full bg-destructive" />
				<span className="flex-1 text-[13px] font-medium">You're driving {nameOf(dot)}'s computer</span>
				<span className="text-[12px] text-faint">Click to focus, then type. What you type is not recorded.</span>
				<Button size="sm" onClick={() => void takeover(dot, false)}>
					Hand back
				</Button>
			</div>
			<LiveScreen dot={dot} interactive className="mx-auto max-h-[52vh] w-full" />
		</div>
	);
}
