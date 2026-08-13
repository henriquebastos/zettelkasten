# Claude Code integration

This directory is a Claude Code plugin that assigns remotely authoritative Zettelkasten addresses
to main sessions and visible subagents. It uses only supported Claude Code 2.1.227 lifecycle and
display surfaces.

## Identity and hierarchy

- A main session is a root keyed as `claude:<session_id>`.
- A visible subagent is its direct child, keyed as `claude:<agent_id>` with the main session key as
  its exact parent.
- `SessionStart` sets the canonical returned address in the session title. Because Claude ignores
  that title output during `/clear`, a one-shot `UserPromptSubmit` hook applies the cleared session's
  new canonical root title on its first prompt.
- `SubagentStart` resolves the root created by `SessionStart` without creating it, then allocates the
  child, caches only the validated returned address, and gives the subagent that address as hook
  context.
- Each session receives an authoritative launcher command through its session environment and
  initial hook context. The launcher resolves the current session and starts a native `claude --bg`
  session with the current opaque session ID as structured parent metadata.
- Claude generates the background session's native ID. Its own `SessionStart` hook allocates that
  exact ID under the launcher parent, validates direct lineage, sets the canonical title, and writes
  a canonical-address-only startup receipt.
- The launcher maps Claude's returned background job ID to the full native session ID through
  `claude agents --json --all`, consumes the exact receipt, revalidates direct lineage, and reports
  success only then. It stops the background job when confirmation fails and verifies that native
  agent view reports no job or a terminal `stopped`, `failed`, or `done` state.
- `subagentStatusLine` reads that display cache and prefixes each live native task row with its
  canonical address. Its command is self-contained because Claude does not provide plugin root or
  plugin data variables to status-line processes.
- Resumes repeat the same key and parent and rely on service idempotency.
- Internal agent events without a visible `agent_type` are ignored.

## Managed worktree labels

After plugin initialization, Claude Code 2.1.227 fires blocking `WorktreeCreate` with the stable
root session ID and its native generated or user-supplied worktree description. This covers
in-session creation such as isolated subagents and background sessions. The plugin uses that ID for
normal remote allocation, then creates the Git worktree at Claude's native main-checkout location:

```text
<main-checkout>/.claude/worktrees/<address>-<native-description>
```

It preserves the pinned CLI's `worktree-<native-description>` branch, fetched `origin/main` baseline
with local `HEAD` fallback, and `.worktreeinclude` copying of selected ignored regular files. Dirty tracked files are not
copied, source symlinks are skipped, and existing destination files are not overwritten. Invocation
from another linked worktree still uses the main checkout's native managed-worktree directory.

The path is cleanup-oriented display metadata only. The plugin never reads it as session identity
or parentage, never chases later session-title changes, and permits several worktrees to carry the
same session address with different descriptions. Configuration, service, lineage, invalid-name,
collision, and Git failures abort creation; no local address or random fallback is invented.

For isolated subagents, Claude exposes the root `session_id` during `WorktreeCreate` and exposes the
separate `agent_id` only later at `SubagentStart`. Their worktree label therefore carries the root
session address plus Claude's native agent description. The plugin does not parse the generated
description to manufacture child identity. Runtime probing also found a completed isolated
subagent that emitted no documented `WorktreeRemove` and remained registered, so cleanup events are
treated as best-effort lifecycle rather than hierarchy truth.

Root CLI `claude --worktree` is a different startup boundary. Running both inline and installed
plugin probes showed that Claude creates that worktree before it registers plugin hooks. The plugin
cannot label it at this version. Renaming it at `SessionStart` was also exercised and rejected: it
stales Claude's recorded cwd and aborts startup. Root startup worktrees therefore retain Claude's
native name rather than being changed through an unsupported path.

Claude Code reports `source: "fork"` for native session forks but does not expose the source session
ID to hooks. The plugin therefore defers fork allocation rather than inventing a root or inferring
immutable parentage from mutable or undocumented state.

## Independent background sessions

Claude receives this launch route as `SessionStart` context:

```bash
node "$ZETTELKASTEN_CLAUDE_LAUNCHER" "<task>"
```

Use it whenever one full Claude Code session should create another. The launcher invokes Claude's
native background-session supervisor, so the child appears in `claude agents`, can be opened with
`claude attach <id>`, and remains independently resumable. This is intentionally different from an
Agent-tool subagent, which stays inside the parent's conversation and subagent panel.

Claude Code 2.1.227 ignores caller-supplied `--session-id` when combined with `--bg`. The launcher
therefore does not preallocate a guessed ID. It passes only the opaque parent ID through an inline
Claude settings override; the child hook allocates Claude's actual generated session ID. No service
credential is copied into that override.

