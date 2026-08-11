# Constraints and Environment

## Architecture Premises

- TypeScript and Bun manage the monorepo; scripts explicitly use repository Node 22.23.2.
- The root Cloudflare Worker is the sole allocation authority. Each namespace maps to an isolated
  SQLite Durable Object storing keys, immutable parentage, ordinals, and non-secret metadata—not
  prompts or conversation content.
- Namespace administration and namespace data access are separate APIs and credentials.
- Integrations are adapters around stable harness IDs and supported title/metadata surfaces. See
  `docs/architecture.md` and `docs/protocol.md` for the service and key contracts.

## Constraints

- Keys and parent keys are exact opaque values. Use `amp:T-…`,
  `claude:<stable-native-run-or-thread-id>`, `codex:<stable-native-thread-id>`, and
  `pi:<stable-native-session-id>`; never derive keys from prompts, paths, titles, or addresses.
- Create ancestors parent-first, rely on remote idempotency, validate returned lineage, and never
  allocate locally. Parentage and ordinals are immutable; gaps are valid.
- Never commit or log `SERVICE_ADMIN_TOKEN`, `CAPABILITY_SIGNING_KEY`, Cloudflare credentials,
  namespace capabilities, harness API keys, or personal configuration. An integration receives
  only its namespace capability, never the service administration credential.
- The public repository and private Amp Personal Plugins repository have different ownership
  boundaries. Do not treat this repository as the installed personal plugin configuration.
- CLI authentication is user-provided at runtime and is never performed by orb setup or stored in
  this repository. Subscription credentials remain local to the dedicated integration orb.

## Environment

Fresh Amp orbs install locked project dependencies, verify the exact vendored Ariad snapshot, and
install user-local Claude Code 2.1.227, Codex 0.147.0, and Pi 0.84.1. A repository-scoped login
shell hook selects repository Node 22.23.2 and `$HOME/.local/bin` only while the shell starts in
this checkout or a descendant. Pi is installed with lifecycle scripts disabled.

The production service is Cloudflare-hosted. Local Worker development needs no application
secrets for ordinary automated checks; deployment and live namespace operations require separately
injected operator credentials. See the development guide for commands and release boundaries.
