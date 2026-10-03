# vos

The user's Vos teammates (vos-api.vosgrau.com), as an extension: a view in the
desktop app (in the window and its browser build), and commands plus a panel
in the terminal. Switching the extension off in settings removes all of it.

## Desktop: the Vos view

`index.ts` registers two views (`smolt.registerView`): `vos` in the sidebar and
`vos-settings` in Settings. Both are one page, `view/`, built into a single
HTML file by `npm run build:vos-view` (esbuild for the React components,
Tailwind for the stylesheet; the build runs as part of the package build).
The page has no network: every request (`window.smolt.request`) is answered by
`service.ts` on the Node side, which holds the key and makes every API call,
event stream (SSE) and live-computer socket. Events come back with
`smolt.postToView`.

Pages: roster with sections, pins and hidden vos (pin, hide, file under a
section and duplicate from a row's menu); the inbox across all vos (triage,
done/dismiss, jump to the approval, secret, task or cloud agent), with the open
count on the sidebar badge and a native notification for each new
high-priority item and each cloud agent that finishes or fails; cloud agents
(jobs that run smolt in a fresh VM on one repo and end in a PR: list, start
form with a repo picker from the GitHub App, live log, follow-up message,
cancel, retry, the PR and its checks, the VM's screen when offered, and a
setup card when the GitHub App is not installed);
per vos: chat (approvals answered once, for an hour, today or always; secret
requests; group chats with @-mentions and handoffs; taking over the computer
when a vos hands off, then handing back), routines (schedules and event
triggers with hook URLs, rotation and run history), memory, skills, teach a
task, rules (standing limits and approvals in advance with an expiry),
connectors (sign-in opens in the browser, scopes, switch off, disconnect), the
computers gallery with the live screen, the profile, and starting a coding
agent on a vos's computer.

To work on the view without a server, run the mock and point the connect
screen at `http://127.0.0.1:8787` (click the server name under the QR). The
mock prints a `curl` that approves each pairing; the API-key fallback takes
`dev-vos-key`:

```bash
node packages/coding-agent/src/extensions/vos/view/mock-vos.mjs
```

## Terminal

| Command | What it does |
| --- | --- |
| `/vos` | Roster by section: each vos's mood, label and unread count, group chats, hidden vos |
| `/vos panel` | An overlay: the inbox (approve once / 1 hour / today, deny, done, dismiss), cloud agents (start, log, message, cancel, retry), each vos's latest messages, sending one, its memory, starting a coding agent |
| `/vos inbox` | What needs you, across all vos |
| `/vos agents` | Cloud agents: state, repo, branch, PR and checks, duration |
| `/vos agent <owner/repo[@base]> <task>` | Starts a cloud agent (owned by main); without the GitHub App on the repo it says where to install it |
| `/vos chat <name> [message]` | Sends to a vos or group chat (names with spaces work) and follows the reply as it streams in; with no message, shows the latest |
| `/vos memory <name>` | What a vos remembers |
| `/vos routines [name]` | A vos's routines and triggers (main when no name) |
| `/vos connectors [name]` | The apps a vos can use |
| `/vos code <name> <task> [in owner/repo]` | Starts a coding agent on the vos's computer |
| `/vos skills` | The shared skills library |
| `/vos rules` | Auto-review rules, with approvals in advance and their expiry |
| `/vos groups` | Group chats and their members |
| `/vos connect` | Pairs with your phone: a QR above the prompt and a six-digit code; approve in the Vos app. `/vos connect help` explains the API-key way |

## Key

Pairing (`POST /pair`, QR drawn locally by `qr.ts`, polled until the phone
approves) mints a device key, which goes to the host's secret store
(`smolt.secrets`): the OS keystore when the desktop app runs the agent, a 0600
file in the terminal. The server address stays in `~/.smolt/vos.json`.
`VOS_API_KEY` (server from `VOS_URL`) wins over both. Keys earlier versions
kept in `vos.json` are moved into the secret store once (the terminal's by
`config.ts`, the desktop's encrypted one by the desktop app, which alone can
decrypt it). Secret requests are never answered from the terminal.
