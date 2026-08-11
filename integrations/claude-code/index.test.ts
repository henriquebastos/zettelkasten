import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import {
	RemoteHierarchyAllocator,
	assignmentFileName,
	configureLauncher,
	displayCacheDirectory,
	formatSessionTitle,
	handleHook,
	hierarchyConfiguration,
	parseAddress,
	storeAssignment,
	storeLaunchReceipt,
	storePendingTitle,
	consumePendingTitle,
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
		expect(displayCacheDirectory({ HOME: '/home/test', XDG_CACHE_HOME: 'relative-cache' })).toBe('/home/test/.cache/zettelkasten/claude-code')
		expect(displayCacheDirectory({ HOME: 'relative-home' })).toBeUndefined()
		expect(displayCacheDirectory({})).toBeUndefined()
	})

	test('stores only canonical display values in private cache files', async () => {
		const directory = await mkdtemp(resolve(tmpdir(), 'zettelkasten-claude-cache-'))
		try {
			await storeAssignment(directory, 'opaque-agent-id', '4a')
			await storeLaunchReceipt(directory, 'opaque-session-id', '4b')
			await storePendingTitle(directory, 'cleared-session-id', '5')
			for (const [subdirectory, nativeID, expected] of [
				['assignments', 'opaque-agent-id', '4a\n'],
				['launch-receipts', 'opaque-session-id', '4b\n'],
				['pending-titles', 'cleared-session-id', '5\n'],
			] as const) {
				const parent = resolve(directory, subdirectory)
				const path = resolve(parent, assignmentFileName(nativeID))
				expect((await stat(parent)).mode & 0o777).toBe(0o700)
				expect((await stat(path)).mode & 0o777).toBe(0o600)
				expect(await readFile(path, 'utf8')).toBe(expected)
			}
			expect(await consumePendingTitle(directory, 'cleared-session-id')).toBe('5')
			expect(await consumePendingTitle(directory, 'cleared-session-id')).toBeUndefined()
		} finally {
			await rm(directory, { recursive: true, force: true })
		}
	})

	test('uses complete plugin configuration without mixing it with process configuration', () => {
		expect(hierarchyConfiguration({
			...environment,
			CLAUDE_PLUGIN_OPTION_SERVICE_URL: ' https://plugin.test ',
			CLAUDE_PLUGIN_OPTION_NAMESPACE_ID: ' plugin-namespace ',
			CLAUDE_PLUGIN_OPTION_NAMESPACE_CAPABILITY: ' plugin-secret ',
		})).toEqual({
			serviceURL: 'https://plugin.test',
			namespaceID: 'plugin-namespace',
			capability: 'plugin-secret',
			useInstalledPlugin: true,
		})
		expect(hierarchyConfiguration({
			...environment,
			CLAUDE_PLUGIN_OPTION_NAMESPACE_ID: 'plugin-namespace',
		})).toEqual({ serviceURL: '', namespaceID: 'plugin-namespace', capability: '', useInstalledPlugin: true })
	})

	test('fails closed with installed-plugin guidance for partial plugin configuration', async () => {
		let calls = 0
		const output = await handleHook(session(), {
			...environment,
			CLAUDE_PLUGIN_OPTION_NAMESPACE_ID: 'plugin-namespace',
		}, {
			request: (async () => { calls += 1; return Response.json({}) }) as typeof fetch,
		})
		expect(calls).toBe(0)
		expect(output?.systemMessage).toContain('Open /plugin')
		expect(output?.systemMessage).toContain('Configure options')
		expect(output?.systemMessage).not.toContain('Set ZETTELKASTEN_')
	})

	test('keeps shared process configuration as the development fallback', () => {
		expect(hierarchyConfiguration(environment)).toEqual({
			serviceURL: 'https://service.test',
			namespaceID: 'ns_test',
			capability: 'secret',
			useInstalledPlugin: false,
		})
	})

	test('executes the marketplace artifact outside the repository package scope', async () => {
		const directory = await mkdtemp(resolve(tmpdir(), 'zettelkasten-claude-installed-'))
		try {
			const plugin = resolve(directory, 'plugin')
			await cp(import.meta.dir, plugin, { recursive: true })
			const node = resolve(import.meta.dir, '..', '..', 'node_modules', 'node', 'bin', 'node')
			const hook = spawnSync(node, [resolve(plugin, 'index.ts')], {
				cwd: directory,
				encoding: 'utf8',
				input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'installed-root', source: 'startup' }),
				env: { HOME: directory, PATH: globalThis.process.env.PATH ?? '' },
			})
			expect(hook.status).toBe(0)
			expect(JSON.parse(hook.stdout)).toMatchObject({ systemMessage: expect.stringContaining('configuration is incomplete') })
			const launcher = spawnSync(node, [resolve(plugin, 'launcher.ts')], {
				cwd: directory,
				encoding: 'utf8',
				env: { HOME: directory, PATH: globalThis.process.env.PATH ?? '' },
			})
			expect(launcher.status).toBe(1)
			expect(launcher.stderr).toContain('task is required')
		} finally {
			await rm(directory, { recursive: true, force: true })
		}
	})

	test('configures the current launcher identity and clears launch-only parent provenance', async () => {
		const directory = await mkdtemp(resolve(tmpdir(), 'zettelkasten-claude-env-'))
		try {
			const environmentFile = resolve(directory, 'environment.sh')
			await configureLauncher(environmentFile, "session'id", '4a', "/plugin's/launcher.ts", true)
			expect(await readFile(environmentFile, 'utf8')).toBe(
				"export ZETTELKASTEN_CLAUDE_SESSION_ID='session'\\''id'\n"
				+ "export ZETTELKASTEN_CLAUDE_ADDRESS='4a'\n"
				+ "export ZETTELKASTEN_CLAUDE_LAUNCHER='/plugin'\\''s/launcher.ts'\n"
				+ 'export ZETTELKASTEN_CLAUDE_USE_INSTALLED_PLUGIN=1\n'
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

			const fallbackCache = resolve(directory, '.cache', 'zettelkasten', 'claude-code', 'assignments')
			await mkdir(fallbackCache, { recursive: true })
			await writeFile(resolve(fallbackCache, assignmentFileName('fallback')), '4b\n')
			const relativeXdg = Bun.spawn(['sh', '-c', settings.subagentStatusLine.command], {
				env: { ...globalThis.process.env, HOME: directory, XDG_CACHE_HOME: 'relative-cache' },
				stdin: 'pipe',
				stdout: 'pipe',
				stderr: 'pipe',
			})
			relativeXdg.stdin.write(JSON.stringify({ tasks: [{ id: 'fallback', label: 'Fallback' }] }))
			relativeXdg.stdin.end()
			expect(await relativeXdg.exited).toBe(0)
			expect(await new Response(relativeXdg.stdout).text()).toBe(`${JSON.stringify({
				id: 'fallback', content: '4b Fallback',
			})}\n`)
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
		expect(configured[0]?.slice(0, 3)).toEqual(['/session-env', 'session-root', '4'])
		expect(configured[0]?.[3]).toEndWith('/integrations/claude-code/launcher.ts')
			expect(configured[0]?.[4]).toBe(false)
		expect(output?.hookSpecificOutput).toMatchObject({
			hookEventName: 'SessionStart',
			sessionTitle: '4 Old title',
		})
		expect(output?.hookSpecificOutput?.additionalContext).toContain('ZETTELKASTEN_CLAUDE_LAUNCHER')
	})

	test('applies a cleared session’s new canonical title on its first prompt', async () => {
		let pendingTitle: string | undefined
		const creates: Array<Record<string, unknown>> = []
		const cleared = await handleHook(session({
			session_id: 'cleared-root', source: 'clear', session_title: '4 Previous session',
		}), { ...environment, ZETTELKASTEN_CLAUDE_PARENT_SESSION_ID: 'stale-launch-parent' }, {
			request: (async (input, init) => {
				if (new URL(String(input)).pathname.endsWith('/resolve')) {
					return Response.json({ code: 'element_not_found' }, { status: 404 })
				}
				const body = JSON.parse(String(init?.body)) as Record<string, unknown>
				creates.push(body)
				return Response.json({ ...body, address: '5' }, { status: 201 })
			}) as typeof fetch,
			configureLauncher: async () => {},
			storePendingTitle: async (_directory, id, title) => {
				expect(id).toBe('cleared-root')
				pendingTitle = title
			},
		})
		expect(cleared?.hookSpecificOutput?.sessionTitle).toBe('5')
		expect(pendingTitle).toBe('5')
		expect(creates).toEqual([{ key: 'claude:cleared-root', parentKey: null }])

		const firstPrompt = await handleHook({
			hook_event_name: 'UserPromptSubmit', session_id: 'cleared-root', prompt: 'Continue',
		}, environment, {
			consumePendingTitle: async (_directory, id) => {
				expect(id).toBe('cleared-root')
				const title = pendingTitle
				pendingTitle = undefined
				return title
			},
		})
		expect(firstPrompt?.hookSpecificOutput).toEqual({ hookEventName: 'UserPromptSubmit', sessionTitle: '5' })
		expect(await handleHook({
			hook_event_name: 'UserPromptSubmit', session_id: 'cleared-root', prompt: 'Again',
		}, environment, { consumePendingTitle: async () => pendingTitle })).toBeUndefined()
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

	test.each(['clear', 'resume', 'compact'] as const)(
		'does not hard-stop %s when stale launch provenance remains',
		async (source) => {
			const output = await handleHook(session({ source }), {
				...environment,
				ZETTELKASTEN_CLAUDE_PARENT_SESSION_ID: 'stale-parent',
			}, {
				request: (async () => { throw new Error('offline') }) as typeof fetch,
			})
			expect(output?.systemMessage).toContain('unavailable')
			expect(output?.continue).toBeUndefined()
			expect(output?.stopReason).toBeUndefined()
		},
	)

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
