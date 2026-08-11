---
date: 2026-08-11T20:18:10Z
author: Amp
kind: milestone
related:
  - integrations/claude-code
  - docs/installation.md
verification:
  - bun run check
  - claude plugin validate ./integrations/claude-code --strict
  - claude plugin validate . --strict
  - isolated-home marketplace configuration and credential-storage probe
  - installed marketplace root, subagent, child, attached grandchild, clear, resume, and forced-failure probes
---

# Native Claude namespace configuration and installed lifecycle validation

## What changed

The marketplace plugin now declares required native user configuration for the service URL,
namespace ID, and sensitive namespace capability. Installed hooks use those options as one complete
configuration; checkout development retains the shared process variables as a fallback. Claude
stores the non-secret values in user settings and the sensitive capability in its credential store.

The native launcher no longer sideloads an installed cache copy, which would lose that installed
plugin identity and its configuration. It carries no capability: each child loads the configured
marketplace plugin itself. Attached-session dispatch and stop wrappers are bounded and accepted after
timeout only when they print the exact owned-job acknowledgment and the launcher independently
confirms receipt, lineage, terminal state, and cleanup. Background-child `/clear` ignores stale
one-time launch provenance and allocates the cleared native session as a new root.

## Why it matters

Claude can now select the exact namespace shared with Amp, Codex, and Pi through its supported plugin
configuration surface without putting the namespace capability in project settings, child argv,
inline settings, session environment files, receipts, or caches. The full installed lifecycle works
from both ordinary and attached native sessions while preserving parent-first creation, remote
idempotency, exact native IDs, and no local fallback.

## Verification

An isolated user home proved that Claude persisted the service URL and namespace ID, omitted the
sensitive value from `settings.json`, stored it in a `0600` credential file on this POSIX host, and
installed the copied `0.3.0` marketplace artifact. Real authenticated Claude runs against a local
request-recording service then proved configured root allocation, an Agent-tool subagent, a native
background child visible in `claude agents`, resume without duplicate creation, and an attached
child launching a visible grandchild under its exact opaque native ID. All requests were
authenticated without recording credential values.

The runtime experiments also exposed and fixed three installed-only edges: sideloading the cache
copy dropped plugin options, attached CLI wrappers remained alive after exact dispatch/stop
acknowledgments, and `/clear` in a background child retained stale initial parent provenance. The
final `/clear` run allocated a new root and applied its canonical title on the first prompt. A forced
child-allocation failure left the exact native job terminal with no startup receipt.

## Follow-up

Publish only after reviewing the three local commits and confirming the push. Codex and Pi remain
separate sequential integration work. Native Claude forks still defer because supported hooks do not
provide their source session ID.
