import { spawnSync } from 'node:child_process'
import { constants } from 'node:fs'
import { mkdir, open, readFile, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const DOMAIN_PLACEHOLDER = '${ZETTELKASTEN_PRODUCTION_DOMAIN}'

type JsonObject = Record<string, unknown>

interface ProductionEnvironment {
  CLOUDFLARE_ACCOUNT_ID: string
  CLOUDFLARE_API_TOKEN: string
  ZETTELKASTEN_PRODUCTION_DOMAIN: string
}

const WRANGLER_ENVIRONMENT_KEYS = [
  'CI',
  'FORCE_COLOR',
  'HOME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'PATH',
  'TMPDIR',
  'USER',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
] as const

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`)
  }
  return value as JsonObject
}

function parseConfig(text: string, label: string): JsonObject {
  try {
    return object(JSON.parse(text), label)
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} must contain valid JSONC-compatible JSON.`)
    throw error
  }
}

function productionDomain(value: string): string {
  const domain = value.trim()
  if (!domain || domain !== domain.toLowerCase() || domain.includes('/') || domain.includes(':')) {
    throw new Error('ZETTELKASTEN_PRODUCTION_DOMAIN must be one lowercase hostname without a scheme or path.')
  }
  const parsed = new URL(`https://${domain}`)
  if (parsed.hostname !== domain || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('ZETTELKASTEN_PRODUCTION_DOMAIN must be one lowercase hostname without a scheme or path.')
  }
  return domain
}

function comparable(config: JsonObject): string {
  const normalized = structuredClone(config)
  delete normalized.routes
  return JSON.stringify(normalized)
}

export function materializeProductionConfig(
  portable: JsonObject,
  template: JsonObject,
  domainValue: string,
): JsonObject {
  if ('account_id' in portable || 'routes' in portable) {
    throw new Error('Portable Wrangler configuration must not contain production account or route metadata.')
  }
  if ('account_id' in template) {
    throw new Error('Production template must not contain a Cloudflare account ID.')
  }
  if (comparable(portable) !== comparable(template)) {
    throw new Error('Production template has drifted from the portable Wrangler configuration.')
  }

  const routes = template.routes
  if (!Array.isArray(routes) || routes.length !== 1) {
    throw new Error('Production template must declare exactly one custom-domain route.')
  }
  const route = object(routes[0], 'Production route')
  if (route.pattern !== DOMAIN_PLACEHOLDER || route.custom_domain !== true || Object.keys(route).length !== 2) {
    throw new Error('Production template must contain only the approved domain placeholder route.')
  }

  return { ...structuredClone(portable), routes: [{ pattern: productionDomain(domainValue), custom_domain: true }] }
}

export function requireProductionEnvironment(
  environment: NodeJS.ProcessEnv,
): ProductionEnvironment {
  const accountID = environment.CLOUDFLARE_ACCOUNT_ID?.trim() ?? ''
  const apiToken = environment.CLOUDFLARE_API_TOKEN?.trim() ?? ''
  const domain = environment.ZETTELKASTEN_PRODUCTION_DOMAIN?.trim() ?? ''
  if (!/^[0-9a-f]{32}$/.test(accountID)) {
    throw new Error('CLOUDFLARE_ACCOUNT_ID must be supplied by the private deployment environment.')
  }
  if (!apiToken) {
    throw new Error('CLOUDFLARE_API_TOKEN must be supplied by the private deployment environment.')
  }
  productionDomain(domain)
  return {
    CLOUDFLARE_ACCOUNT_ID: accountID,
    CLOUDFLARE_API_TOKEN: apiToken,
    ZETTELKASTEN_PRODUCTION_DOMAIN: domain,
  }
}

export function deploymentEnvironment(
  environment: NodeJS.ProcessEnv,
  required: ProductionEnvironment,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...required }
  for (const key of WRANGLER_ENVIRONMENT_KEYS) {
    if (environment[key] !== undefined) result[key] = environment[key]
  }
  return result
}

function runWrangler(root: string, args: string[], environment: NodeJS.ProcessEnv): void {
  const result = spawnSync(
    resolve(root, 'node_modules/node/bin/node'),
    [resolve(root, 'node_modules/wrangler/bin/wrangler.js'), ...args],
    { cwd: root, env: environment, stdio: 'inherit' },
  )
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Wrangler ${args.includes('--dry-run') ? 'dry-run' : 'deployment'} failed.`)
}

export async function deployProduction(
  root: string,
  environment: NodeJS.ProcessEnv,
  deploy = true,
): Promise<void> {
  const required = requireProductionEnvironment(environment)
  const portable = parseConfig(await readFile(resolve(root, 'wrangler.jsonc'), 'utf8'), 'Portable Wrangler configuration')
  const template = parseConfig(
    await readFile(resolve(root, 'wrangler.production.template.jsonc'), 'utf8'),
    'Production Wrangler template',
  )
  const generated = materializeProductionConfig(portable, template, required.ZETTELKASTEN_PRODUCTION_DOMAIN)
  const suffix = `${process.pid}-${crypto.randomUUID()}`
  const configPath = resolve(root, `wrangler.production.generated.${suffix}.jsonc`)
  const outdir = resolve(root, '.wrangler', 'generated', suffix)

  await mkdir(dirname(outdir), { recursive: true, mode: 0o700 })
  const childEnvironment = deploymentEnvironment(environment, required)
  try {
    const file = await open(configPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
    try {
      await file.writeFile(`${JSON.stringify(generated, null, 2)}\n`)
    } finally {
      await file.close()
    }
    runWrangler(root, ['deploy', '--config', configPath, '--dry-run', '--outdir', outdir], childEnvironment)
    if (deploy) runWrangler(root, ['deploy', '--config', configPath, '--strict'], childEnvironment)
  } finally {
    await Promise.all([
      rm(configPath, { force: true }),
      rm(outdir, { force: true, recursive: true }),
    ])
  }
}

const currentFile = fileURLToPath(import.meta.url)
if (process.argv[1] && resolve(process.argv[1]) === currentFile) {
  const root = resolve(dirname(currentFile), '..')
  const argumentsAfterScript = process.argv.slice(2)
  const dryRunOnly = argumentsAfterScript.length === 1 && argumentsAfterScript[0] === '--dry-run-only'
  if (argumentsAfterScript.length > 0 && !dryRunOnly) {
    process.stderr.write('Usage: deploy-production.ts [--dry-run-only]\n')
    process.exitCode = 1
  } else deployProduction(root, process.env, !dryRunOnly).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Production deployment failed.'}\n`)
    process.exitCode = 1
  })
}
