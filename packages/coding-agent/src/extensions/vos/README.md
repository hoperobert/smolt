# vos

`/vos` reaches the user's Vos teammates (vos-api.vosgrau.com) from the terminal.

| Command | What it does |
| --- | --- |
| `/vos` | Roster: each vos's mood, label and unread count, group chats, hidden vos |
| `/vos chat <name> [message]` | Sends to a vos or group chat (names with spaces work) and follows the reply as it streams in; with no message, shows the latest |
| `/vos routines [name]` | A vos's routines and triggers (main when no name) |
| `/vos skills` | The shared skills library |
| `/vos rules` | Auto-review rules |
| `/vos groups` | Group chats and their members |
| `/vos connect` | Pairs with your phone: a QR above the prompt and a six-digit code; approve in the Vos app. `/vos connect help` explains the API-key way |

## Key

`/vos connect` asks the server for a pairing (`POST /pair`), draws its QR
locally (`qr.ts`, no dependency), and polls until the phone approves; the
device key it receives is written to `~/.smolt/vos.json` as `apiKey`, mode
0600, and can be revoked from the phone. `VOS_API_KEY` (server from
`VOS_URL`, default `https://vos-api.vosgrau.com`) still works and wins. The desktop app's Vos section writes the same file, but
its key is encrypted with Electron safeStorage (the OS keystore), which only
the desktop app can decrypt, so the TUI cannot read that one. Secret requests
are never answered from the TUI.

`client.ts`, `types.ts`, `format.ts` and `sse.ts` are shared with the desktop
app, whose main process holds its own key and makes every Vos call.
