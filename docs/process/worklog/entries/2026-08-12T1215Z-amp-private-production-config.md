---
date: 2026-08-12T12:15:00Z
author: Amp
kind: milestone
related:
  - wrangler.production.template.jsonc
  - scripts/deploy-production.ts
verification:
  - bun run production:check
  - generated production config Wrangler dry-run
  - bun run check
  - git diff --check
---

# Private production configuration materialization

## What changed

Replaced the concrete production Wrangler configuration with a synchronized template containing one
domain placeholder and no account identifier. The production command now requires account ID, API
token, and domain from the private Amp Project environment, materializes a mode-`0600` ignored
configuration, validates it through a Wrangler dry-run, deploys with strict remote-change checking,
and removes generated files.

## Why it matters

The repository retains a reviewable production topology and a portable public Worker configuration
without publishing maintainer deployment metadata. Wrangler receives the account ID and token only
through a restricted subprocess environment; unrelated Amp Project values are excluded.

## Verification

Focused tests cover exact template synchronization, placeholder replacement, malformed values,
embedded identifiers, template drift, required environment values, and environment allowlisting. A
materialized example passed Wrangler's deployment dry-run without persisting generated state.

## Follow-up

Configure the three production values in the Amp Project before an authorized deployment. No
deployment was performed during this change.
