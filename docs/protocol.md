# Allocation protocol

An element's identity is the pair `(namespace, key)`. `key` is opaque to the service. `parentKey`
is either `null` for a root or the exact opaque key of an existing element in the same namespace.
Clients create ancestors parent-first. Repeating the same key and parent is idempotent; changing an
existing element's parent conflicts. There is no client-side allocation fallback.

Harnesses form URI-style opaque keys from stable native identifiers: `amp:T-…`,
`claude:<native-run-or-thread-id>`, `codex:<native-thread-id>`, and
`pi:<native-session-id>`. Never derive identity from a title, prompt, path, or mutable metadata.

The service returns an ordinal path and a `luhmann-v1` address. Rendering alternates positive
decimal and spreadsheet-style lowercase letter segments: `[4, 2, 1]` renders as `4b1`. Addresses
are display metadata; opaque keys remain canonical identity.

Clients configured with the same namespace share one hierarchy, including across harnesses, so a
cross-harness parent key is valid once created. Use separate namespaces when users, projects, or
environments require isolation.
