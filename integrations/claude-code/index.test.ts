import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import {
	RemoteHierarchyAllocator,
	assignmentFileName,
	configureLauncher,
	displayCacheDirectory,
	formatSessionTitle,
	handleHook,
	parseAddress,
	type HookInput,
} from './index.ts'

const environment = {
	ZETTELKASTEN_SERVICE_URL: 'https://service.test',
	ZETTELKASTEN_NAMESPACE_ID: 'ns_test',
	ZETTELKASTEN_NAMESPACE_CAPABILITY: 'secret',
	HOME: '/home/test',
	CLAUDE_ENV_FILE: '/session-env',
}

function response(status: number, body: unknown): typeof fetch {
	return (async () => Response.json(body, { status })) as typeof fetch
}

function session(overrides: Partial<HookInput> = {}): HookInput {
	return {
		hook_event_name: 'SessionStart',
		session_id: 'session-root',
		source: 'startup',
		...overrides,
	} as HookInput
}

describe('Claude address handling', () => {
	test.each([
		['4', [4]],
		['4a', [4, 'a']],
		['4a1', [4, 'a', 1]],
		['4z27aa', [4, 'z', 27, 'aa']],
	])('accepts canonical address %s', (value, expected) => {
		expect(parseAddress(value)).toEqual(expected)
	})

	test.each(['', '0', '01', '4A', '4a0', '4-a', '4a01'])('rejects non-canonical address %s', (value) => {
		expect(() => parseAddress(value)).toThrow()
	})

	test('preserves semantic titles and only normalizes the same canonical prefix', () => {
		expect(formatSessionTitle(parseAddress('9'), '4 Existing title')).toBe('9 4 Existing title')
		expect(formatSessionTitle(parseAddress('9'), '2026 Roadmap')).toBe('9 2026 Roadmap')
		expect(formatSessionTitle(parseAddress('9'), 'Semantic title')).toBe('9 Semantic title')
		expect(formatSessionTitle(parseAddress('9'), '9')).toBe('9')
	})

	test('uses the standard user cache without depending on the plugin installation path', () => {
		expect(displayCacheDirectory({ HOME: '/home/test' })).toBe('/home/test/.cache/zettelkasten/claude-code')
		expect(displayCacheDirectory({ HOME: '/home/test', XDG_CACHE_HOME: '/cache' })).toBe('/cache/zettelkasten/claude-code')
		expect(displayCacheDirectory({})).toBeUndefined()
	})

	test('configures the current launcher identity and clears launch-only parent provenance', async () => {
		const directory = await mkdtemp(resolve(tmpdir(), 'zettelkasten-claude-env-'))
		try {
			const environmentFile = resolve(directory, 'environment.sh')
			await configureLauncher(environmentFile, "session'id", "/plugin's/launcher.ts")
			expect(await readFile(environmentFile, 'utf8')).toBe(
				"export ZETTELKASTEN_CLAUDE_SESSION_ID='session'\\''id'\n"
				+ "export ZETTELKASTEN_CLAUDE_LAUNCHER='/plugin'\\''s/launcher.ts'\n"
				+ 'unset ZETTELKASTEN_CLAUDE_PARENT_SESSION_ID\n',
			)
		} finally {
			await rm(directory, { recursive: true, force: true })
		}
	})

	test('the configured status command renders only canonical cached assignments', async () => {
		const directory = await mkdtemp(resolve(tmpdir(), 'zettelkasten-claude-status-'))
		try {
			const cache = resolve(directory, 'cache', 'zettelkasten', 'claude-code', 'assignments')
			await mkdir(cache, { recursive: true })
			await writeFile(resolve(cache, assignmentFileName('valid')), '4a\n')
			await writeFile(resolve(cache, assignmentFileName('invalid')), '04a\n')
			await writeFile(resolve(cache, assignmentFileName('oversized-decimal')), '9007199254740992\n')
			await writeFile(resolve(cache, assignmentFileName('oversized-letters')), '4zzzzzzzzzzzz\n')
			const settings = await Bun.file(resolve(import.meta.dir, 'settings.json')).json() as {
				subagentStatusLine: { command: string }
			}
			const process = Bun.spawn(['sh', '-c', settings.subagentStatusLine.command], {
				env: { ...globalThis.process.env, HOME: directory, XDG_CACHE_HOME: resolve(directory, 'cache') },
				stdin: 'pipe',
				stdout: 'pipe',
				stderr: 'pipe',
			})
			process.stdin.write(JSON.stringify({ tasks: [
				{ id: 'valid', label: 'Explore · inspect hooks' },
				{ id: 'invalid', label: 'Invalid' },
				{ id: 'oversized-decimal', label: 'Invalid' },
				{ id: 'oversized-letters', label: 'Invalid' },
				{ id: 'missing', label: 'Missing' },
			] }))
			process.stdin.end()
			expect(await process.exited).toBe(0)
			expect(await new Response(process.stdout).text()).toBe(`${JSON.stringify({
				id: 'valid', content: '4a Explore · inspect hooks',
			})}\n`)
			expect(await new Response(process.stderr).text()).toBe('')
		} finally {
			await rm(directory, { recursive: true, force: true })
		}
	})
})

