# Agent installation guide

Do not paste secrets into prompts, source files, commits, or logs. Perform these steps using secret
stores or environment injection available to the deployment and harness.

1. Deploy the root Worker with Wrangler. Provide `CLOUDFLARE_API_TOKEN` only to Wrangler and set
   `SERVICE_ADMIN_TOKEN` and `CAPABILITY_SIGNING_KEY` as Worker secrets. The public endpoint is
   `https://zettelkasten.henriquebastos.net`; the deployment's `workers.dev` hostname is a fallback.
2. With the service admin credential, call `POST /v1/admin/namespaces`, retain the returned
   namespace ID and capability in a secret manager, optionally import an existing hierarchy
   parent-first, then call `POST /v1/admin/namespaces/{namespaceID}/activate`. Never give an
   integration the service admin credential.
3. For Amp, copy `integrations/amp` into a **private personal User Plugins repository**. That private
   repository remains the installed configuration's source of truth; pull public implementation
   updates into it rather than committing personal configuration here. Inject
   `ZETTELKASTEN_SERVICE_URL`, `ZETTELKASTEN_NAMESPACE_ID`,
   `ZETTELKASTEN_NAMESPACE_CAPABILITY`, and the Amp-required `AMP_API_KEY` into the Amp process.
   Run the plugin tests and bundle command documented in its README before enabling it.
4. Install and configure the Claude Code, Codex, and Pi integrations as described below.

Configure multiple harnesses with the same namespace to share a hierarchy. Provision different
namespaces and capabilities when isolation is required.

## Install in Claude Code

The plugin supports Claude Code 2.1.227 running with Node 22.23.2 on `PATH` in a POSIX environment
such as Linux or macOS. It works in the Claude Code CLI and in local Claude Code frontends that load
Claude Code plugins, execute lifecycle hooks, and provide the same POSIX environment. Native Windows
and PowerShell are not currently supported. The plugin does not run inside the Claude web chat,
which has no access to local plugin hooks or the required process environment.

### Install from GitHub

For an installation available in every project, add this repository as a marketplace and install
the plugin at user scope:

```bash
claude plugin marketplace add https://github.com/henriquebastos/zettelkasten.git --scope user
claude plugin install zettelkasten-hierarchy@zettelkasten --scope user
```

The same operations are available in an interactive Claude Code frontend:

```text
/plugin marketplace add https://github.com/henriquebastos/zettelkasten.git
/plugin install zettelkasten-hierarchy@zettelkasten
```

Choose **User** scope in the installation view so the same native hierarchy integration is active
across projects. Use `--scope local` or choose **Local** only when the plugin should apply to the
current checkout and user. Project scope writes shared Claude settings into the current repository;
review and commit that configuration only when the whole project should require this marketplace.

### Configure the shared namespace

Claude prompts for three required plugin options when the plugin is enabled:

- **Zettelkasten service URL** — defaults to `https://zettelkasten.henriquebastos.net`.
- **Namespace ID** — enter the same existing namespace ID configured for Amp, Codex, and Pi when
  those harnesses should share one hierarchy.
- **Namespace capability** — enter the capability corresponding to that namespace. Claude masks
  this sensitive field and stores it in its credential store instead of user settings.

Use the installed plugin's **Configure** action in `/plugin` to set or change these values. This is
also available in graphical local Claude Code frontends that expose the same plugin configuration
view. Do not use project or local Claude settings for these values: Claude deliberately reads plugin
configuration only from user, managed, and explicit `--settings` sources. That prevents a checkout
from redirecting hooks or injecting a credential.

On macOS, Claude stores the sensitive capability in Keychain. On supported POSIX platforms without
Keychain, Claude stores it in the private `~/.claude/.credentials.json` credential file. Keep that
file user-readable only, keep it out of backups that are not approved for credentials, and never
copy it into a repository or another machine. The namespace ID and service URL are non-secret and
are persisted under the plugin's user configuration in `~/.claude/settings.json`.

Do not pass the capability through `--config` in a recorded shell command, where it can enter shell
history or a process listing. Do not place it in a repository, `.claude/settings.json`, logs,
artifacts, or prompts. The plugin needs only the namespace capability; never provide a service admin
token, capability-signing key, Cloudflare token, or Claude credential.

