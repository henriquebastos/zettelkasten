import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function runProvisioner(serviceURL: string, output: string, token = 'private-admin-token') {
  const process = Bun.spawn([
    'python3',
    'scripts/create-namespace.py',
    '--service-url', serviceURL,
    '--name', 'claude-code',
    '--output', output,
  ], {
    cwd: resolve(import.meta.dir, '..'),
    env: { ...Bun.env, ZETTELKASTEN_SERVICE_ADMIN_TOKEN: token },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

describe('namespace provisioner', () => {
  test('uses an explicit client identity, activates the namespace, and stores credentials privately', async () => {
    const requests: Array<{ path: string, authorization: string | null, userAgent: string | null }> = []
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        requests.push({
          path: url.pathname,
          authorization: request.headers.get('authorization'),
          userAgent: request.headers.get('user-agent'),
        })
        if (url.pathname === '/v1/admin/namespaces') {
          expect(await request.json()).toEqual({ name: 'claude-code' })
          return Response.json({
            namespaceID: 'ns_00000000-0000-4000-8000-000000000000',
            name: 'claude-code',
            state: 'initializing',
            capabilityToken: 'private-namespace-capability',
          }, { status: 201 })
        }
        return Response.json('active')
      },
    })
    const directory = await mkdtemp(resolve(tmpdir(), 'zettelkasten-namespace-'))
    temporaryDirectories.push(directory)
    const output = resolve(directory, 'claude-code.private.json')

    try {
      const result = await runProvisioner(`  ${server.url.origin}/\n`, output)
      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe('')
      expect(result.stdout).not.toContain('private-admin-token')
      expect(result.stdout).not.toContain('private-namespace-capability')
      expect(JSON.parse(await readFile(output, 'utf8'))).toEqual({
        namespaceID: 'ns_00000000-0000-4000-8000-000000000000',
        name: 'claude-code',
        state: 'active',
        capabilityToken: 'private-namespace-capability',
      })
      expect((await stat(output)).mode & 0o777).toBe(0o600)
      expect(requests).toEqual([
        {
          path: '/v1/admin/namespaces',
          authorization: 'Bearer private-admin-token',
          userAgent: 'zettelkasten-namespace-provisioner/1.0',
        },
        {
          path: '/v1/admin/namespaces/ns_00000000-0000-4000-8000-000000000000/activate',
          authorization: 'Bearer private-admin-token',
          userAgent: 'zettelkasten-namespace-provisioner/1.0',
        },
      ])
    } finally {
      server.stop(true)
    }
  })

  test('fails closed without leaving a credential file or exposing the token', async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ code: 'unauthorized' }, { status: 401 }),
    })
    const directory = await mkdtemp(resolve(tmpdir(), 'zettelkasten-namespace-failure-'))
    temporaryDirectories.push(directory)
    const output = resolve(directory, 'claude-code.private.json')

    try {
      const result = await runProvisioner(server.url.origin, output)
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('service admin token was rejected')
      expect(result.stderr).not.toContain('private-admin-token')
      expect(await Bun.file(output).exists()).toBe(false)
    } finally {
      server.stop(true)
    }
  })

  test('retains an initializing capability privately when activation fails', async () => {
    let requestCount = 0
    const server = Bun.serve({
      port: 0,
      fetch() {
        requestCount += 1
        if (requestCount === 1) {
          return Response.json({
            namespaceID: 'ns_00000000-0000-4000-8000-000000000001',
            name: 'claude-code',
            state: 'initializing',
            capabilityToken: 'retained-private-capability',
          }, { status: 201 })
        }
        return Response.json({ code: 'internal_error' }, { status: 500 })
      },
    })
    const directory = await mkdtemp(resolve(tmpdir(), 'zettelkasten-namespace-activation-'))
    temporaryDirectories.push(directory)
    const output = resolve(directory, 'claude-code.private.json')

    try {
      const result = await runProvisioner(server.url.origin, output)
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('service returned HTTP 500')
      expect(result.stderr).not.toContain('retained-private-capability')
      expect(JSON.parse(await readFile(output, 'utf8'))).toEqual({
        namespaceID: 'ns_00000000-0000-4000-8000-000000000001',
        name: 'claude-code',
        state: 'initializing',
        capabilityToken: 'retained-private-capability',
      })
      expect((await stat(output)).mode & 0o777).toBe(0o600)
    } finally {
      server.stop(true)
    }
  })
})
