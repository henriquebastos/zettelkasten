# Current State

The allocation Worker and namespace lifecycle API are implemented and deployed at
`https://zettelkasten.henriquebastos.net` (with the Workers hostname as fallback). The Worker uses
SQLite Durable Objects and has automated type and behavior checks.

The Amp, Claude Code, and Codex integrations are implemented and tested from `integrations/amp`,
`integrations/claude-code`, and `integrations/codex`. Amp's deployable personal configuration lives
in a private Amp Personal Plugins repository, not here. This public repository remains the reusable
implementation upstream and must not acquire personal credentials or configuration.

Claude Code main sessions are hierarchy roots and visible subagents are direct children, using
opaque native IDs. A session-scoped launcher can also create independent native background sessions
as children; they remain visible in Claude agent view and independently resumable. Canonical remote
addresses appear in session titles and live subagent rows. Marketplace installations use Claude's
native user configuration so the namespace ID can be shared explicitly across harnesses while its
capability remains in Claude's local credential store. Native forks currently defer allocation
because Claude's supported hooks do not expose the source session ID needed for immutable parentage.

Codex roots, resumes, forks, and nested subagents use stable native IDs. The plugin reads exact
native parent and fork provenance through app-server, recursively creates missing ancestors
parent-first, and sets native thread names only after remote lineage validation. Its launcher
creates an independent root beneath the current `CODEX_THREAD_ID`; remote immutable parentage is
authoritative because Codex does not store a native parent for independent roots. The launcher
requires explicit execution outside the tool sandbox to write Codex's own history. Configuration is
user-local with a separate user-only capability file and can share the same namespace as Amp and
Claude. Codex 0.147.0 cannot isolate that file from model shell tools running as the same OS user, so
a dedicated least-privilege namespace is preferable for untrusted Codex workloads. Ariad 0.2.1 is
vendored as the project's delivery method and the key project documents are adopted.

Handled Codex root allocation failures are fail-closed before model work; a hook process crash,
forced kill, or host timeout remains a Codex fail-open boundary. Codex 0.147.0 treats `SubagentStart` as an
advisory/context boundary: runtime probes confirmed that all documented and process-level failure
forms still allow the child model to run. Failed subagent reconciliation therefore warns and leaves
the thread unnumbered without inventing a local assignment; deployments requiring strict subagent
blocking need an enforcement boundary outside Codex.

Pi 0.84.1 on POSIX platforms supports persistent roots, resumes, and native forks using stable
session UUIDs and exact parent-session headers. The package recursively creates remote ancestors,
persists canonical session names, and
uses Pi's input-handled contract to stop ordinary model work when initialization fails. `/zk-child`
uses Pi's supported foreground session replacement API to create a separately resumable child with
exact native parentage; Pi has no native background-subagent hierarchy. Ephemeral sessions and
unsaved fresh parents are rejected. Pi's user-only capability file has the same same-UID tool-access
boundary as Codex, and co-installed extensions remain outside the integration's provider gate.
