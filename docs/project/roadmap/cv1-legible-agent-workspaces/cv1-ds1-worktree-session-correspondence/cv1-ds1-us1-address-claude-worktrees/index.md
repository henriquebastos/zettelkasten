---
code: CV1.DS1.US1
level: User Story
status: Done
status_reason: automated and pinned-runtime evidence passed and Navigator accepted the change
updated: 2026-08-12
related:
  - ../../../../../decisions/records/2026-08-12T2219Z-worktrees-as-session-display-metadata.md
---

# Address Claude in-session managed worktrees

## Intent

Make worktrees Claude creates after plugin initialization recognizable during later cleanup.

## Scope

Use `WorktreeCreate` to allocate from Claude's opaque session ID, preserve Claude's native location,
branch convention, origin-main-with-local-HEAD-fallback baseline, and `.worktreeinclude` behavior, and return a directory
named `<address>-<native-description>`.

## Acceptance / Done Condition

Given Claude creates a managed worktree after plugin initialization, when the hierarchy service returns its session address,
then Git registers `.claude/worktrees/<address>-<native-description>` on the native branch, and
configuration, service, lineage, collision, or Git failures abort creation without a local label.

## Validation Route

Run the focused tests and an installed Claude 2.1.227 isolated-subagent probe against a faithful
local allocation service, then inspect `git worktree list --porcelain` and copied files.

## Out of Scope

Root CLI `--worktree` creation, which precedes plugin hook registration; relabeling Codex desktop
state; or assigning separate hierarchy elements to isolated subagent worktrees before Claude
exposes their agent IDs.
