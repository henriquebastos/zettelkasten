# Plan

1. Implement a dedicated Claude `WorktreeCreate` command because its stdout contract is a path,
   unlike the JSON lifecycle hook handler.
2. Allocate using only `claude:<session_id>`, resolving launcher parent provenance first when set.
3. Reproduce the pinned native Git projection: main checkout `.claude/worktrees`,
   `worktree-<native-description>` branch, fetched `origin/main` with local `HEAD` fallback, and
   selected ignored-file copies.
4. Test display formatting, nested invocation, several worktrees per session, parent-first lineage,
   configuration/service failure, path rejection, and collisions.
5. Exercise the exact pinned CLI and update architecture, installation, integration, briefing,
   decision, roadmap, and worklog surfaces with both capabilities and limitations.

Runtime discovery narrowed the implementation to worktrees created after plugin initialization.
Root CLI `--worktree` is explicitly excluded because Claude creates it before registering either
inline or installed plugin hooks.
