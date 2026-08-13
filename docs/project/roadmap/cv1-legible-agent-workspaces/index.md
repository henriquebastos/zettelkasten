---
code: CV1
level: Value
status: Done
status_reason: supported worktree labels and explicit harness boundaries are validated and recorded
updated: 2026-08-12
related:
  - ../../decisions/records/2026-08-12T2219Z-worktrees-as-session-display-metadata.md
---

# Legible agent workspaces

## Intent

Make durable coding-agent workspace artifacts understandable after their live sessions disappear.

## Scope

Worktree labels and lifecycle boundaries supported by the pinned harness versions.

## Acceptance / Done Condition

Managed worktrees identify their serving hierarchy address where the harness exposes a safe
creation boundary, while unsupported surfaces and stale-label behavior remain explicit.

## Validation Route

Exercise the pinned harness and inspect Git's registered worktree path and branch.

## Out of Scope

Using worktree paths as identity or maintaining a mutable cross-harness worktree registry.
