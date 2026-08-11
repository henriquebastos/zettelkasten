---
date: 2026-08-11T09:45:00Z
author: Amp
kind: milestone
related:
  - docs/project/briefing/current-state.md
verification:
  - bun run check
  - .agents/setup (twice)
  - .agents/resume
  - clean minimal login-shell CLI version check
---

# Ariad-enabled integration development orb

## What changed

The public Zettelkasten monorepo adopted Ariad 0.2.1 from the pinned
`henriquebastos/ariad` fork revision, populated its core project memory, and configured fresh Amp
orbs with pinned Claude Code, Codex, and Pi CLIs under a repository-scoped Node 22.23.2 toolchain.

## Why it matters

The repository is now a reproducible shared development environment for building the three
remaining harness integrations without mixing public implementation with private Amp plugin
configuration or credentials.

## Verification

`bun run check` passed the Worker and Amp integration suites and bundle. Repeated setup converged
in about 1.2 seconds, resume completed in about one second, and a clean login shell resolved the
pinned Node, Claude Code, Codex, Pi, and Ariad versions.

## Follow-up

Investigate each harness's stable identity, ancestry, lifecycle, and metadata APIs before replacing
its integration brief with implementation. Keep all clients service-backed with no local fallback.
