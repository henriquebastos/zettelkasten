# Architecture and security boundaries

The Cloudflare Worker at repository root is the authority for namespace lifecycle and allocation.
Each namespace is backed by an isolated SQLite Durable Object. It stores opaque keys, immutable
parent relationships, ordinals, and non-secret namespace metadata—not conversation content.

Service administration credentials may create, import, activate, rename, rotate, disable, and
recover namespaces. They belong only in deployment or operator environments. A namespace
capability authorizes data operations for one namespace and belongs only in each integration's
secret environment. A Cloudflare deployment token deploys code and is never an application
credential. None belong in source control or diagnostics.

New namespaces initialize with imports enabled. Imports are transactional and parent-first.
Activation permanently switches to normal allocation; disablement is terminal in v1. Allocation
is concurrent, monotonic, and idempotent. Integrations obtain stable native IDs from their harness,
send URI-style opaque keys, and add the returned address to harness title/metadata display without
making that display the source of truth.
