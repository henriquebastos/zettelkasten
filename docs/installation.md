# Agent installation guide

Do not paste secrets into prompts, source files, commits, or logs. Perform these steps using secret
stores or environment injection available to the deployment and harness.

1. Deploy the root Worker with Wrangler. Provide `CLOUDFLARE_API_TOKEN` only to Wrangler and set
   `SERVICE_ADMIN_TOKEN` and `CAPABILITY_SIGNING_KEY` as Worker secrets. The public endpoint is
   `https://zettelkasten.henriquebastos.net`; the deployment's `workers.dev` hostname is a fallback.
2. With the service admin credential, call `POST /v1/admin/namespaces`, retain the returned
   namespace ID and capability in a secret manager, optionally import an existing hierarchy
   parent-first, then call `POST /v1/admin/namespaces/{namespaceID}/activate`. Never give an
   integration the service admin credential.
3. For Amp, copy `integrations/amp` into a **private personal User Plugins repository**. That private
   repository remains the installed configuration's source of truth; pull public implementation
   updates into it rather than committing personal configuration here. Inject
   `ZETTELKASTEN_SERVICE_URL`, `ZETTELKASTEN_NAMESPACE_ID`,
   `ZETTELKASTEN_NAMESPACE_CAPABILITY`, and the Amp-required `AMP_API_KEY` into the Amp process.
   Run the plugin tests and bundle command documented in its README before enabling it.
4. Install and configure the Claude Code plugin as described below. Codex and Pi are not yet
   implemented; their directories remain investigation briefs.

Configure multiple harnesses with the same namespace to share a hierarchy. Provision different
namespaces and capabilities when isolation is required.

## Install in Claude Code

The plugin supports Claude Code 2.1.227 running with Node 22.23.2 on `PATH` in a POSIX environment
such as Linux or macOS. It works in the Claude Code CLI and in local Claude Code frontends that load
Claude Code plugins, execute lifecycle hooks, and provide the same POSIX environment. Native Windows
and PowerShell are not currently supported. The plugin does not run inside the Claude web chat,
which has no access to local plugin hooks or the required process environment.

### Install from GitHub

For an installation available in every project, add this repository as a marketplace and install
the plugin at user scope:

```bash
claude plugin marketplace add https://github.com/henriquebastos/zettelkasten.git --scope user
claude plugin install zettelkasten-hierarchy@zettelkasten --scope user
```

The same operations are available in an interactive Claude Code frontend:

```text
/plugin marketplace add https://github.com/henriquebastos/zettelkasten.git
/plugin install zettelkasten-hierarchy@zettelkasten
```

Choose **User** scope in the installation view so the same native hierarchy integration is active
across projects. Use `--scope local` or choose **Local** only when the plugin should apply to the
current checkout and user. Project scope writes shared Claude settings into the current repository;
review and commit that configuration only when the whole project should require this marketplace.

### Configure the local process

Obtain a namespace ID and namespace capability through a private channel. Inject them only into the
process that starts Claude Code. For example, a POSIX shell can read the capability without placing
its value in shell history:

```bash
export ZETTELKASTEN_SERVICE_URL='https://zettelkasten.henriquebastos.net'
export ZETTELKASTEN_NAMESPACE_ID='ns_...'
read -rsp 'Namespace capability: ' ZETTELKASTEN_NAMESPACE_CAPABILITY && echo
export ZETTELKASTEN_NAMESPACE_CAPABILITY
claude
unset ZETTELKASTEN_NAMESPACE_CAPABILITY
```

For a graphical local frontend, configure its launcher or operating-system environment with the
same three variables before starting the application. Do not place the namespace capability in a
repository, `.claude/settings.json`, shell history, logs, or prompts. The plugin needs only the
namespace capability; never provide a service admin token, capability-signing key, Cloudflare token,
or Claude credential.

Native background children inherit the launching Claude process environment, not only the three
Zettelkasten variables. Start Claude from a least-privileged environment and do not expose unrelated
deployment, administration, or signing credentials to that process.

Restart Claude Code after installation if the frontend does not offer `/reload-plugins`. Confirm
the installation without printing configuration values:

```bash
claude plugin list
claude plugin details zettelkasten-hierarchy@zettelkasten
```

Inside an interactive session, `/plugin` should show `zettelkasten-hierarchy` enabled and `/hooks`
should show its `SessionStart`, `UserPromptSubmit`, and `SubagentStart` hooks. `UserPromptSubmit`
performs only the one-shot canonical retitle after `/clear` and otherwise returns no output. A
configured session receives its canonical address in the title. It can create an independent, native
child session with the launcher command provided in its initial context; that child remains visible
through `claude agents`.

### Update or uninstall

```bash
claude plugin marketplace update zettelkasten
claude plugin update zettelkasten-hierarchy@zettelkasten
claude plugin uninstall zettelkasten-hierarchy@zettelkasten
```

Marketplace installation copies the plugin into Claude's local cache. Do not edit that cache;
update the marketplace instead. Plugin version `0.2.0` is pinned by its manifest, so published
changes must increment that version before existing installations can update.

### Develop from a checkout

To exercise uncommitted plugin code without changing an installed copy:

```bash
claude --plugin-dir ./integrations/claude-code
```

This development flag is temporary for that Claude process. Persistent installations should use
the marketplace commands above.