describe('remote Claude hierarchy allocation', () => {
	test('rejects incomplete configuration before making a request', async () => {
		let calls = 0
		const allocator = new RemoteHierarchyAllocator('https://service.test', '', '', (async () => {
			calls += 1
			return Response.json({})
		}) as typeof fetch)
		await expect(allocator.allocate('session', null)).rejects.toThrow('configuration is incomplete')
		expect(calls).toBe(0)
	})

	test.each([200, 201])('accepts HTTP %s for the exact assignment', async (status) => {
		const allocator = new RemoteHierarchyAllocator('https://service.test', 'ns', 'secret', response(status, {
			key: 'claude:child',
			parentKey: 'claude:parent',
			address: '4a',
		}))
		expect(await allocator.allocate('child', 'parent')).toEqual([4, 'a'])
	})

	test('resolves an existing exact assignment without creating it', async () => {
		let requestedURL = ''
		let requestedBody = ''
		const allocator = new RemoteHierarchyAllocator('https://service.test', 'ns', 'secret', (async (input, init) => {
			requestedURL = String(input)
			requestedBody = String(init?.body)
			return Response.json({ key: 'claude:parent', parentKey: null, address: '4' })
		}) as typeof fetch)
		expect(await allocator.resolve('parent', null)).toEqual([4])
		expect(requestedURL).toBe('https://service.test/v1/namespaces/ns/elements/resolve')
		expect(JSON.parse(requestedBody)).toEqual({ key: 'claude:parent' })
	})

	test('rejects conflicts, malformed assignments, and invalid addresses', async () => {
		const conflict = new RemoteHierarchyAllocator('https://service.test', 'ns', 'secret', response(409, { code: 'parent_conflict' }))
		await expect(conflict.allocate('child', 'parent')).rejects.toMatchObject({ status: 409, code: 'parent_conflict' })

		const wrongKey = new RemoteHierarchyAllocator('https://service.test', 'ns', 'secret', response(201, {
			key: 'claude:other', parentKey: 'claude:parent', address: '4a',
		}))
		await expect(wrongKey.allocate('child', 'parent')).rejects.toThrow('conflicting assignment')

		const invalidAddress = new RemoteHierarchyAllocator('https://service.test', 'ns', 'secret', response(201, {
			key: 'claude:child', parentKey: 'claude:parent', address: '04a',
		}))
		await expect(invalidAddress.allocate('child', 'parent')).rejects.toThrow('invalid address')
	})
})

