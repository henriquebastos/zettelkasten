import { describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { launchChildThread } from './launcher.ts'
import { saveConfiguration } from './configure.ts'
import {
	RemoteHierarchy,
	formatThreadName,
	handleHook,
	loadLauncherParent,
	loadConfiguration,
	parseAddress,
	reconcileThread,
	storeLauncherParent,
	type Configuration,
	type NativeThread,
	type NativeThreads,
} from './index.ts'

const configuration: Configuration = { serviceURL: 'https://service.test', namespaceID: 'shared', capability: 'secret' }

class FakeNative implements NativeThreads {
	readonly names = new Map<string, string>()
	readonly threads = new Map<string, NativeThread>()
	started: string[] = []
	closed = false

	constructor(rows: Array<[string, string | null, string | null?]>) {
		for (const [id, parentThreadId, forkedFromId = null] of rows) {
			this.threads.set(id, { id, parentThreadId, forkedFromId, name: null })
		}
	}

	async read(id: string): Promise<NativeThread> {
		const thread = this.threads.get(id)
		if (!thread) throw new Error('missing native thread')
		return { ...thread, name: this.names.get(id) ?? thread.name }
	}

	async setName(id: string, name: string): Promise<void> { this.names.set(id, name) }
	async start(_cwd: string): Promise<string> {
		const id = `started-${this.started.length + 1}`
		this.started.push(id)
		this.threads.set(id, { id, parentThreadId: null, forkedFromId: null, name: null })
		return id
	}
	async close(): Promise<void> { this.closed = true }
}

function remoteService() {
	const assignments = new Map<string, { key: string; parentKey: string | null; address: string }>()
	const next = new Map<string, number>()
	const request = (async (input, init) => {
		const path = new URL(String(input)).pathname
		const body = JSON.parse(String(init?.body)) as { key: string; parentKey?: string | null }
		const existing = assignments.get(body.key)
		if (path.endsWith('/resolve')) return existing
			? Response.json(existing)
			: Response.json({ code: 'element_not_found' }, { status: 404 })
		if (existing) {
			return existing.parentKey === (body.parentKey ?? null)
				? Response.json(existing)
				: Response.json({ code: 'parent_conflict' }, { status: 409 })
		}
		const parent = body.parentKey ? assignments.get(body.parentKey) : undefined
		if (body.parentKey && !parent) return Response.json({ code: 'parent_not_found' }, { status: 409 })
		const ordinal = (next.get(body.parentKey ?? 'root') ?? 0) + 1
		next.set(body.parentKey ?? 'root', ordinal)
		const suffix = !body.parentKey || (parent && parseAddress(parent.address).length % 2 === 0)
			? String(ordinal)
			: String.fromCharCode(96 + ordinal)
		const assignment = { key: body.key, parentKey: body.parentKey ?? null, address: `${parent?.address ?? ''}${suffix}` }
		assignments.set(body.key, assignment)
		return Response.json(assignment, { status: 201 })
	}) as typeof fetch
	return { assignments, request }
}

describe('Codex hierarchy integration', () => {
	test.each([['4', [4]], ['4a', [4, 'a']], ['4a1b', [4, 'a', 1, 'b']]])('parses canonical address %s', (value, expected) => {
		expect(parseAddress(value)).toEqual(expected)
	})

	test.each(['', '0', '01', '4A', '4a0', '4-a'])('rejects invalid address %s', (value) => {
		expect(() => parseAddress(value)).toThrow()
	})

	test('preserves semantic names without using them as identity', () => {
		expect(formatThreadName(parseAddress('4'), 'Investigate hooks')).toBe('4 Investigate hooks')
		expect(formatThreadName(parseAddress('4'), '4 Investigate hooks')).toBe('4 Investigate hooks')
		expect(formatThreadName(parseAddress('5'), '4 Investigate hooks')).toBe('5 4 Investigate hooks')
		expect(formatThreadName(parseAddress('5'), '5')).toBe('5')
	})

	test('creates missing nested ancestors parent-first and names the native child', async () => {
		const native = new FakeNative([['root', null], ['child', 'root'], ['grandchild', 'child']])
		const remote = remoteService()
		const output = await handleHook({ hook_event_name: 'SubagentStart', session_id: 'root', agent_id: 'grandchild' }, {}, {
			native, configuration, request: remote.request,
		})
		expect([...remote.assignments.values()].map(({ key, parentKey }) => [key, parentKey])).toEqual([
			['codex:root', null],
			['codex:child', 'codex:root'],
			['codex:grandchild', 'codex:child'],
		])
		expect(native.names.get('grandchild')).toBe('1a1')
		expect(output.systemMessage).toBe('Zettelkasten address: 1a1')
	})

	test('reapplies a canonical native name after a short-lived subagent stops', async () => {
		const native = new FakeNative([['root', null], ['child', 'root']])
		const remote = remoteService()
		const deferred: string[][] = []
		await reconcileThread('root', native, new RemoteHierarchy(configuration, remote.request))
		await reconcileThread('child', native, new RemoteHierarchy(configuration, remote.request))
		const output = await handleHook({ hook_event_name: 'SubagentStop', session_id: 'root', agent_id: 'child' }, {}, {
			native, configuration, request: remote.request,
			deferName: async (id, name) => { deferred.push([id, name]) },
		})
		expect(native.names.get('child')).toBe('1a')
		expect(deferred).toEqual([['child', '1a']])
		expect(output.systemMessage).toContain('1a')
		expect(output.hookSpecificOutput).toBeUndefined()
	})

	test('resume and concurrent retries rely on service idempotency', async () => {
		const native = new FakeNative([['root', null], ['a', 'root'], ['b', 'root']])
		const remote = remoteService()
		const hierarchy = new RemoteHierarchy(configuration, remote.request)
		const root = await reconcileThread('root', native, hierarchy)
		expect((await reconcileThread('root', native, hierarchy)).address).toEqual(root.address)
		const children = await Promise.all(['a', 'b'].map((id) => reconcileThread(id, native, hierarchy)))
		expect(children.map((x) => x.address.join('')).sort()).toEqual(['1a', '1b'])
	})

	test('rejects a multi-segment address for a native root on allocation and resolution', async () => {
		const native = new FakeNative([['root', null]])
		const allocation = (async (input) => new URL(String(input)).pathname.endsWith('/resolve')
			? Response.json({ code: 'element_not_found' }, { status: 404 })
			: Response.json({ key: 'codex:root', parentKey: null, address: '1a' }, { status: 201 })) as typeof fetch
		await expect(reconcileThread('root', native, new RemoteHierarchy(configuration, allocation))).rejects.toThrow('outside the native Codex parent lineage')
		const resolution = (async () => Response.json({ key: 'codex:root', parentKey: null, address: '1a' })) as typeof fetch
		await expect(reconcileThread('root', native, new RemoteHierarchy(configuration, resolution))).rejects.toThrow('outside the native Codex parent lineage')
	})

	test('recovers the same allocation after a truncated successful response', async () => {
		const remote = remoteService()
		let truncated = false
		const request = (async (input, init) => {
			const response = await remote.request(input, init)
			if (!truncated && !new URL(String(input)).pathname.endsWith('/resolve')) {
				truncated = true
				return new Response('{', { status: 201 })
			}
			return response
		}) as typeof fetch
		expect((await new RemoteHierarchy(configuration, request).allocate('root', null)).join('')).toBe('1')
		expect(remote.assignments.size).toBe(1)
	})

	test('recovers the same allocation when an upstream reports 5xx after commit', async () => {
		const remote = remoteService()
		let failed = false
		const request = (async (input, init) => {
			const response = await remote.request(input, init)
			if (!failed && !new URL(String(input)).pathname.endsWith('/resolve')) {
				failed = true
				return Response.json({ code: 'upstream_failure' }, { status: 500 })
			}
			return response
		}) as typeof fetch
		expect((await new RemoteHierarchy(configuration, request).allocate('root', null)).join('')).toBe('1')
		expect(remote.assignments.size).toBe(1)
	})

	test('resolves the same ID when a retried allocation commits but loses its response', async () => {
		const remote = remoteService()
		let allocations = 0
		const request = (async (input, init) => {
			if (new URL(String(input)).pathname.endsWith('/resolve')) return remote.request(input, init)
			allocations += 1
			if (allocations === 1) throw new Error('request absent')
			await remote.request(input, init)
			throw new Error('response lost')
		}) as typeof fetch
		expect((await new RemoteHierarchy(configuration, request).allocate('root', null)).join('')).toBe('1')
		expect(allocations).toBe(2)
		expect(remote.assignments.size).toBe(1)
	})

	test('resumes an independent launcher root from immutable remote provenance', async () => {
		const native = new FakeNative([['parent', null], ['launched-root', null]])
		const remote = remoteService()
		const hierarchy = new RemoteHierarchy(configuration, remote.request)
		await reconcileThread('parent', native, hierarchy)
		await hierarchy.allocate('launched-root', 'parent')
		const resumed = await reconcileThread('launched-root', native, hierarchy, async (id) => id === 'launched-root' ? 'parent' : null)
		expect(resumed.address.join('')).toBe('1a')
	})

	test('rejects remote-only parentage without matching launcher provenance', async () => {
		const native = new FakeNative([['parent', null], ['untrusted-root', null]])
		const remote = remoteService()
		const hierarchy = new RemoteHierarchy(configuration, remote.request)
		await reconcileThread('parent', native, hierarchy)
		await hierarchy.allocate('untrusted-root', 'parent')
		await expect(reconcileThread('untrusted-root', native, hierarchy)).rejects.toThrow('no matching launcher provenance')
	})

	test('rejects remote/native parent conflicts without changing display metadata', async () => {
		const native = new FakeNative([['root', null], ['child', 'root']])
		const remote = remoteService()
		await reconcileThread('root', native, new RemoteHierarchy(configuration, remote.request))
		remote.assignments.set('codex:child', { key: 'codex:child', parentKey: null, address: '2' })
		const output = await handleHook({ hook_event_name: 'SubagentStart', session_id: 'root', agent_id: 'child' }, {}, {
			native, configuration, request: remote.request,
		})
		expect(output.systemMessage).toContain('conflict')
		expect(output.continue).toBeUndefined()
		expect(native.names.has('child')).toBe(false)
	})

	test('checks configuration before native or remote access and fails the root closed', async () => {
		let reads = 0
		let requests = 0
		const output = await handleHook({ hook_event_name: 'SessionStart', session_id: 'root' }, {}, {
			native: { read: async () => { reads += 1; throw new Error() }, setName: async () => {} },
			request: (async () => { requests += 1; return Response.json({}) }) as typeof fetch,
		})
		expect({ reads, requests }).toEqual({ reads: 0, requests: 0 })
		expect(output).toMatchObject({ continue: false, stopReason: expect.stringContaining('incomplete') })
	})

	test('returns blocking root JSON before the host hook timeout when the service hangs', async () => {
		const native = new FakeNative([['root', null]])
		const signal = AbortSignal.timeout(10)
		const request = (async (_input, init) => await new Promise<Response>((_resolve, reject) => {
			init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
		})) as typeof fetch
		const started = Date.now()
		const output = await handleHook({ hook_event_name: 'SessionStart', session_id: 'root' }, {}, { native, configuration, request, signal })
		expect(Date.now() - started).toBeLessThan(500)
		expect(output).toMatchObject({ continue: false, stopReason: expect.stringContaining('unavailable') })
	})

	test('service failure never creates a name or local fallback', async () => {
		const native = new FakeNative([['root', null]])
		const output = await handleHook({ hook_event_name: 'SessionStart', session_id: 'root' }, {}, {
			native, configuration, request: (async () => { throw new Error('offline') }) as typeof fetch,
		})
		expect(output.continue).toBe(false)
		expect(output.systemMessage).toContain('unavailable')
		expect(native.names.size).toBe(0)
	})

	test('stores shared namespace configuration and capability in separate private files', async () => {
		const home = await mkdtemp(resolve(tmpdir(), 'zettelkasten-codex-config-'))
		try {
			await saveConfiguration({ CODEX_HOME: home }, 'https://service.test', 'shared', 'secret')
			const directory = resolve(home, 'zettelkasten')
			expect((await stat(directory)).mode & 0o777).toBe(0o700)
			for (const file of ['config.json', 'capability']) expect((await stat(resolve(directory, file))).mode & 0o777).toBe(0o600)
			expect(await loadConfiguration({ CODEX_HOME: home })).toEqual(configuration)
			expect(await readFile(resolve(directory, 'config.json'), 'utf8')).not.toContain('secret')
			await storeLauncherParent({ CODEX_HOME: home }, 'launched', 'parent')
			expect(await loadLauncherParent({ CODEX_HOME: home }, 'launched')).toBe('parent')
		} finally { await rm(home, { recursive: true, force: true }) }
	})

	test('partial user-local configuration never mixes with environment fallback', async () => {
		const home = await mkdtemp(resolve(tmpdir(), 'zettelkasten-codex-partial-'))
		try {
			await mkdir(resolve(home, 'zettelkasten'))
			await chmod(resolve(home, 'zettelkasten'), 0o700)
			const configPath = resolve(home, 'zettelkasten', 'config.json')
			await Bun.write(configPath, '{"serviceURL":"https://local.test","namespaceID":"local"}\n')
			await chmod(configPath, 0o600)
			expect(await loadConfiguration({
				CODEX_HOME: home,
				ZETTELKASTEN_SERVICE_URL: 'https://environment.test',
				ZETTELKASTEN_NAMESPACE_ID: 'environment',
				ZETTELKASTEN_NAMESPACE_CAPABILITY: 'environment-secret',
			})).toEqual({ serviceURL: 'https://local.test', namespaceID: 'local', capability: '' })
		} finally { await rm(home, { recursive: true, force: true }) }
	})

	test('launcher uses CODEX_THREAD_ID, records provenance, and hands off the opaque ID', async () => {
		const native = new FakeNative([['root', null]])
		const remote = remoteService()
		const runs: string[][] = []
		const receipts: string[][] = []
		const result = await launchChildThread(' investigate ', { CODEX_THREAD_ID: 'root' }, {
			native, configuration, request: remote.request,
			runChild: async (id, prompt) => { runs.push([id, prompt]); return 0 },
			storeParent: async (_environment, id, parent) => { receipts.push([id, parent]) },
			write: () => {},
		})
		expect(result).toEqual({ parentAddress: '1', childAddress: '1a' })
		expect(runs).toEqual([['started-1', 'investigate']])
		expect(remote.assignments.get('codex:started-1')?.parentKey).toBe('codex:root')
		expect(native.names.get('started-1')).toBe('1a')
		expect(receipts).toEqual([['started-1', 'root']])
		expect(native.closed).toBe(true)
	})

	test('launcher recovers a committed allocation after its response is lost without creating another root', async () => {
		const native = new FakeNative([['root', null]])
		const remote = remoteService()
		let lost = false
		const request = (async (input, init) => {
			const body = JSON.parse(String(init?.body)) as { key: string }
			const response = await remote.request(input, init)
			if (!lost && body.key === 'codex:started-1' && !new URL(String(input)).pathname.endsWith('/resolve')) {
				lost = true
				throw new Error('response lost')
			}
			return response
		}) as typeof fetch
		const result = await launchChildThread('task', { CODEX_THREAD_ID: 'root' }, {
			native, configuration, request, runChild: async () => 0,
			storeParent: async () => {}, write: () => {},
		})
		expect(result.childAddress).toBe('1a')
		expect(native.started).toEqual(['started-1'])
	})
})
