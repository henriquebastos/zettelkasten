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
4. Claude Code, Codex, and Pi integrations are not implemented. Their directories contain agent
   briefs and completion criteria, not installable plugins.

Configure multiple harnesses with the same namespace to share a hierarchy. Provision different
namespaces and capabilities when isolation is required.