describe('Claude lifecycle hooks', () => {
	test('numbers a root and sets its canonical title', async () => {
		const calls: string[] = []
		const configured: string[][] = []
		const output = await handleHook(session({ session_title: 'Old title' }), environment, {
			request: (async (input, init) => {
				const path = new URL(String(input)).pathname
				calls.push(path)
				return path.endsWith('/resolve')
					? Response.json({ code: 'element_not_found' }, { status: 404 })
					: Response.json({ ...JSON.parse(String(init?.body)), address: '4' }, { status: 201 })
			}) as typeof fetch,
			configureLauncher: async (...values) => { configured.push(values) },
		})
		expect(calls).toEqual([
			'/v1/namespaces/ns_test/elements/resolve',
			'/v1/namespaces/ns_test/elements',
		])
		expect(configured).toHaveLength(1)
		expect(configured[0]?.slice(0, 2)).toEqual(['/session-env', 'session-root'])
		expect(configured[0]?.[2]).toEndWith('/integrations/claude-code/launcher.ts')
		expect(output?.hookSpecificOutput).toMatchObject({
			hookEventName: 'SessionStart',
			sessionTitle: '4 Old title',
		})
		expect(output?.hookSpecificOutput?.additionalContext).toContain('ZETTELKASTEN_CLAUDE_LAUNCHER')
	})

	test('recognizes a launcher-preallocated full session as a validated child', async () => {
		const calls: string[] = []
		const output = await handleHook(session({ session_id: 'full-child' }), environment, {
			request: (async (_input, init) => {
				const body = JSON.parse(String(init?.body)) as { key: string }
				calls.push(body.key)
				return body.key === 'claude:full-child'
					? Response.json({ key: body.key, parentKey: 'claude:parent', address: '4a' })
					: Response.json({ key: body.key, parentKey: null, address: '4' })
			}) as typeof fetch,
			configureLauncher: async () => {},
		})
		expect(calls).toEqual(['claude:full-child', 'claude:parent'])
		expect(output?.hookSpecificOutput?.sessionTitle).toBe('4a')
	})

	test('allocates Claude’s generated background ID under the launcher parent', async () => {
		const calls: Array<{ path: string; body: Record<string, unknown> }> = []
		const receipts: Array<[string, string, string]> = []
		const signals: AbortSignal[] = []
		const output = await handleHook(session({ session_id: 'generated-child' }), {
			...environment,
			ZETTELKASTEN_CLAUDE_PARENT_SESSION_ID: 'parent',
		}, {
			request: (async (input, init) => {
				if (init?.signal) signals.push(init.signal)
				const path = new URL(String(input)).pathname
				const body = JSON.parse(String(init?.body)) as Record<string, unknown>
				calls.push({ path, body })
				return path.endsWith('/resolve')
					? Response.json({ key: 'claude:parent', parentKey: null, address: '4' })
					: Response.json({ ...body, address: '4a' }, { status: 201 })
			}) as typeof fetch,
			configureLauncher: async () => {},
			storeLaunchReceipt: async (directory, id, address) => { receipts.push([directory, id, address]) },
		})
		expect(calls).toEqual([
			{ path: '/v1/namespaces/ns_test/elements/resolve', body: { key: 'claude:parent' } },
			{
				path: '/v1/namespaces/ns_test/elements',
				body: { key: 'claude:generated-child', parentKey: 'claude:parent' },
			},
		])
		expect(receipts).toEqual([['/home/test/.cache/zettelkasten/claude-code', 'generated-child', '4a']])
		expect(signals).toHaveLength(2)
		expect(signals[0]).toBe(signals[1])
		expect(output?.hookSpecificOutput?.sessionTitle).toBe('4a')
	})

	test('does not recreate a launcher receipt when a background child resumes', async () => {
		let receipts = 0
		const output = await handleHook(session({ session_id: 'generated-child', source: 'resume' }), {
			...environment,
			ZETTELKASTEN_CLAUDE_PARENT_SESSION_ID: 'parent',
		}, {
			request: (async (_input, init) => {
				const body = JSON.parse(String(init?.body)) as { key: string }
				return body.key === 'claude:parent'
					? Response.json({ key: body.key, parentKey: null, address: '4' })
					: Response.json({ key: body.key, parentKey: 'claude:parent', address: '4a' })
			}) as typeof fetch,
			configureLauncher: async () => {},
			storeLaunchReceipt: async () => { receipts += 1 },
		})
		expect(receipts).toBe(0)
		expect(output?.hookSpecificOutput?.sessionTitle).toBe('4a')
	})

	test('stops a launched child turn when hierarchy initialization fails', async () => {
		const output = await handleHook(session({ session_id: 'generated-child' }), {
			...environment,
			ZETTELKASTEN_CLAUDE_PARENT_SESSION_ID: 'missing-parent',
		}, {
			request: response(404, { code: 'element_not_found' }),
		})
		expect(output).toMatchObject({
			continue: false,
			stopReason: expect.stringContaining('rejected resolution'),
		})
		expect(output?.hookSpecificOutput).toBeUndefined()
	})

	test('leaves display metadata unchanged when configuration or service is unavailable', async () => {
		let calls = 0
		const missing = await handleHook(session({ session_title: 'Existing' }), {}, {
			request: (async () => { calls += 1; return Response.json({}) }) as typeof fetch,
		})
		expect(calls).toBe(0)
		expect(missing?.hookSpecificOutput).toBeUndefined()

		const unavailable = await handleHook(session({ session_title: 'Existing' }), environment, {
			request: (async () => { throw new Error('offline') }) as typeof fetch,
		})
		expect(unavailable?.hookSpecificOutput).toBeUndefined()
		expect(unavailable?.systemMessage).toContain('unavailable')
	})

	test('defers forks without requesting an immutable but unknown parent', async () => {
		let calls = 0
		const output = await handleHook(session({ source: 'fork' }), environment, {
			request: (async () => { calls += 1; return Response.json({}) }) as typeof fetch,
		})
		expect(calls).toBe(0)
		expect(output?.systemMessage).toContain('does not expose its source session ID')
		expect(output?.hookSpecificOutput).toBeUndefined()
	})

	test('resolves the existing parent before creating and displaying its subagent', async () => {
		const calls: Array<{ path: string; body: Record<string, unknown> }> = []
		const writes: Array<[string, string, string]> = []
		const request = (async (input, init) => {
			const body = JSON.parse(String(init?.body)) as { key: string; parentKey: string | null }
			const path = new URL(String(input)).pathname
			calls.push({ path, body })
			return path.endsWith('/resolve')
				? Response.json({ key: body.key, parentKey: null, address: '4' })
				: Response.json({ ...body, address: '4a' }, { status: 201 })
		}) as typeof fetch
		const output = await handleHook({
			hook_event_name: 'SubagentStart', session_id: 'parent', agent_id: 'child', agent_type: 'Explore',
		}, environment, {
			request,
			storeAssignment: async (directory, id, address) => { writes.push([directory, id, address]) },
		})
		expect(calls).toEqual([
			{ path: '/v1/namespaces/ns_test/elements/resolve', body: { key: 'claude:parent' } },
			{ path: '/v1/namespaces/ns_test/elements', body: { key: 'claude:child', parentKey: 'claude:parent' } },
		])
		expect(writes).toEqual([['/home/test/.cache/zettelkasten/claude-code', 'child', '4a']])
		expect(output?.systemMessage).toBe('Zettelkasten address: 4a')
		expect(output?.hookSpecificOutput?.additionalContext).toBe('Zettelkasten address: 4a.')
	})

	test('ignores internal agent events without a visible agent type', async () => {
		let calls = 0
		const output = await handleHook({
			hook_event_name: 'SubagentStart', session_id: 'parent', agent_id: 'internal', agent_type: '',
		}, environment, {
			request: (async () => { calls += 1; return Response.json({}) }) as typeof fetch,
		})
		expect(output).toBeUndefined()
		expect(calls).toBe(0)
	})

	test('does not turn a deferred fork into a root when its subagent starts', async () => {
		const calls: string[] = []
		const output = await handleHook({
			hook_event_name: 'SubagentStart', session_id: 'fork-session', agent_id: 'child', agent_type: 'Explore',
		}, environment, {
			request: (async (input) => {
				calls.push(new URL(String(input)).pathname)
				return Response.json({ code: 'element_not_found' }, { status: 404 })
			}) as typeof fetch,
			storeAssignment: async () => { throw new Error('must not write') },
		})
		expect(calls).toEqual(['/v1/namespaces/ns_test/elements/resolve'])
		expect(output?.systemMessage).toContain('rejected resolution')
		expect(output?.hookSpecificOutput).toBeUndefined()
	})

	test('delegates concurrent sibling ordinals to the service', async () => {
		const assignments = new Map<string, { key: string; parentKey: string | null; address: string }>()
		let childOrdinal = 0
		const request = (async (_input, init) => {
			const body = JSON.parse(String(init?.body)) as { key: string; parentKey?: string | null }
			const existing = assignments.get(body.key)
			if (existing) return Response.json(existing, { status: 200 })
			if (new URL(String(_input)).pathname.endsWith('/resolve')) {
				return Response.json({ key: body.key, parentKey: null, address: '4' })
			}
			const address = `4${String.fromCharCode(97 + childOrdinal++)}`
			const assignment = { key: body.key, parentKey: body.parentKey ?? null, address }
			assignments.set(body.key, assignment)
			return Response.json(assignment, { status: 201 })
		}) as typeof fetch
		const outputs = await Promise.all(['first', 'second'].map((agent_id) => handleHook({
			hook_event_name: 'SubagentStart', session_id: 'parent', agent_id, agent_type: 'Explore',
		}, environment, {
			request,
			storeAssignment: async () => {},
		})))
		expect(outputs.map((output) => output?.systemMessage).sort()).toEqual([
			'Zettelkasten address: 4a',
			'Zettelkasten address: 4b',
		])
	})

	test('creates a subagent beneath a background child session', async () => {
		const calls: Array<{ path: string; body: Record<string, unknown> }> = []
		const output = await handleHook({
			hook_event_name: 'SubagentStart', session_id: 'background-child', agent_id: 'agent', agent_type: 'Explore',
		}, environment, {
			request: (async (input, init) => {
				const path = new URL(String(input)).pathname
				const body = JSON.parse(String(init?.body)) as Record<string, unknown>
				calls.push({ path, body })
				if (path.endsWith('/resolve')) {
					return body.key === 'claude:background-child'
						? Response.json({ key: body.key, parentKey: 'claude:root', address: '4a' })
						: Response.json({ key: body.key, parentKey: null, address: '4' })
				}
				return Response.json({ ...body, address: '4a1' }, { status: 201 })
			}) as typeof fetch,
			storeAssignment: async () => {},
		})
		expect(calls).toEqual([
			{ path: '/v1/namespaces/ns_test/elements/resolve', body: { key: 'claude:background-child' } },
			{ path: '/v1/namespaces/ns_test/elements/resolve', body: { key: 'claude:root' } },
			{
				path: '/v1/namespaces/ns_test/elements',
				body: { key: 'claude:agent', parentKey: 'claude:background-child' },
			},
		])
		expect(output?.systemMessage).toBe('Zettelkasten address: 4a1')
	})

	test('withholds display state when returned child lineage is wrong', async () => {
		let writes = 0
		const request = (async (input, init) => {
			const body = JSON.parse(String(init?.body)) as { key: string; parentKey: string | null }
			return new URL(String(input)).pathname.endsWith('/resolve')
				? Response.json({ ...body, parentKey: null, address: '4' })
				: Response.json({ ...body, address: '8a' }, { status: 201 })
		}) as typeof fetch
		const output = await handleHook({
			hook_event_name: 'SubagentStart', session_id: 'parent', agent_id: 'child', agent_type: 'Explore',
		}, environment, {
			request,
			storeAssignment: async () => { writes += 1 },
		})
		expect(writes).toBe(0)
		expect(output?.systemMessage).toContain('outside the parent')
		expect(output?.hookSpecificOutput).toBeUndefined()
	})

	test('withholds subagent metadata when the canonical display cache cannot be written', async () => {
		const request = (async (input, init) => {
			const body = JSON.parse(String(init?.body)) as { key: string; parentKey: string | null }
			return new URL(String(input)).pathname.endsWith('/resolve')
				? Response.json({ ...body, parentKey: null, address: '4' })
				: Response.json({ ...body, address: '4a' }, { status: 201 })
		}) as typeof fetch
		const output = await handleHook({
			hook_event_name: 'SubagentStart', session_id: 'parent', agent_id: 'child', agent_type: 'Explore',
		}, environment, {
			request,
			storeAssignment: async () => { throw new Error('read-only cache') },
		})
		expect(output?.systemMessage).toContain('failed safely')
		expect(output?.hookSpecificOutput).toBeUndefined()
	})
})
