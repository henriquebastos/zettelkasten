---
date: 2026-08-12T00:15:00Z
author: Amp
kind: milestone
related:
  - docs/project/briefing/current-state.md
  - integrations/pi/README.md
verification:
  - bun run pi:check
  - installed Pi 0.84.1 package lifecycle, fork, foreground-child, resume, failure, and ambiguity probes
  - bun run check
  - git diff --check
---

# Native Pi hierarchy integration

## What changed

Implemented a Pi package using stable session UUIDs, exact header-based parent provenance,
service-backed parent-first reconciliation, persistent canonical names, private user configuration,
and a `/zk-child` foreground child-session command.

## Why it matters

Pi can share the same remotely authoritative hierarchy as Amp, Claude Code, and Codex without
model-propagated IDs, path-derived identity, transcript parsing, or local numbering. Pi has no
built-in background subagent hierarchy, so the integration uses its supported foreground session
replacement API rather than claiming subprocess nesting as native ancestry.

## Verification

Documentation was validated against Pi CLI 0.84.1. Disposable runtime probes established lifecycle
ordering, stable root/resume identity, exact fork parent headers, persistent names, input-handled
model suppression in print and JSON modes, and the lazy session-file boundary. An installed package
then exercised root, exact-ID/path resume, CLI fork, child and grandchild commands, independent
resume, rename normalization, failures, ephemeral rejection, unsaved-parent rejection, and
ambiguous committed allocation recovery against a faithful mock.

The tests also established limits: `session_start` and `before_agent_start` exceptions fail open;
`input: handled` is the effective ordinary model gate; handled noninteractive commands exit zero;
and Pi provides neither native background agents nor a universal provider veto across arbitrary
co-installed extensions.

## Follow-up

No harness integration remains unimplemented. Future Pi versions should be re-probed before the
supported version is widened because extension lifecycle and session persistence are core contracts.
