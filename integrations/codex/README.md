# Codex integration

This Codex 0.147.0 plugin assigns canonical remote addresses to CLI, app-server, fork, and native
subagent threads. It uses Codex lifecycle hooks for delivery and the stable app-server
`thread/read` contract for identity and exact immediate parent provenance. Display names are changed
with `thread/name/set`; names are never read as identity.

The hook recursively reconciles missing ancestors parent-first, uses only opaque
`codex:<native-thread-id>` keys, delegates concurrency and retries to remote idempotency, validates
the returned direct lineage, and fails closed without a local allocation.

`SessionStart` can stop a root before model work. Codex 0.147.0 does not provide an enforcement
boundary at `SubagentStart`: runtime tests confirmed that `continue: false`, blocking JSON, exit 2,
generic failure, and timeout all still allow the child model to run. A native subagent therefore
receives a visible warning and no title or local assignment when remote reconciliation fails, but
cannot be stopped by this plugin. This is a Codex boundary, not a fallback allocation.

## Install and configure

Add this repository as a Codex marketplace, then install `zettelkasten-hierarchy`:

```bash
codex plugin marketplace add https://github.com/henriquebastos/zettelkasten.git
INSTALL_RESULT="$(codex plugin add zettelkasten-hierarchy@zettelkasten --json)"
```

Read the top-level `installedPath` from `INSTALL_RESULT`, then run that installation's `configure.ts`
in a trusted terminal and unset `INSTALL_RESULT`. (`codex plugin list --json` does not expose the
installed path in 0.147.0.) Node and `codex` must both be available on `PATH`. Enter the same namespace ID used by
Amp, Claude Code, and Pi. The script writes non-secret settings to
`$CODEX_HOME/zettelkasten/config.json` and the capability separately to
`$CODEX_HOME/zettelkasten/capability`, with user-only permissions. If `CODEX_HOME` is unset,
`~/.codex` is used. Do not pass the capability in argv, prompts, logs, or Codex config TOML.

Mode `0600` protects the capability from other OS users and accidental exposure, but it is not a
secure store against Codex shell tools running as the same user. Codex 0.147.0 exposes no plugin
credential-store API that provides that isolation. Use a dedicated least-privilege namespace and
capability for Codex when its workloads are not fully trusted. Sharing a namespace with other
harnesses is supported, but grants that Codex installation the namespace capability under this
same-user boundary. Never give the plugin an admin capability.

Codex requires review of newly installed hooks. Open `/hooks`, inspect the plugin source, and trust
the exact `SessionStart`, `SubagentStart`, and `SubagentStop` definitions. Restart Codex after
installation. The stop hook reapplies the canonical name after Codex finishes writing short-lived
nested subagent state, then schedules a silent delayed verification because Codex can persist a
final nested record after the hook returns. The helper receives the opaque ID over stdin, not argv,
and emits no output.

For checkout development only, the three `ZETTELKASTEN_*` environment variables remain an atomic
fallback. Persistent installs should use the user-local files.

## Native child launcher

Each root receives a launcher command in its initial hook context. The launcher obtains its parent
from Codex's own `CODEX_THREAD_ID`, creates an independent native root through app-server, records
private local launcher provenance, allocates and names it, then runs its first turn through normal
`codex exec resume`. The child appears in normal Codex history and can be resumed by its opaque ID.
Codex does not persist native parent metadata for an independent root, so the immutable remote
assignment created by the launcher remains authoritative. The local receipt prevents accidental
acceptance of unrelated parentless roots; like the capability file, it is not protected from
same-user shell tools. The model never needs to supply or propagate either ID.

Creating the native root writes Codex's user-local history, so an agent tool call must request
explicit execution outside the tool sandbox. Node and `codex` must be on the elevated process's
`PATH`. The launcher fails closed when elevation is denied.
The launcher does not require globally disabling the sandbox; only its exact command needs this
permission. Codex's optional daemon could avoid that elevation, but 0.147.0's npm installation
cannot run the daemon, so the integration does not depend on it.

## Supported boundary

Codex plugin hooks and stdio app-server were tested from running 0.147.0, including roots, resume,
nested subagents, exact parent records, fork provenance, launcher roots, failure paths, and names.
Independent launcher children are remote children but native parentless roots; native subagents use
Codex's exact stored immediate parent. Name-based resume did not find
an app-server-origin thread and started another root, so every handoff uses the opaque ID. The hook
does not parse TUI output or transcripts. If allocation fails at session start, Codex's unavoidable
native session record remains, but the hook emits no canonical title or local assignment and blocks
the root turn before a model response. Native subagent hook failures have the warning-only boundary
described above.

A handled root failure is blocked because the integration reserves an internal deadline to emit
valid hook JSON before Codex's 20-second host timeout. A process crash, forced kill, or host timeout
can still fail open in Codex 0.147.0. Launcher recovery is exactly-once only after a known native ID:
a crash or lost `thread/start` result can leave an unassigned native root because Codex provides no
idempotency key for native root creation.

## Codex desktop worktrees

Codex desktop can create managed and permanent worktrees under its configured worktree root,
associate a managed worktree with a chat, hand the chat between local and worktree checkouts, save
snapshots before cleanup, and restore deleted managed worktrees. Those are desktop-owned features.

The pinned Codex CLI/app-server 0.147.0 schema and live protocol expose a thread's stable opaque ID
and cwd but no worktree create, association, move, handoff, restore, or remove operation or event.
The plugin therefore cannot safely choose or change a desktop-managed worktree directory name.
Renaming after `SessionStart` would stale the app's recorded cwd and destabilize the active thread;
inferring association from cwd would violate the identity contract. Codex worktrees remain native
and unchanged until a supported pre-creation naming API exists.
