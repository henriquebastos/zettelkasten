# Commands and Verification

## Project Commands

```bash
# locked dependencies and orb harness
bun install --frozen-lockfile
.agents/setup

# complete verification (service and Amp integration)
bun run check

# focused checks
bun run typecheck
bun run test
bun run amp:test
bun run amp:build

# local Worker and production deployment
bun run dev
bun run deploy

# lifecycle and patch hygiene
.agents/resume
git diff --check
```

## Verification

Run `bun run check` and `git diff --check` before handoff. `bun run check` type-checks and tests the
Worker, tests the Amp integration, and bundles the Amp entrypoint with `@ampcode/plugin`
externalized. For integration changes, also run the focused harness tests and demonstrate the
native lifecycle behavior using non-production namespace credentials; pass means stable native
keys, exact ancestry, canonical returned addresses, idempotent retries, and unchanged metadata on
failure. Never include credentials in command output or test fixtures.

Orb harness changes additionally require setup twice (each under two minutes), resume under ten
seconds, and a clean minimal login shell check showing repository Node and the pinned `claude`,
`codex`, and `pi` commands. Setup must validate all 53 vendored Ariad files and its package digest
before installing CLIs. Setup links the pinned repository Node into `~/.local/bin` because Amp's
generated shell environment owns the final `PATH`; this intentionally makes Node 22 the default
inside the dedicated project orb. Resume performs no installation. Authenticate subscription CLIs
only at runtime in that persistent orb; never transfer credential files through the repository,
logs, or artifacts.

`bun run deploy` deploys the Worker with Wrangler. Deployment requires an injected
`CLOUDFLARE_API_TOKEN`; `SERVICE_ADMIN_TOKEN` and `CAPABILITY_SIGNING_KEY` are Worker secrets and
must be managed separately. Namespace capabilities are application credentials and must never be
substituted for deployment or administration credentials. The private Amp Personal Plugins
repository is the source of truth for an installed Amp plugin; validate and deliberately sync
public integration changes there rather than deploying personal configuration from this monorepo.
