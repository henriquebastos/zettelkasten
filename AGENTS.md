# Repository guidance

- Keep the Cloudflare Worker service and its configuration at repository root.
- Treat keys and parent keys as opaque; integrations must use stable native harness IDs.
- Never commit admin tokens, namespace capabilities, Cloudflare tokens, or personal configuration.
- Preserve parent-first creation, remote idempotency, and the no-local-fallback rule.
- Run `bun run check` and `git diff --check` before handing off changes.
