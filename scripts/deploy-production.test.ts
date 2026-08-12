import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  deploymentEnvironment,
  materializeProductionConfig,
  requireProductionEnvironment,
} from './deploy-production.ts'

const portable = {
  name: 'zettelkasten-allocator',
  main: 'src/index.ts',
  durable_objects: { bindings: [{ name: 'HIERARCHIES', class_name: 'Hierarchy' }] },
}

const template = {
  ...portable,
  routes: [{ pattern: '${ZETTELKASTEN_PRODUCTION_DOMAIN}', custom_domain: true }],
}

describe('production Wrangler materialization', () => {
  test('injects only the custom domain and never persists deployment credentials', () => {
    const result = materializeProductionConfig(portable, template, 'zk.example.com')

    expect(result).toEqual({
      ...portable,
      routes: [{ pattern: 'zk.example.com', custom_domain: true }],
    })
    expect(JSON.stringify(result)).not.toContain('account_id')
    expect(JSON.stringify(result)).not.toContain('token')
  })

  test('rejects template drift, embedded account IDs, and malformed domains', () => {
    expect(() => materializeProductionConfig(portable, { ...template, main: 'other.ts' }, 'zk.example.com')).toThrow('drifted')
    expect(() => materializeProductionConfig(portable, { ...template, account_id: 'private' }, 'zk.example.com')).toThrow('must not contain')
    expect(() => materializeProductionConfig(portable, template, 'https://zk.example.com/path')).toThrow('hostname')
  })

  test('requires all private deployment environment values without returning extras', () => {
    const expected = {
      CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
      CLOUDFLARE_API_TOKEN: 'private-token',
      ZETTELKASTEN_PRODUCTION_DOMAIN: 'zk.example.com',
    }
    expect(requireProductionEnvironment({ ...expected, UNRELATED: 'ignored' })).toEqual(expected)
    expect(() => requireProductionEnvironment({})).toThrow('CLOUDFLARE_ACCOUNT_ID')
    expect(deploymentEnvironment({ PATH: '/bin', UNRELATED_SECRET: 'excluded' }, expected)).toEqual({
      ...expected,
      PATH: '/bin',
    })
  })

  test('keeps the committed production template synchronized with the portable config', async () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
    const [portableText, templateText] = await Promise.all([
      readFile(resolve(root, 'wrangler.jsonc'), 'utf8'),
      readFile(resolve(root, 'wrangler.production.template.jsonc'), 'utf8'),
    ])

    expect(() => materializeProductionConfig(
      JSON.parse(portableText),
      JSON.parse(templateText),
      'zk.example.com',
    )).not.toThrow()
  })
})
