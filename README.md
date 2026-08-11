# Zettelkasten hierarchy

A service-backed numbering system that assigns stable Luhmann-style addresses to threads and other
externally identified elements. This public monorepo keeps the Cloudflare Worker service at its
root and places harness clients under `integrations/`.

## Status

| Component | Status |
| --- | --- |
| Cloudflare Worker allocation service | Implemented |
| Amp User Plugin | Implemented |
| Claude Code | Not implemented; agent brief only |
| Codex | Not implemented; agent brief only |
| Pi | Not implemented; agent brief only |

The service is available at **https://zettelkasten.henriquebastos.net**. The deployment's
`zettelkasten-allocator.<account-subdomain>.workers.dev` address remains the Cloudflare fallback.

## Architecture

The Worker stores hierarchy—not conversation content. Every element has an exact opaque `key` and
an opaque `parentKey` inside a namespace backed by its own SQLite Durable Object. Harnesses use
URI-style keys based on stable native IDs (for example, `amp:T-…`). The service is the sole
allocation authority; clients display returned addresses but do not allocate locally. Sharing one
namespace shares a hierarchy across harnesses; separate namespaces provide isolation.

See [the protocol](docs/protocol.md), [architecture and security boundaries](docs/architecture.md),
and the agent-oriented [installation quickstart](docs/installation.md).

## Service invariants

- An element is uniquely identified by namespace and key.
- Parentage and assigned ordinals are immutable; parents must exist before children.
- Concurrent siblings receive distinct, monotonically increasing ordinals.
- Retrying a key with the same parent returns its original assignment.
- Ordinals are never recycled, gaps are valid, and paths are limited to 64 elements.

## Data API

Create or resolve an element using its namespace capability:

```http
POST /v1/namespaces/{namespaceID}/elements
Authorization: Bearer {namespaceCapability}
Content-Type: application/json

{"key":"amp:T-example","parentKey":null}
```

The `200`/`201` response includes `key`, `parentKey`, `ordinal`, `ordinalPath`, and the rendered
`address`. Use `POST /v1/namespaces/{namespaceID}/elements/resolve` with a key to retrieve an
existing assignment without repeating its parent.

## Namespace lifecycle API

These operations require the separate service administration credential:

```text
POST /v1/admin/namespaces
POST /v1/admin/namespaces/{namespaceID}/imports
POST /v1/admin/namespaces/{namespaceID}/activate
POST /v1/admin/namespaces/{namespaceID}/rename
POST /v1/admin/namespaces/{namespaceID}/token:rotate
POST /v1/admin/namespaces/{namespaceID}/disable
POST /v1/admin/recovery/objects/{durableObjectID}/token:rotate
```

Namespaces begin in `initializing`, where parent-first transactional import is available.
Activation enables normal allocation and closes imports. Renaming changes display metadata only;
disablement is terminal in v1. Recovery rotates a lost namespace capability from a known Durable
Object ID without creating another namespace.

## Development

```sh
bun install --frozen-lockfile
bun run check
bun run dev
```

`bun run check` runs Worker type checking and tests, then Amp integration tests and a bundle with
`@ampcode/plugin` externalized. Deployment uses three credentials with separate boundaries:

- `CLOUDFLARE_API_TOKEN`: Wrangler deployment access only.
- `SERVICE_ADMIN_TOKEN`: Worker secret for namespace lifecycle operations.
- `CAPABILITY_SIGNING_KEY`: Worker secret used to issue and verify namespace capabilities.

Cloudflare deployment credentials are never application credentials. Namespace capabilities and
all of the credentials above must remain out of source control.

## License

[MIT](LICENSE)
