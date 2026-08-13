---
date: 2026-08-12T22:29:00Z
author: Amp
kind: milestone
related:
  - CV1.DS1.US1
  - docs/project/decisions/records/2026-08-12T2219Z-worktrees-as-session-display-metadata.md
verification:
  - bun run check
  - git diff --check
  - Claude Code 2.1.227 native root, inline plugin, installed plugin, isolated-subagent, failure, base-selection, and rename probes
  - Codex 0.147.0 generated app-server schema and live external-worktree thread/start probe
  - Pi 0.84.1 external-worktree extension probe
  - Amp 0.0.1786551414-g7b8b6b plugin API and CLI inspection
---

# Worktree/session correspondence validated

## What changed

Recorded worktrees as non-authoritative session display metadata and added a Claude
`WorktreeCreate` implementation for worktrees created after plugin initialization. Those paths use
the root session's remotely allocated address plus Claude's native description while preserving the
native main-checkout location, branch, base-selection fallback, and included ignored-file behavior.

Documented that root CLI Claude worktrees precede plugin registration, Codex desktop worktree
lifecycle is absent from CLI/app-server, and Amp and Pi expose no native worktree lifecycle. No path,
prompt, title, or description became an allocation key.

## Why it matters

Stale worktrees created during agent work are now recognizable where the harness exposes a safe
creation boundary, without adding worktree identities or weakening service-authoritative hierarchy.
Unsupported host boundaries remain explicit instead of being hidden behind cwd inference or active
path renames.

## Verification

The complete repository check passed. A final running Claude isolated-agent probe registered the
expected `<address>-<native-description>` path on its unchanged
`worktree-<native-description>` branch, with no hook stderr. Inline and installed root startup
controls both created their native unlabeled path before registering plugin hooks. Attempting a
post-create rename made Claude abort startup, ruling out that fallback.

## Follow-up

The Navigator accepted the result for project history. Re-probe when Claude exposes plugin hooks
before root `--worktree` creation or Codex exposes desktop worktree lifecycle through app-server.