The launcher resolves and validates the absolute pinned Claude 2.1.227 executable before dispatch.
It places `--` before the task so option-looking text remains prompt content. After consuming the
launch parent, the child hook clears that one-time marker from subsequent Bash environments and
exports the child's own ID for grandchildren. Background children can use the same launcher and can
also create ordinary Agent-tool subagents beneath themselves.

Agent view derives its row name from the launch task, while the attached child's prompt bar and
resume title use the canonical address returned through `SessionStart.sessionTitle`.

## Requirements and configuration

Marketplace installations declare native Claude plugin configuration for the service URL, namespace
ID, and capability. Choose the same existing namespace ID and corresponding capability used by the
other coding-agent integrations to share one hierarchy. Claude persists the non-secret service URL
and namespace ID in user settings; the capability is marked sensitive and stored in Keychain or
Claude's private credential file. Hook processes receive the values through
`CLAUDE_PLUGIN_OPTION_*`; a partial plugin configuration fails closed rather than borrowing missing
values from process variables.

The dedicated integration lab also supports loading the checkout directly. That path runs the
TypeScript hook with repository Node 22.23.2 on `PATH` and uses these process variables as a
development fallback:

```bash
export ZETTELKASTEN_SERVICE_URL='https://zettelkasten.example.com'
export ZETTELKASTEN_NAMESPACE_ID='ns_...'
read -rsp 'Namespace capability: ' ZETTELKASTEN_NAMESPACE_CAPABILITY && echo
export ZETTELKASTEN_NAMESPACE_CAPABILITY
claude
unset ZETTELKASTEN_NAMESPACE_CAPABILITY
```

The namespace capability is the only service credential the integration receives. Never provide a
service administration token, capability signing key, deployment token, or Cloudflare credential.
Keep the capability outside repositories, shell history, logs, artifacts, and Claude project
memory. The installed launcher carries only the opaque parent session ID in child settings; every
child loads the configured credential directly from Claude's credential store.

For persistent user, local, or project installation through the repository's Claude marketplace,
see the [installation guide](../../docs/installation.md#install-in-claude-code).

Load this checkout directly during development:

```bash
claude --plugin-dir ./integrations/claude-code
```

Use `/plugin` to confirm `zettelkasten-hierarchy` is enabled and `/hooks` to inspect its
`WorktreeCreate`, `SessionStart`, `UserPromptSubmit`, and `SubagentStart` hooks. `UserPromptSubmit` performs only the
one-shot canonical retitle after `/clear` and otherwise returns no output.

## Failure behavior

Configuration is checked before any fetch. Network failures, rejected requests, malformed or
conflicting assignments, invalid addresses, wrong lineage, and forks without native parent
provenance leave title and subagent display metadata unchanged. The plugin never allocates, repairs,
or persists a local fallback. Its user-cache state contains only canonical returned addresses keyed
by filesystem-safe encodings of opaque native agent IDs; it contains no keys, parent keys,
credentials, prompts, transcripts, or account identity.

The launcher refuses to start without the session-scoped parent ID and canonical parent address
validated by the startup hook. Its structured launch override contains only that opaque parent ID.
The child hook resolves the exact parent before allocation and writes a receipt only after validating
direct lineage. Background-session startup uses Claude's native supervisor; marketplace children
load the installed user configuration, while checkout-loaded children inherit the lab's orb-local
development configuration.
The native child inherits the launching Claude process environment, so the parent must run with a
least-privileged environment that excludes unrelated administration and deployment credentials.
Service requests have a seven-second deadline within Claude's ten-second hook budget. A launched
child hook failure stops its first turn, and a missing positive receipt makes the launcher stop the
native background job rather than report an unnumbered success. Every native CLI inspection and
launch has a bounded wall-clock timeout. Attached native sessions can leave dispatch and stop CLI
wrappers alive after printing an exact owned-job acknowledgment; the launcher accepts only those
specific timeout acknowledgments and still requires canonical receipt, roster, and terminal-state
validation. If concurrent launches prevent unique cleanup targeting,
the launcher never infers ownership from global agent-view changes: if native launch output does not
return its own ID, it reports cleanup as unverified instead of stopping an arbitrary job.

## Verification

```bash
bun run claude:check
claude plugin validate ./integrations/claude-code
```

The focused suite covers roots, native background children, subagents, parent-first ordering,
200/201 idempotent responses, concurrent siblings, missing configuration before fetch, immutable-
parent conflicts, malformed responses, wrong lineage, launcher failures, service outages, supported
hook display output, cleanup verification, and fork deferral.
