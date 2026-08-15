import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const temporaryDirectories: string[] = []
const namespaceID = 'ns_00000000-0000-4000-8000-000000000000'
const capability = 'zk1.private-test-capability'

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function fixture() {
  const directory = await mkdtemp(resolve(tmpdir(), 'zettelkasten-claude-install-'))
  temporaryDirectories.push(directory)
  const namespaceFile = resolve(directory, 'claude-code.private.json')
  const claude = resolve(directory, 'claude')
  const calls = resolve(directory, 'calls.jsonl')
  await writeFile(namespaceFile, JSON.stringify({
    namespaceID,
    name: 'claude-code',
    state: 'active',
    capabilityToken: capability,
  }), { mode: 0o600 })
  await writeFile(claude, `#!/bin/sh
printf '%s\\n' "admin-secret=\${ZETTELKASTEN_SERVICE_ADMIN_TOKEN+present}" "$@" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().splitlines()))' >> "$CALLS"
if [ "$1" = "--version" ]; then printf '2.1.227 (Claude Code)\\n'; fi
`, { mode: 0o700 })
  return { directory, namespaceFile, claude, calls }
}

async function runInstaller(serviceURL: string, namespaceFile: string, claude: string, calls: string) {
  const process = Bun.spawn([
    'python3',
    'scripts/install-claude-code.py',
    '--service-url', serviceURL,
    '--namespace-file', namespaceFile,
    '--claude', claude,
    '--marketplace', 'https://example.test/zettelkasten.git',
  ], {
    cwd: resolve(import.meta.dir, '..'),
    env: { ...Bun.env, CALLS: calls, ZETTELKASTEN_SERVICE_ADMIN_TOKEN: 'must-not-reach-claude' },
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

describe('Claude Code installer', () => {
  test('validates without allocation and never passes or prints the capability', async () => {
    const requests: Array<{ path: string, authorization: string | null }> = []
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        requests.push({ path: url.pathname, authorization: request.headers.get('authorization') })
        if (url.pathname === '/health') return Response.json({ ok: true })
        expect(await request.json()).toEqual({ key: expect.stringContaining('claude:installer-readiness:') })
        return Response.json({ code: 'element_not_found' }, { status: 404 })
      },
    })
    const files = await fixture()

    try {
      const result = await runInstaller(server.url.origin, files.namespaceFile, files.claude, files.calls)
      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe('')
      expect(result.stderr).not.toContain(capability)
      expect(result.stdout).not.toContain(capability)
      expect(requests).toHaveLength(2)
      expect(requests[0]).toEqual({ path: '/health', authorization: null })
      expect(requests[1].path).toBe(`/v1/namespaces/${namespaceID}/elements/resolve`)
      expect(requests[1].authorization).toBe(`Bearer ${capability}`)
      const calls = (await readFile(files.calls, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as string[])
      expect(calls).toHaveLength(4)
      expect(JSON.stringify(calls)).not.toContain(capability)
      expect(calls[0]).toEqual(['admin-secret=', '--version'])
      expect(calls.every((call) => call[0] === 'admin-secret=')).toBe(true)
      expect(calls[2]).toContain(`namespace_id=${namespaceID}`)
      expect(calls[2]).toContain(`service_url=${server.url.origin}`)
    } finally {
      server.stop(true)
    }
  })

  test('rejects an exposed credential file before invoking Claude', async () => {
    const files = await fixture()
    await chmod(files.namespaceFile, 0o644)

    const result = await runInstaller('https://example.test', files.namespaceFile, files.claude, files.calls)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('must not be accessible by group or others')
    expect(result.stderr).not.toContain(capability)
    expect(await Bun.file(files.calls).exists()).toBe(false)
  })
})
