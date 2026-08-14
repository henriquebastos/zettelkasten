---
date: 2026-08-13T23:59:13Z
author: Amp
kind: milestone
verification:
  - bun test scripts/create-namespace.test.ts
  - bun run check
  - live hosted-service creation, activation, and authenticated missing-element resolution
---

# Safe namespace provisioning

## What changed

Added a maintained namespace provisioner that uses an explicit application user agent, keeps the
service administration token out of argv, stores the issued capability in a mode-`0600` file, and
activates a new empty namespace immediately. Installation guidance now uses the maintained command
instead of an inline Python example.

## Why it matters

Cloudflare rejected Python's default `urllib` signature before requests reached the Worker, which
made a valid operator credential appear incorrect. The maintained path is testable, redacted, and
preserves a newly issued capability if a later activation step fails.

## Verification

Automated tests exercised successful creation and activation, URL normalization, explicit client
identity, private file permissions, rejected administration credentials, activation failure, and
credential-safe diagnostics. A dedicated Claude Code namespace was created and activated against
the hosted service; its capability authorized a non-mutating missing-element resolution while its
private credential file remained mode `0600`.

## Follow-up

The orb-local capability must be transferred to Claude Code through a trusted private terminal or
credential channel, never through Git, chat, logs, artifacts, or project memory.
