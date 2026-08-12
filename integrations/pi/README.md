# Pi integration

This Pi 0.84.1 package assigns canonical remote addresses to persistent roots, resumes, native
forks, and foreground child sessions. It uses Pi's stable session UUID as the opaque
`pi:<native-session-id>` key and the session header's exact `parentSession` path only to open the
parent header and read its opaque UUID. Paths, names, prompts, and addresses never become identity.

The integration supports Pi on POSIX platforms. Native Windows is rejected because Node cannot
provide the Unix credential modes and no-follow session-file guarantees used here; use Pi in WSL,
Linux, or macOS.

The extension recursively reconciles ancestors parent-first, relies on remote idempotency, validates
exact returned parentage and address shape, and never writes a local assignment. After successful
validation it stores the canonical address in Pi's persistent session-name surface.

Install with `pi install git:github.com/henriquebastos/zettelkasten`, confirm with `pi list`, and
restart Pi. Run the installed checkout's `integrations/pi/configure.ts` from a trusted terminal; see
the repository installation guide for exact Git and local-checkout paths.

## Native behavior

Pi has no built-in background subagent hierarchy. The package instead registers:

```text
/zk-child <task>
```

This uses Pi's supported `ctx.newSession({ parentSession })` API. The current TUI moves into a fresh
persistent child, its replacement extension initializes first, and then the task starts. The parent
remains visible and independently resumable. Running the command again creates an exact grandchild.
It is a foreground navigation operation, not concurrent background execution.

Ephemeral `--no-session` runs are intentionally blocked because they cannot retain native parentage
or remain resumable. Native `/fork`, `/clone`, and `--fork` sessions retain Pi's exact parent header
and reconcile through the same lifecycle.

Pi awaits `session_start` handlers but handler errors otherwise fail open. The integration catches
initialization errors and uses the documented `input: { action: "handled" }` gate. Runtime tests in
print and JSON modes confirmed that this prevents `before_agent_start`, `agent_start`, and provider
work while leaving the native session record unnumbered and unnamed. It also cancels Pi's compaction
and summarized-tree provider paths while failed. Pi offers no universal provider veto, so direct
provider calls by another installed extension remain outside this boundary; handled noninteractive
input may exit with status zero.

## Configuration security boundary

The configure script writes non-secret service/namespace settings to
`$PI_CODING_AGENT_DIR/zettelkasten/config.json` and the namespace capability separately to
`$PI_CODING_AGENT_DIR/zettelkasten/capability`. Without `PI_CODING_AGENT_DIR`, it uses
`~/.pi/agent/zettelkasten`. The directory is mode `0700`; both files are mode `0600`.

Pi 0.84.1 exposes no generic extension credential vault. These permissions protect against other OS
users and accidental disclosure, not Pi tools running as the same user. Prefer a dedicated
least-privilege Pi namespace for untrusted workloads. Never provide an admin, signing, Cloudflare,
model-provider, or other harness credential.

For checkout development only, the three `ZETTELKASTEN_*` environment variables are an atomic
fallback. Persistent installations should use the user-local files.

Pi parent provenance is a user-owned session file, not a cryptographic statement. On supported
POSIX platforms the integration opens it without following symlinks and validates the opened
descriptor, but same-user code can still forge coherent session headers. Multi-file ancestry
traversal is not an atomic snapshot; missing or invalid records fail without re-rooting.
