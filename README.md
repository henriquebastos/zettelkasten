# Zettelkasten allocator

A small authenticated Cloudflare Worker backed by a SQLite Durable Object. It assigns monotonically increasing sibling ordinals without races across Amp plugin runtimes.

## API

`POST /v1/allocations` with `Authorization: Bearer <token>`:

```json
{
  "threadID": "T-00000000-0000-4000-8000-000000000001",
  "parentThreadID": null
}
```

The immutable Amp thread ID is the idempotency key. A retry with the same parent returns the original ordinal; attempting to move an existing reservation to another parent returns HTTP 409.

## Development

```sh
bun install --frozen-lockfile
bun run check
bun run dev
```

## Deployment

Set `CLOUDFLARE_API_TOKEN` in the execution environment, then deploy and configure the separate runtime credential:

```sh
bun run deploy
bunx wrangler secret put ALLOCATOR_TOKEN
```

The deployment credential must never be used as the allocator's runtime bearer token.
