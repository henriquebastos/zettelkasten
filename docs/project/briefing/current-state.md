# Current State

The allocation Worker and namespace lifecycle API are implemented and deployed at
`https://zettelkasten.henriquebastos.net` (with the Workers hostname as fallback). The Worker uses
SQLite Durable Objects and has automated type and behavior checks.

The Amp and Claude Code integrations are implemented and tested from `integrations/amp` and
`integrations/claude-code`. Amp's deployable personal configuration lives in a private Amp Personal
Plugins repository, not here. This public repository remains the reusable implementation upstream
and must not acquire personal credentials or configuration.

Claude Code main sessions are hierarchy roots and visible subagents are direct children, using
opaque native IDs. A session-scoped launcher can also create independent native background sessions
as children; they remain visible in Claude agent view and independently resumable. Canonical remote
addresses appear in session titles and live subagent rows. Native forks currently defer allocation
because Claude's supported hooks do not expose the source session ID needed for immutable parentage.
Codex and Pi remain investigation briefs. The next goal is to validate and implement those harnesses
sequentially with the pinned local CLIs. Ariad 0.2.1 is vendored as the project's delivery method and
the key project documents are adopted.
