# Service-backed Zettelkasten thread numbering

Configure the plugin process with `ZETTELKASTEN_SERVICE_URL`, `ZETTELKASTEN_NAMESPACE_ID`, and
`ZETTELKASTEN_NAMESPACE_CAPABILITY`. The service URL defaults to the public custom hostname; the
namespace values intentionally have no defaults. Missing configuration is safe at import time and
causes a clear error before any allocation request.

## Install

Amp loads TypeScript plugins from `.amp/plugins/*.ts` in a project or
`~/.config/amp/plugins/*.ts` for the current user. This integration has relative modules, so bundle
it into one installable file rather than copying only `index.ts`:

```bash
git clone https://github.com/henriquebastos/zettelkasten.git
cd zettelkasten
bun install --frozen-lockfile
mkdir -p ~/.config/amp/plugins
bun build integrations/amp/index.ts \
  --outfile ~/.config/amp/plugins/zettelkasten-hierarchy.ts \
  --external @ampcode/plugin
```

Start Amp from a trusted environment that injects `ZETTELKASTEN_SERVICE_URL`,
`ZETTELKASTEN_NAMESPACE_ID`, `ZETTELKASTEN_NAMESPACE_CAPABILITY`, and the Amp-required
`AMP_API_KEY`, then run **plugins: reload** or restart Amp. Confirm loading with
`amp plugins list`; never print the environment values.

For an Amp-hosted personal installation shared across the user's Amp environments, use
`amp plugins repositories` to clone the private Personal Plugins repository, build the same single
file into that repository's plugin directory, commit it there, and ask before pushing. The private
repository—not this public upstream—owns the installed plugin source. Credentials remain exclusively
in runtime secret injection and must never be committed, even to a private repository. Rebuild from
a reviewed upstream revision to update the plugin.

This Amp plugin exposes three commands: **Number current thread**, **Create child**, and **Create
root**. All hierarchy assignments come from the remote hierarchy service. There is no local
allocation, collision repair, rebuild, or fallback.

## Automatic lifecycle behavior

A successful `agent.end` waits up to one minute for Amp's semantic title and numbers an unnumbered
thread. `session.start` provides the same behavior for a completed thread whose executor did not run
the plugin. Lifecycle events also trigger a once-per-minute catch-up over the newest archived-inclusive
50-thread API page. Each pass processes at most ten newest records whose listed title or effective
parent changed since a successful process-local reconciliation; empty titles are skipped. The bounded
cache is only a load optimization, never persistent or an allocation authority. Catch-up does not scan full history.

Effective ancestry prefers Amp's structural `parentThreadID` and otherwise uses the first user
message's `meta.fromExecutorThreadID`. Ancestors are assigned parent-first, cycles are rejected, and
the title is compared again before writing. Service-returned root and direct-child lineages are
strictly validated. Parseable prefixes are verified against the service and reconciled to its
canonical address while preserving the semantic title. Repeated events for the same thread share
one in-flight operation.

A leading parseable address token followed by a space is reserved Zettelkasten display metadata,
not semantic title text. When the service returns a different canonical address, reconciliation
replaces that token and preserves only the parsed semantic title.

## Creation

Creation appends the initial prompt before renaming because Amp cannot rename an empty thread. Root
and child addresses are allocated remotely. Before creating a child, the plugin ensures and fetches
the exact effective parent assignment and requires its service address to match its displayed title;
it neither renames a valid parent nor invents an address.

## Adapter boundary

`service.ts` owns the backend contract and `ThreadSummary`. Its adapter can fetch one exact thread,
create a thread, append its initial prompt, and set its title. `amp-adapter.ts` is the only private
integration. It uses:

- `GET /api/threads/:id` for exact thread details;
- one `GET /api/threads?includeArchived=true&includeEmpty=true&limit=50&offset=0` page for catch-up;
- Amp's agent API for creation and `amp threads rename` for title updates.

Private API responses are strictly validated. Requests are serialized process-wide and HTTP 429
responses are retried up to five times using `Retry-After` or exponential backoff. The plugin
requires `AMP_API_KEY` and never logs it. Immediately before each numbering rename attempt, the
adapter re-fetches the exact thread and checks its expected title. Amp's rename command has no CAS,
so a change between that check and the command remains an unavoidable best-effort race.

## Policy

- Remote service assignments are the sole source of numbering and concurrency correctness.
- Unavailable, rejected, conflicting, or malformed service responses leave titles unchanged.
- Explicit and automatic numbering verify and reconcile parseable prefixes against the service and
  effective ancestry.
- No local repair/rebuild commands or full-history snapshots remain.

## Tests

```console
bun test integrations/amp/*.test.ts
bun build integrations/amp/index.ts --outdir /tmp/zettelkasten-build --external @ampcode/plugin
```
