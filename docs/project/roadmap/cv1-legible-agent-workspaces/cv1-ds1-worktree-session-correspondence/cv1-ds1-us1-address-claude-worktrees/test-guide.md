# Test guide

## Automated route

```bash
bun run check
git diff --check
```

The focused Claude suite verifies native labels and branches, ignored-file inclusion, tracked-dirty
exclusion, symlink and local-settings exclusion, origin/main and local-HEAD bases, nested creation,
several worktrees per session, parent-first lineage, fail-closed allocation, and collisions.

## Pinned-runtime route

Run Claude Code 2.1.227 with the plugin loaded and a trusted isolated agent declaring
`isolation: worktree`. Use a non-secret faithful allocation service. After the agent starts, inspect:

```bash
git worktree list --porcelain
```

Pass conditions:

- the linked path is `<main-checkout>/.claude/worktrees/<address>-<native-description>`;
- the branch remains `worktree-<native-description>`;
- the address came from the opaque root session ID and remote service;
- hook stderr is empty.

The root `claude --worktree --init-only` control must retain its native unlabeled path, and debug
ordering must show worktree creation before plugin hook registration. That is a documented host
boundary, not a failed label assertion.
