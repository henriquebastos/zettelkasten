# Zettelkasten hierarchy service

An authenticated Cloudflare Worker that assigns stable Luhmann-style addresses to externally identified elements. Each namespace is isolated in its own SQLite Durable Object and can be shared by any set of clients.

The service stores hierarchy, not content. Element keys are exact, opaque identifiers supplied by callers, such as `amp:T-...`, `claude-code:...`, `document:...`, or `sha256:...`.

## Invariants

- An element is uniquely identified by its namespace and key.
- Parentage and assigned ordinals are immutable.
- Parents must exist before children.
- Concurrent siblings receive distinct, monotonically increasing ordinals.
- Retries with the same key and parent return the original assignment.
- Ordinals are never recycled; gaps are valid.
- Paths are limited to 64 elements.

## Data API

Create or resolve an element with its namespace capability:

```http
POST /v1/namespaces/{namespaceID}/elements
Authorization: Bearer {namespaceCapability}
Content-Type: application/json
```

```json
{
  "key": "amp:T-019...",
  "parentKey": "claude-code:01J..."
}
```

The response contains both the canonical ordinal path and its `luhmann-v1` rendering:

```json
{
  "key": "amp:T-019...",
  "parentKey": "claude-code:01J...",
  "ordinal": 2,
  "ordinalPath": [3, 1, 1, 2],
  "address": "3a1b"
}
```

Use `POST /v1/namespaces/{namespaceID}/elements/resolve` with `{ "key": "..." }` to retrieve an existing assignment without repeating its parent.

## Namespace lifecycle

Namespace management requires the service administration credential:

```text
POST /v1/admin/namespaces
POST /v1/admin/namespaces/{namespaceID}/imports
POST /v1/admin/namespaces/{namespaceID}/activate
POST /v1/admin/namespaces/{namespaceID}/token:rotate
POST /v1/admin/namespaces/{namespaceID}/disable
POST /v1/admin/recovery/objects/{durableObjectID}/token:rotate
```

New namespaces start in `initializing`. Existing hierarchies can be imported parent-first with explicit ordinals and expected addresses. Import batches are transactional. Activation closes the import path and enables normal allocation; disablement is terminal in v1.

The recovery operation is service-admin-only. It retrieves non-secret namespace metadata from a known Cloudflare Durable Object ID and rotates a lost namespace capability without creating another namespace.

## Development

```sh
bun install --frozen-lockfile
bun run check
bun run dev
```

## Deployment credentials

These credentials have separate responsibilities:

- `CLOUDFLARE_API_TOKEN`: Wrangler deployment access, supplied through the execution environment.
- `SERVICE_ADMIN_TOKEN`: Worker secret for namespace lifecycle operations.
- `CAPABILITY_SIGNING_KEY`: Worker secret used to issue and verify namespace-scoped capabilities.

The Cloudflare deployment token must never be used as an application credential.
