---
date: 2026-08-12T11:58:00Z
author: Amp
kind: milestone
related:
  - docs/project/briefing/current-state.md
  - docs/installation.md
verification:
  - bun run check (169 tests, type checks, Amp bundle)
  - .agents/setup twice and .agents/resume
  - clean minimal login-shell harness version check
  - portable and maintainer Wrangler deploy dry-runs
  - strict Claude plugin and marketplace validation
  - self-contained public Amp installation bundle
  - relative Markdown link and heading-anchor check
  - git diff --check
---

# Public-release coherence pass

## What changed

Prepared the MIT repository for public use by separating hosted use from self-hosting, making the
default Cloudflare deployment portable, isolating the existing maintainer production target,
declaring required Worker secrets, documenting secure namespace bootstrap and all four installation
paths, completing Amp's bundle-based installation route, pinning direct development dependencies,
adding continuous verification, ignoring generated orb state, and correcting stale project status.

The orb harness now prioritizes the pinned user-local CLIs over binaries that a harness updater may
place beside repository Node. This preserves Node 22.23.2 while preventing an updater-created Claude
binary from silently overriding the supported Claude Code 2.1.227 installation.

## Why it matters

A public clone no longer targets Henrique's account or domain by default, public users are not led
to expect hosted namespace registration, and no installation path treats a Git repository as a
credential store. Reproducibility and behavior claims have executable validation routes.

## Verification

The full suite passed 169 tests across the Worker, Amp, Claude Code, Codex, and Pi, with all type
checks and the Amp bundle. Setup converged twice in under two seconds per run, resume completed in
under one second, and a minimal login shell selected the pinned four-tool harness. Both Wrangler
configs bundled successfully in deployment dry-runs; the Claude plugin and marketplace passed
strict native validation; and the documented Amp build produced one self-contained plugin file.
All relative Markdown links and heading anchors resolved, dependency installation remained frozen,
and diff whitespace checks passed.

An independent adversarial review found and closed an unsafe wording ambiguity about Amp credential
ownership and malformed Codex onboarding prose. The release pass did not deploy, authenticate,
publish, change repository visibility, or push.

## Follow-up

Publishing the repository and pushing the local commits remain explicit Navigator actions. A later
refinement replaced the concrete maintainer Wrangler config with a synchronized placeholder template
and generated deployment config, keeping account and domain metadata in the private Amp Project
environment. GitHub Actions currently follows the maintained major tags for its two standard setup
actions rather than pinning action commit SHAs.
