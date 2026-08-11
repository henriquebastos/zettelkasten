---
date: 2026-08-11T14:32:27Z
author: Amp
kind: milestone
related:
  - docs/project/briefing/current-state.md
  - integrations/claude-code/README.md
verification:
  - bun run claude:check
  - claude plugin validate ./integrations/claude-code
  - claude plugin validate .
  - isolated local marketplace installation and plugin inventory
  - installed artifact execution outside the repository package scope
  - installed plugin root and background-child lifecycle with one child hook execution
  - real `/clear` allocation and first-prompt canonical retitle
  - real Claude Code startup, resume, fork, outage, concurrent-subagent, nested-launcher, and cleanup experiments
---

# Claude Code hierarchy integration

## What changed

The Claude Code brief became a service-backed plugin. Main sessions use opaque native session IDs
as roots; visible subagents use opaque native agent IDs as direct children. The plugin creates
parents first, validates canonical returned identity and lineage, sets root titles, and decorates
live native subagent rows from a canonical-address-only display cache. A session-scoped launcher
also creates independent native background sessions as children through Claude's agent-view
supervisor.

## Why it matters

Claude Code now participates in the shared Zettelkasten hierarchy without local allocation or
fallback. The implementation also records an explicit supported boundary: native forks defer
because fork hooks expose the new session ID but not the source session ID required for immutable
parentage.

## Verification

Official lifecycle and plugin documentation was checked against disposable runtime probes before
implementation. Real Claude Code runs proved stable resume identity, fork provenance limits,
stable subagent IDs, parent resolution before child creation, remote retry idempotency, failure-
without-mutation, and two concurrent subagents visibly rendered as distinct canonical siblings.
Launcher experiments additionally proved that `--bg` generates its own session ID, that an inline
opaque-parent setting reaches the child hook, that the actual generated ID is remotely created under
the exact parent, and that the child appears in `claude agents` with its canonical title in the
attached session. The final launcher waits for a canonical startup receipt tied to Claude's full
session ID, confirms direct lineage before reporting success, and stops unconfirmed background jobs.
Runtime probes also proved option-looking tasks remain prompt content, a background child can launch
a grandchild with the expected alternating address depth, and rejected child initialization leaves
no active native job. Cleanup verification uses Claude's observed terminal states because native
agent view intentionally retains completed job history. The focused typecheck, tests, plugin
validator, and diff hygiene passed.

The repository also exposes the plugin through its root Claude marketplace. The installation guide
documents persistent user/local/project installation for CLI and interactive frontends, secure
process-environment configuration, updates, removal, and checkout-based development.

A pre-push adversarial pass added a self-contained Node ESM package boundary for marketplace cache
execution, NodeNext type checking, absolute-only cache roots, private cache-file tests, and `/clear`
retitling through a one-shot first-prompt hook. Real installed-plugin probes confirmed that the cached
artifact executes, an installed root can launch one native child without duplicate lifecycle hooks,
and `/clear` changes the visible canonical root from the old address to the newly allocated one.

## Follow-up

Run full repository verification, then investigate Codex with the same documentation-plus-runtime
method. Pi remains after Codex. Do not deploy or move harness credentials out of the orb.
