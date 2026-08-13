# Installation guide

Do not paste secrets into prompts, source files, commits, shell command arguments, or logs. Perform
secret entry in a trusted interactive terminal and keep generated credential files out of Git and
unapproved backups.

## Choose a service

### Use Henrique's hosted service

`https://zettelkasten.henriquebastos.net` is a maintained deployment, and its unauthenticated
`GET /health` endpoint currently returns `{"ok":true}`. It does **not** provide public namespace
registration or a public provisioning channel. Use it only if its operator has already given you a
namespace ID and its corresponding capability through a private route. Never request or exchange a
capability in a public issue.

If you do not already have hosted credentials, self-host the service. Installing a harness plugin
alone does not create a namespace.

### Self-host on Cloudflare Workers

Prerequisites are a Cloudflare account with Workers enabled, Bun 1.3.10, and Wrangler authentication
authorized to deploy Workers and create SQLite Durable Objects. The portable default config uses
the authenticated account, enables its `workers.dev` endpoint, and declares `Hierarchy` through
Wrangler's current SQLite Durable Object `exports` lifecycle. It has no maintainer account ID or
custom-domain route.

```bash
git clone https://github.com/henriquebastos/zettelkasten.git
cd zettelkasten
bun install --frozen-lockfile
bun run check
./node_modules/.bin/wrangler login
```

Set two independent Worker secrets during the first deployment. Generate separate random values in
a password manager; do not reuse a Cloudflare, harness, or namespace credential. This uploads code
and both secrets together, then removes the temporary user-only file:

```bash
(
set -euo pipefail
secrets_file="$(mktemp)"
chmod 600 "$secrets_file"
trap 'rm -f "$secrets_file"; unset SERVICE_ADMIN_TOKEN CAPABILITY_SIGNING_KEY' EXIT
read -rsp 'Service admin token: ' SERVICE_ADMIN_TOKEN && echo
read -rsp 'Capability signing key: ' CAPABILITY_SIGNING_KEY && echo
printf 'SERVICE_ADMIN_TOKEN=%s\nCAPABILITY_SIGNING_KEY=%s\n' \
  "$SERVICE_ADMIN_TOKEN" "$CAPABILITY_SIGNING_KEY" > "$secrets_file"
./node_modules/.bin/wrangler deploy --secrets-file "$secrets_file"
rm -f "$secrets_file"
unset SERVICE_ADMIN_TOKEN CAPABILITY_SIGNING_KEY
trap - EXIT
)
```

Wrangler prints the resulting `workers.dev` URL; use that exact origin as `SERVICE_URL`. Confirm it
without credentials:

```bash
curl --fail-with-body "$SERVICE_URL/health"
```

Create the namespace with the service admin token in the `Authorization` header. Use a client or
secret-manager workflow that does not put the token in argv or print the response. For example, this
prompted script writes the response directly to a user-only file:

```bash
python3 - "$SERVICE_URL" <<'PY'
import getpass, json, os, pathlib, sys, urllib.request

request = urllib.request.Request(
    sys.argv[1].rstrip('/') + '/v1/admin/namespaces',
    data=json.dumps({'name': 'shared-coding-agents'}).encode(),
    headers={
        'Authorization': 'Bearer ' + getpass.getpass('Service admin token: '),
        'Content-Type': 'application/json',
    },
    method='POST',
)
with urllib.request.urlopen(request) as response:
    directory = pathlib.Path.home() / '.config' / 'zettelkasten'
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    directory.chmod(0o700)
    path = directory / 'namespace.private.json'
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'wb') as output:
        output.write(response.read())
PY
```

The script refuses to overwrite an existing credential file. Keep
`~/.config/zettelkasten/namespace.private.json` out of unapproved backups. Its shape is:

```json
{
  "namespaceID": "ns_...",
  "name": "shared-coding-agents",
  "state": "initializing",
  "capabilityToken": "..."
}
```

Retain `namespaceID` as configuration and `capabilityToken` as a secret. While the namespace is
`initializing`, an operator may import an existing hierarchy parent-first with
`POST /v1/admin/namespaces/{namespaceID}/imports`. Then activate it with
`POST /v1/admin/namespaces/{namespaceID}/activate`. Activation closes imports and enables normal
allocation. All namespace lifecycle requests use the service admin token; harnesses receive only the
namespace capability.

To add a custom domain, add your own Wrangler custom-domain route in a private or deployment-specific
configuration after the `workers.dev` deployment works. The committed
`wrangler.production.template.jsonc` demonstrates this repository's production shape without an
account ID or domain. It is not a deployable config: `scripts/deploy-production.ts` validates it
against the portable config and materializes an ignored, user-only temporary config from the private
deployment environment.

## Install harness integrations

Configure multiple harnesses with the same service URL, namespace ID, and corresponding capability
to share a hierarchy. Provision different namespaces and capabilities when isolation is required.

### Install in Amp

Amp loads project plugins from `.amp/plugins/*.ts` and user-local plugins from
`~/.config/amp/plugins/*.ts`. Because this integration has relative modules, install its bundled
single-file form. Follow the exact build, configuration, reload, private Personal Plugins repository,
and update instructions in [`integrations/amp/README.md`](../integrations/amp/README.md#install).
Inject the namespace values and Amp's required `AMP_API_KEY` into the Amp process; never store them
in this public repository.

### Install in Claude Code

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

Restart Claude Code after installation if the frontend does not offer `/reload-plugins`. Worktrees
created after plugin initialization, including isolated subagent worktrees, use
`<address>-<native-description>` labels while retaining Claude's native location, branch, and
included-file behavior. Claude Code has no worktree location setting, so the native
`<main-checkout>/.claude/worktrees` root is used; your `worktree.baseRef`, `worktree.sparsePaths`,
and `worktree.symlinkDirectories` settings are read from Claude's own layered configuration and
applied. Root CLI `claude --worktree` creation precedes plugin hook registration in
2.1.227 and retains its native name. Confirm
the installation without printing configuration values:

```bash
claude plugin list
claude plugin details zettelkasten-hierarchy@zettelkasten
```

Inside an interactive session, `/plugin` should show `zettelkasten-hierarchy` enabled and `/hooks`
should show its `WorktreeCreate`, `SessionStart`, `UserPromptSubmit`, and `SubagentStart` hooks. `UserPromptSubmit`
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
update the marketplace instead. Plugin version `0.5.0` is pinned by its manifest, so published
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

### Install in Codex

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

Configure the same existing namespace used by the other harnesses from a trusted terminal. The
installation command's JSON result contains the installed path; `configure.ts` masks capability
input and never places it in argv. Codex 0.147.0 does not include `installedPath` in
`plugin list --json`:

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

Codex desktop worktrees remain managed by the desktop app. Although the app supports a configurable
worktree root, handoff, snapshots, restoration, and cleanup, the 0.147.0 CLI/app-server API exposes
none of those lifecycle operations to this plugin. The integration does not rename app-owned
worktrees after startup or infer thread identity from their paths.

Update or remove the installation with:

```bash
codex plugin marketplace upgrade zettelkasten
codex plugin add zettelkasten-hierarchy@zettelkasten --json
codex plugin remove zettelkasten-hierarchy@zettelkasten
codex plugin marketplace remove zettelkasten
```

See [`integrations/codex/README.md`](../integrations/codex/README.md) for runtime boundaries and
checkout-development configuration.

### Install in Pi

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
