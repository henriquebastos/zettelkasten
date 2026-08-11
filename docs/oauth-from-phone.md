# OAuth from a Phone in an Amp Orb

Use this runbook when the Navigator is on a phone and an agent operates a persistent Amp orb.
Authentication is an explicit human checkpoint: the agent may start and observe the CLI, but the
Navigator approves access in the provider's browser page.

## Shared protocol

1. Use the dedicated integration thread. Do not authenticate disposable review or test orbs.
2. The agent starts the login command in an interactive tmux window so it survives tool calls and
   can receive later input. Never run an OAuth command through a non-interactive one-shot shell.
3. The agent captures only the authorization URL, device code, instructions, and final status.
   Never display credential files, environment values, access tokens, or refresh tokens.
4. The agent sends the URL as a clickable HTTPS link in the private Amp thread. Send a device code
   as text next to the link. Verify that the hostname belongs to Anthropic or OpenAI before sharing
   it; do not rewrite or shorten provider URLs.
5. The Navigator opens the link on the phone, checks the provider and requested access, signs in,
   and approves it. A device-code flow then completes by polling; the Navigator only needs to say
   that approval is complete.
6. If the browser returns a one-time code instead of completing by polling, the Navigator should
   paste it directly into the waiting prompt through the orb's Terminal tab. Sending it in chat is
   a fallback only: it leaves the short-lived code in conversation history.
7. The agent waits on the existing tmux process, reports success or the exact redacted failure, and
   closes the authentication window. Do not rerun a login blindly after an uncertain result.
8. Verify with the CLI's status command or a harmless model listing. Report only authenticated/not
   authenticated; omit account identity and credential details.

Authorization URLs and device codes are temporary credentials. Share them only in the private
integration thread, consume them once, and never copy them into project files, logs, artifacts,
issues, or commits.

## Claude Code subscription

Start the subscription login in tmux:

```bash
claude auth login --claudeai
```

Send the exact `https://claude.ai/` or `https://platform.claude.com/` authorization link shown by
Claude Code. In a remote orb, the browser may show a one-time login code because the phone cannot
reach the orb's loopback callback. The safest return path is the Terminal tab: paste that code into
Claude Code's waiting `Paste code here if prompted` field.

After completion, use `claude auth status` only as a local pass/fail check. Claude stores the login
outside the repository under `~/.claude/` with user-only permissions.

## Codex ChatGPT subscription

Use the device flow, which is the preferred phone path:

```bash
codex login --device-auth
```

Device-code login may first need to be enabled in ChatGPT under **Settings → Security**. Send the
exact OpenAI verification URL and displayed code. The CLI polls automatically, so after approval
the Navigator can simply say that it is done. Confirm locally with `codex login status` without
repeating account details. Codex stores the login outside the repository under `~/.codex/`.

## Pi with a ChatGPT subscription

Run Pi interactively in tmux:

```bash
pi
```

Enter `/login`, choose **ChatGPT Plus/Pro (Codex)**, and choose the device-code method. Send the
exact OpenAI verification URL and code; Pi polls until phone approval completes. Pi stores the
login outside the repository at `~/.pi/agent/auth.json` with user-only permissions.

The pinned Pi distribution also includes its provider login CLI. An agent may use it from Pi's
private agent directory when plain terminal output is more reliable than driving the TUI:

```bash
install -d -m 700 "$HOME/.pi/agent"
cd "$HOME/.pi/agent"
umask 077
node "$HOME/.local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/cli.js" login openai-codex
```

Inspect the offered methods and select device code by its label rather than assuming a menu number.
Do not print or inspect the resulting `auth.json`.

## Persistence and recovery

An Amp thread owns one orb. These credential files survive ordinary pause/resume of that orb but
do not appear in a different thread's fresh orb. Multiple agent turns and the shared Terminal can
use the authenticated orb; independent Amp threads cannot attach to it.

If authentication expires, repeat only that provider's flow. If the outcome of a login is unclear,
check status before retrying. Use each provider's logout command before intentionally replacing or
revoking a login. Never copy OpenAI OAuth files into multiple concurrent orbs: rotating refresh
tokens make independent copies unsafe.