The installed launcher does not copy the capability into its command line, inline child settings,
session environment file, receipt, or cache. Each native background child loads the same installed
user configuration and credential independently. It still inherits the launching Claude process's
ordinary environment, so start Claude from a least-privileged environment that excludes unrelated
deployment, administration, or signing credentials.

Restart Claude Code after installation if the frontend does not offer `/reload-plugins`. Confirm
the installation without printing configuration values:

```bash
claude plugin list
claude plugin details zettelkasten-hierarchy@zettelkasten
```

Inside an interactive session, `/plugin` should show `zettelkasten-hierarchy` enabled and `/hooks`
should show its `SessionStart`, `UserPromptSubmit`, and `SubagentStart` hooks. `UserPromptSubmit`
performs only the one-shot canonical retitle after `/clear` and otherwise returns no output. A
configured session receives its canonical address in the title. It can create an independent, native
child session with the launcher command provided in its initial context; that child remains visible
through `claude agents`.

### Update or uninstall

```bash
claude plugin marketplace update zettelkasten
claude plugin update zettelkasten-hierarchy@zettelkasten
claude plugin uninstall zettelkasten-hierarchy@zettelkasten
```

Marketplace installation copies the plugin into Claude's local cache. Do not edit that cache;
update the marketplace instead. Plugin version `0.3.0` is pinned by its manifest, so published
changes must increment that version before existing installations can update.

### Develop from a checkout

To exercise uncommitted plugin code without changing an installed copy:

```bash
export ZETTELKASTEN_SERVICE_URL='https://zettelkasten.henriquebastos.net'
export ZETTELKASTEN_NAMESPACE_ID='ns_...'
read -rsp 'Namespace capability: ' ZETTELKASTEN_NAMESPACE_CAPABILITY && echo
export ZETTELKASTEN_NAMESPACE_CAPABILITY
claude --plugin-dir ./integrations/claude-code
unset ZETTELKASTEN_NAMESPACE_CAPABILITY
```

The process environment is a development fallback for a checkout-loaded plugin. This development
flag is temporary for that Claude process. Persistent installations should use the marketplace
plugin's native user configuration above.

## Install in Codex

The plugin supports Codex CLI 0.147.0 and Codex frontends that share its local plugin installation,
hook, app-server, and history surfaces. Add the GitHub marketplace and install at user scope:

```bash
codex plugin marketplace add https://github.com/henriquebastos/zettelkasten.git
INSTALL_RESULT="$(codex plugin add zettelkasten-hierarchy@zettelkasten --json)"
```

The plugin then appears in Codex's installed plugin list and in supported graphical plugin views.
Restart the frontend, open `/hooks`, inspect the installed `SessionStart`, `SubagentStart`, and
`SubagentStop` commands, and trust their exact definitions. Codex hashes hook definitions and
requires another review after they change.

Configure the same existing namespace used by the other harnesses from a trusted terminal. This
The install result contains the installed path; `configure.ts` masks capability input and never
places it in argv. Codex 0.147.0 does not include `installedPath` in `plugin list --json`:

```bash
PLUGIN_ROOT="$(printf '%s' "$INSTALL_RESULT" | node -e '
let s=""; process.stdin.on("data", c => s += c); process.stdin.on("end", () => {
  const path = JSON.parse(s).installedPath
  if (!path) process.exit(1)
  process.stdout.write(path)
})')"
node "$PLUGIN_ROOT/configure.ts"
unset PLUGIN_ROOT INSTALL_RESULT
```

The script writes the service URL and namespace ID to
`$CODEX_HOME/zettelkasten/config.json` and the namespace capability separately to
`$CODEX_HOME/zettelkasten/capability`; without `CODEX_HOME`, it uses `~/.codex/zettelkasten`.
The directory is mode `0700` and both files are mode `0600`. Partial file configuration fails
closed and never mixes with environment values. Keep both files out of Git, backups not approved
for credentials, prompts, logs, and artifacts. Provide only a namespace capability, never an admin,
signing, Cloudflare, OpenAI, or other harness credential.

