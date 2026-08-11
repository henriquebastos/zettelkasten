# Identity and Purpose

## Purpose

Zettelkasten Hierarchy is a public monorepo for a service-backed numbering system that assigns
stable Luhmann-style addresses to threads and other elements identified by external AI harnesses.
It gives people working across Amp, Claude Code, Codex, and Pi one remotely authoritative
hierarchy without storing conversation content or deriving identity from display text.

## Product Premises

- The Cloudflare Worker, not any client, is the allocation authority.
- Harness-native stable IDs become opaque URI-style keys; titles and rendered addresses are only
  display metadata.
- A shared namespace enables a cross-harness hierarchy, while separate namespaces isolate users,
  projects, or environments.
- Integrations must fail safely when configuration or the service is unavailable. They never
  invent, repair, or persist local allocations.
- This public repository owns the reusable service and integration implementation. A user's
  private Amp Personal Plugins repository owns their installed Amp plugin configuration, secrets,
  and local operational customizations; public changes are deliberately pulled into that private
  source of truth.

## Glossary

- **Element:** a remotely identified item, such as an Amp thread or Pi session.
- **Key:** an exact opaque stable identity scoped to a namespace.
- **Parent key:** the exact key of an already-created parent, or `null` for a root.
- **Namespace:** an isolated hierarchy and capability boundary backed by one Durable Object.
- **Namespace capability:** a secret authorizing data operations for one namespace.
- **Address:** a service-rendered `luhmann-v1` ordinal path used for display, never identity.
- **Harness:** Amp, Claude Code, Codex, or Pi, whose native identity and lifecycle APIs an
  integration adapts.
