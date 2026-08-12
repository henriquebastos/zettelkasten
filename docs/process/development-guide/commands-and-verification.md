# Commands and Verification

## Project Commands

```bash
# locked dependencies and orb harness
bun install --frozen-lockfile
.agents/setup

# complete verification (service and all four integrations)
bun run check

# focused checks
bun run typecheck
bun run test
bun run amp:test
bun run amp:build
bun run claude:check
bun run codex:check
bun run pi:check

# local Worker and portable self-host deployment
bun run dev
bun run deploy

# maintainer deployment only; generates a private config from the project environment
bun run deploy:production:dry-run
bun run deploy:production

# lifecycle and patch hygiene
.agents/resume
git diff --check
```

## Verification

Run `bun run check` and `git diff --check` before handoff. `bun run check` type-checks and tests the
Worker, tests all four harness integrations, and bundles the Amp entrypoint with `@ampcode/plugin`
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

`bun run deploy` deploys a portable self-hosted Worker with Wrangler. `bun run deploy:production`
is reserved for the maintainer deployment. Configure `CLOUDFLARE_ACCOUNT_ID` and
`ZETTELKASTEN_PRODUCTION_DOMAIN` as private Amp Project environment values and
`CLOUDFLARE_API_TOKEN` as an Amp Project secret. The production command validates the committed
template against `wrangler.jsonc`, creates a mode-`0600` ignored config containing only the injected
domain, runs a Wrangler dry-run, deploys with `--strict`, and removes generated files. Wrangler reads
the account ID and API token directly from its restricted subprocess environment; neither enters
the generated config. `SERVICE_ADMIN_TOKEN` and `CAPABILITY_SIGNING_KEY` remain Worker secrets
managed separately in Cloudflare. Namespace capabilities are application credentials and must never
be substituted for deployment or administration credentials. The private Amp Personal Plugins
repository is the source of truth for an installed Amp plugin; validate and deliberately sync public
integration changes there rather than deploying personal configuration from this monorepo.