These file modes protect against other OS users and accidental disclosure, not Codex tools running
as the same OS user. Codex 0.147.0 has no plugin credential-store API that isolates a capability
from that tool boundary. Prefer a dedicated least-privilege Codex namespace for untrusted workloads.
Using the shared namespace is supported, but means accepting that same-user access boundary.

Configured roots, resumes, forks, and nested native subagents receive remote addresses in Codex's
native thread name. To create a separate full Codex root as a child, use the launcher command added
to the session context. It reads Codex's own `CODEX_THREAD_ID`; the model never propagates identity.
Because creation writes Codex's user-local history, approve execution of that exact launcher outside
the tool sandbox; Node and `codex` must be available on that elevated process's `PATH`. The launcher
preallocates and names the child, sends its task over stdin to
`codex exec resume`, and suppresses machine event output containing opaque IDs. The child remains in
normal Codex history and is resumable by native ID.

Root allocation failures stop the turn before model output. Codex 0.147.0 does not let a
`SubagentStart` hook stop a child model: blocking JSON, `continue: false`, exit 2, generic failure,
and timeout were all tested and still ran the child. On subagent reconciliation failure, the plugin
therefore emits a warning and creates neither a canonical title nor a local assignment. Use service
availability controls outside Codex if unnumbered subagent execution must be prohibited.

Handled root failures use an internal deadline so the hook can return blocking JSON before its
20-second host timeout. A hook process crash, forced kill, or host timeout still fails open in Codex
0.147.0. The launcher can recover an ambiguous remote allocation once it knows the native ID, but
Codex has no idempotency key for `thread/start`; a crash or lost start response can orphan an
unassigned native root.

Update or remove the installation with:

```bash
codex plugin marketplace upgrade zettelkasten
codex plugin add zettelkasten-hierarchy@zettelkasten --json
codex plugin remove zettelkasten-hierarchy@zettelkasten
codex plugin marketplace remove zettelkasten
```

See [`integrations/codex/README.md`](../integrations/codex/README.md) for runtime boundaries and
checkout-development configuration.

## Install in Pi

Pi 0.84.1 on POSIX platforms can install this repository directly as a user package. Native Windows
is unsupported because the integration requires Unix credential modes and no-follow session-file
reads; use WSL, Linux, or macOS.

```bash
pi install git:github.com/henriquebastos/zettelkasten
```

Review the package first: Pi extensions execute with the user's full permissions. The package
manifest loads `integrations/pi/index.ts`. Confirm installation with `pi list`, then restart Pi.

Configure the shared namespace from a trusted terminal. For the GitHub installation above, Pi's
documented clone location is:

```bash
node ~/.pi/agent/git/github.com/henriquebastos/zettelkasten/integrations/pi/configure.ts
```

For a local checkout installed with `pi install /absolute/path/to/zettelkasten`, run the same
`integrations/pi/configure.ts` from that checkout. Enter the namespace ID used by the other
harnesses and only its namespace capability. The capability is masked and does not enter argv.

Configuration is stored under `$PI_CODING_AGENT_DIR/zettelkasten`, or
`~/.pi/agent/zettelkasten` by default. The directory is mode `0700`; `config.json` and the separate
`capability` file are mode `0600`. These permissions prevent other-user and accidental access, not
same-user Pi tools or extensions. Prefer a dedicated least-privilege Pi namespace for untrusted
workloads, and never provide an administration or provider credential.

Every persistent root, resume, and native fork receives a canonical address in its Pi session name.
Use `/zk-child <task>` to create and enter a separately resumable native child. This is foreground
session navigation: Pi replaces the current TUI with the child rather than running it concurrently.
The parent must have completed its first persisted assistant turn because Pi does not write a fresh
session's JSONL file before then. `--no-session` is unsupported because it cannot preserve durable
parentage.

On hierarchy failure, ordinary input is handled before model startup, and compaction plus summarized
tree navigation are cancelled. Pi has no universal provider veto: another installed extension can
call a provider directly, and handled print/JSON input can still exit zero. No title or local
assignment is invented.

Update or remove the package with:

```bash
pi update git:github.com/henriquebastos/zettelkasten
pi remove git:github.com/henriquebastos/zettelkasten
```

See [`integrations/pi/README.md`](../integrations/pi/README.md) for the native lifecycle and security
boundaries.
