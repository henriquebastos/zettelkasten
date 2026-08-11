# Service-backed Zettelkasten thread numbering

> **Status:** this is the only implemented client integration in this repository.

Configure the plugin process with `ZETTELKASTEN_SERVICE_URL`, `ZETTELKASTEN_NAMESPACE_ID`, and
`ZETTELKASTEN_NAMESPACE_CAPABILITY`. The service URL defaults to the public custom hostname; the
namespace values intentionally have no defaults. Missing configuration is safe at import time and
causes a clear error before any allocation request.

This Amp plugin exposes three commands: **Number current thread**, **Create child**, and **Create
root**. All hierarchy assignments come from the remote hierarchy service. There is no local
allocation, collision repair, rebuild, or fallback.

## Automatic lifecycle behavior

A successful `agent.end` waits up to one minute for Amp's semantic title and numbers an unnumbered
thread. `session.start` provides the same behavior for a completed thread whose executor did not run
the plugin. Lifecycle events also trigger a once-per-minute catch-up over exactly the newest
archived-inclusive 50-thread API page. Catch-up does not scan full history.

Effective ancestry prefers Amp's structural `parentThreadID` and otherwise uses the first user
message's `meta.fromExecutorThreadID`. Ancestors are assigned parent-first, cycles are rejected, and
the title is compared again before writing. Service-returned root and direct-child lineages are
strictly validated. Automatic handling leaves every existing parseable prefix untouched. Repeated
events for the same thread share one in-flight operation.

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
requires `AMP_API_KEY` and never logs it.

## Policy

- Remote service assignments are the sole source of numbering and concurrency correctness.
- Unavailable, rejected, conflicting, or malformed service responses leave titles unchanged.
- Explicit numbering validates existing prefixes against effective ancestry; automatic numbering
  leaves parseable prefixes untouched.
- No local repair/rebuild commands or full-history snapshots remain.

## Tests

```console
bun test integrations/amp/*.test.ts
bun build integrations/amp/index.ts --outdir /tmp/zettelkasten-build --external @ampcode/plugin
```
