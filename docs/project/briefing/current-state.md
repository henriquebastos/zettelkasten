# Current State

The allocation Worker and namespace lifecycle API are implemented and deployed at
`https://zettelkasten.henriquebastos.net` (with the Workers hostname as fallback). The Worker uses
SQLite Durable Objects and has automated type and behavior checks.

The Amp integration is implemented, tested, and bundled from `integrations/amp`. Its deployable
personal configuration lives in a private Amp Personal Plugins repository, not here. This public
copy remains the reusable implementation upstream and must not acquire personal credentials or
configuration.

Claude Code, Codex, and Pi integrations are not implemented. Their directories currently contain
investigation briefs and completion criteria only. The current goal is integration development:
use the pinned local harness CLIs to discover supported stable IDs, ancestry, lifecycle hooks, and
metadata surfaces, then implement service-backed clients that preserve the protocol. Ariad 0.2.1
is vendored as the project's delivery method and the key project documents are adopted.
