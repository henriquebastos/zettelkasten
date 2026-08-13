---
code: CV1.DS1
level: Delivery Story
status: Done
status_reason: Claude's supported boundary is implemented and all harness boundaries are documented
updated: 2026-08-12
related:
  - ../../../../decisions/records/2026-08-12T2219Z-worktrees-as-session-display-metadata.md
---

# Restore worktree/session correspondence

## Intent

Restore the former one-look relationship between a worktree directory and the session it served
without weakening opaque native identity.

## Scope

Validate Claude Code, Codex, Amp, and Pi worktree surfaces; implement address-description labels at
safe native creation boundaries; preserve native location and Git behavior.

## Acceptance / Done Condition

Given a supported harness creates a managed worktree, when remote session allocation succeeds,
then its directory contains the canonical session address and native creation description, and no
path or description participates in identity or parentage.

## Validation Route

Pinned-runtime probes, focused integration tests, and full repository checks.

## Out of Scope

Reverse engineering closed frontend state or silently renaming active worktrees after creation.
