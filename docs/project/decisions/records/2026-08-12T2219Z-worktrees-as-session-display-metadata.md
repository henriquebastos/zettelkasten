---
status: Decided
raised: 2026-08-12
decided: 2026-08-12
deciders:
  - Henrique Bastos
related:
  - CV1.DS1.US1
---

# Treat worktree names as session display metadata

## Question

Should a Git worktree receive its own hierarchy identity, or should its directory name display the
address of the coding-agent session it serves?

## Decision

A worktree is not a hierarchy element. When a supported harness exposes creation early enough, its
managed worktree directory displays `<session-address>-<native-description>`. The opaque native
session ID remains the allocation key. The directory path, address, and description are display
metadata only.

The label is applied once at creation. Later session-title changes do not rename the directory.
Several worktrees may display the same session address, and moving or deleting one cannot change
session identity or hierarchy parentage.

## Rationale

The product need is operational legibility after a session is archived: a person cleaning old
worktrees should be able to relate a directory to the session hierarchy and remember its original
purpose. It does not require another allocated element or durable worktree lifecycle registry.

Git has no stable native worktree UUID. A probe confirmed that Git's administrative worktree name
survives `git worktree move` but can be reused after deletion and recreation. Path, branch, prompt,
and title are likewise unsuitable identity sources. A generated worktree UUID would still need a
mutable association model because worktrees can precede sessions, outlive them, move externally,
and serve several sessions.

## Options Considered

1. **Session-address display metadata — chosen.** Restores cleanup legibility without changing the
   allocation protocol or claiming a worktree lifecycle the harness cannot guarantee.
2. **Worktree hierarchy element.** Rejected because no stable native key exists and immutable
   parentage cannot express worktrees that precede or serve several sessions.
3. **Separate mutable worktree registry.** Rejected as disproportionate; it would add generated
   identities, path reconciliation, association lifecycle, and external-deletion handling for a
   display-only need.

## Consequences

- Integrations must never allocate or resolve an element from a worktree path or description.
- A stale slug is acceptable and must not trigger automatic rename reconciliation.
- Unsupported harness surfaces are documented rather than inferred from cwd.
- Claude Code 2.1.227 can implement the label for worktrees created after plugin initialization at
  `WorktreeCreate`, which exposes the session ID and native description before creation and fails
  closed on hook failure. Root CLI `--worktree` creation precedes plugin hook registration and
  therefore remains native and unlabeled by the plugin.
- Codex desktop manages worktrees privately, but Codex CLI/app-server 0.147.0 exposes no creation,
  association, move, restore, or removal API. The plugin cannot safely relabel app-owned worktrees.
- Amp and Pi can run in externally supplied worktrees but expose no native worktree lifecycle.

## Review Trigger

Revisit when a pinned harness adds a stable worktree ID or supported pre-creation naming/lifecycle
API, or when the product needs durable associations rather than cleanup labels.
