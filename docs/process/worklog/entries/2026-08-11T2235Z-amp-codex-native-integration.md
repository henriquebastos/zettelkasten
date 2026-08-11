---
date: 2026-08-11T22:35:00Z
author: Amp
kind: milestone
related:
  - docs/project/briefing/current-state.md
  - integrations/codex/README.md
verification:
  - bun run codex:check
  - installed Codex 0.147.0 marketplace, hook, app-server, nested-subagent, launcher, resume, and outage probes
  - bun run check
  - git diff --check
---

# Native Codex hierarchy integration

## What changed

Implemented the Codex plugin, lifecycle hook, app-server adapter, remote reconciler, private
namespace configuration, independent-root launcher, marketplace metadata, tests, and installation
documentation. Codex keys remain opaque `codex:<native-thread-id>` values. Native subagent and fork
parentage comes from `thread/read`; independent launcher roots retain the immutable parent assigned
by the trusted launcher because Codex stores no native parent for them.

## Why it matters

Codex can now share one remotely authoritative hierarchy with Amp and Claude Code without model-ID
propagation, transcript parsing, title identity, or local allocation. Missing ancestors are created
parent-first, retries and sibling concurrency remain service-owned, and incomplete configuration or
service failure stops a root before model work without writing a misleading title.

## Verification

Official documentation was treated as a hypothesis and checked against Codex CLI 0.147.0. Runtime
probes established stable root/resume identity, exact nested `parentThreadId` values, synchronous
`thread/read` availability during hooks, fork provenance, thread-name visibility, and opaque-ID CLI
resume. Installed marketplace runs produced and independently read the `2 → 2a → 2a1` nested chain.
The independent launcher produced a separately resumable child under its root and completed its
first turn. A stopped mock service caused the installed root hook to end the turn before model output
and left the native name unchanged.

Experiments also rejected three unsafe assumptions: nested hook `session_id` is the root rather than
the immediate parent; name-based resume can silently create another root; and a launcher inside the
tool sandbox cannot write Codex history. The implementation therefore uses app-server lineage,
opaque-ID handoff, and explicit elevation for the exact launcher command.

Adversarial installed-plugin testing found and fixed a short-lived nested-subagent naming race with
a delayed, silent post-`SubagentStop` verifier. Its opaque native ID is sent over stdin rather than
argv; three deterministic final-write races were repaired in 901–912 ms. Testing also disproved a
stronger fail-closed assumption:
Codex 0.147.0 runs the child model after `SubagentStart` blocking JSON, `continue: false`, exit 2,
generic hook failure, and timeout. Roots still stop before model work. Failed native subagent
reconciliation is warning-only, creates no title or local assignment, and requires an external
availability boundary where unnumbered child execution is unacceptable.

Codex exposes no plugin credential-store API in this version. The user-only capability file avoids
Git, argv, prompts, logs, artifacts, and Codex TOML, but same-user Codex shell tools can read it. A
dedicated least-privilege Codex namespace is therefore recommended for untrusted workloads.

## Follow-up

Pi remains the next sequential integration. Codex's optional app-server daemon could remove the
launcher elevation requirement, but the pinned npm installation cannot run that standalone-only
daemon, so it is not a dependency.
