# Current Product Principles

## Remote truth over local convenience

The service owns allocation and concurrency correctness. If it is unavailable, conflicting, or
malformed, integrations leave display metadata unchanged rather than fabricate a useful-looking
local result.

## Stable identity over display text

Use exact stable native harness IDs as opaque keys. Addresses, titles, prompts, and paths can
change and therefore cannot identify elements or establish parentage.

## Explicit sharing and isolation

Sharing a namespace intentionally shares one hierarchy across harnesses. Provision distinct
namespaces and capabilities when users, projects, or environments need isolation; do not simulate
isolation in clients.

## Least authority and least data

Store hierarchy, not conversations. Keep deployment credentials, service administration, and
per-namespace capabilities separate. Diagnostics must be useful without exposing secrets.

## Safe retries and visible provenance

Parent-first creation and service idempotency make retries safe. Integrations should display the
canonical returned address while keeping the opaque key and service response as operational truth.

## Public implementation, private installation

Reusable implementation belongs in this public monorepo. Personal Amp configuration and secrets
belong in the private Amp Personal Plugins source of truth; ease of deployment never justifies
copying private state into public history.
