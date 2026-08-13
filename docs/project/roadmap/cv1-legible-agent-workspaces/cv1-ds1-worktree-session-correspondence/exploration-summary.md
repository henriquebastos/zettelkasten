# Worktree surface exploration

Pinned runtime versions were Claude Code 2.1.227, Codex 0.147.0, Pi 0.84.1, and Amp
0.0.1786551414-g7b8b6b.

- Claude `WorktreeCreate` fires before `SessionStart`, carries the eventual stable `session_id`,
  original repository cwd, and native worktree description, and requires the hook to return the
  created directory. Any nonzero hook exit aborts creation. Native creation uses the main
  worktree's `.claude/worktrees`, a `worktree-<description>` branch, fetched `origin/main` with
  local `HEAD` fallback, and copies ignored files selected by `.worktreeinclude` without applying
  dirty tracked changes.
- Both inline and installed plugin probes showed that root CLI `--worktree` creation occurs before
  plugin hooks are registered. A plugin `WorktreeCreate` hook therefore applies only to later
  in-session creation such as isolated subagents and background sessions at this pinned version.
- Claude isolated subagents expose the root session ID during `WorktreeCreate`; their separate
  `agent_id` arrives only at `SubagentStart`. One running probe did not emit the documented
  `WorktreeRemove` and left the worktree registered, so removal is not an identity boundary.
- Codex CLI/app-server schema and a live `thread/start` probe expose stable thread ID and cwd but no
  worktree operation or event. Codex desktop independently creates managed worktrees under its
  configured root, associates them with chats, performs handoff/snapshot/restore, and cleans them
  by app policy; none of that is exposed to the pinned plugin or app-server API.
- Pi extensions expose stable session ID and cwd. A live run in an external linked worktree created
  no worktree and emitted no worktree lifecycle event.
- Amp plugins expose stable thread ID and workspace root but no worktree lifecycle API.
- Git's worktree administrative name survived a move but was reused after delete/recreate, so it is
  not a stable native identity.
