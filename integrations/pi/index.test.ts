import { describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { saveConfiguration } from './configure.ts'
import {
	RemoteHierarchy,
	assertSupportedPlatform,
	createIntegration,
	formatSessionName,
	loadConfiguration,
	parseAddress,
	reconcileSession,
	type Configuration,
	type SessionHeader,
} from './index.ts'

const configuration: Configuration = { serviceURL: 'https://service.test', namespaceID: 'shared', capability: 'fake-capability' }

function remoteService() {
	const assignments = new Map<string, { key: string; parentKey: string | null; address: string }>()
	let roots = 0
	const children = new Map<string, number>()
	const request = (async (input, init) => {
		const path = new URL(String(input)).pathname
		const body = JSON.parse(String(init?.body)) as { key: string; parentKey?: string | null }
		if (path.endsWith('/resolve')) {
			const assignment = assignments.get(body.key)
			return assignment ? Response.json(assignment) : Response.json({ code: 'element_not_found' }, { status: 404 })
		}
		const existing = assignments.get(body.key)
		if (existing) {
			if (existing.parentKey !== body.parentKey) return Response.json({ code: 'parent_conflict' }, { status: 409 })
			return Response.json(existing)
		}
		const parentAddress = assignments.get(body.parentKey ?? '')?.address ?? ''
		const ordinal = (children.get(body.parentKey ?? '') ?? 0) + 1
		const address = body.parentKey === null
			? String(++roots)
			: `${parentAddress}${parseAddress(parentAddress).length % 2 === 1 ? String.fromCharCode(96 + ordinal) : ordinal}`
		if (body.parentKey !== null) children.set(body.parentKey ?? '', ordinal)
		const assignment = { key: body.key, parentKey: body.parentKey ?? null, address }
		assignments.set(body.key, assignment)
		return Response.json(assignment, { status: 201 })
	}) as typeof fetch
	return { assignments, request }
}

async function writeSession(directory: string, id: string, parentSession?: string): Promise<string> {
	const path = resolve(directory, `${id}.jsonl`)
	await writeFile(path, `${JSON.stringify({ type: 'session', version: 3, id, timestamp: new Date().toISOString(), cwd: directory, ...(parentSession ? { parentSession } : {}) })}\n`, { mode: 0o600 })
	return path
}

describe('Pi hierarchy integration', () => {
	test.each([['4', [4]], ['4a', [4, 'a']], ['4a1b', [4, 'a', 1, 'b']]])('parses canonical address %s', (value, expected) => {
		expect(parseAddress(value)).toEqual(expected)
	})

	test.each(['', '0', '01', '4A', '4a0', '4-a'])('rejects invalid address %s', (value) => {
		expect(() => parseAddress(value)).toThrow()
	})

	test('preserves a semantic session name without using it as identity', () => {
		expect(formatSessionName(parseAddress('4'), undefined)).toBe('4')
		expect(formatSessionName(parseAddress('4'), 'Investigate Pi')).toBe('4 Investigate Pi')
		expect(formatSessionName(parseAddress('4'), '4 Investigate Pi')).toBe('4 Investigate Pi')
		expect(formatSessionName(parseAddress('4a'), '4')).toBe('4a')
		expect(formatSessionName(parseAddress('4a'), '4 Parent task')).toBe('4a Parent task')
	})

	test('rejects native Windows where POSIX credential and provenance controls are unavailable', () => {
		expect(() => assertSupportedPlatform('win32')).toThrow('Native Windows is unsupported')
		expect(() => assertSupportedPlatform('linux')).not.toThrow()
	})

	test('creates exact native ancestors parent-first and resumes idempotently', async () => {
		const directory = await mkdtemp(resolve(tmpdir(), 'zettelkasten-pi-lineage-'))
		try {
			const rootPath = await writeSession(directory, 'root')
			const childPath = await writeSession(directory, 'child', rootPath)
			await writeSession(directory, 'grandchild', childPath)
			const remote = remoteService()
			const hierarchy = new RemoteHierarchy(configuration, remote.request)
			const header: SessionHeader = { type: 'session', id: 'grandchild', parentSession: childPath }
			expect((await reconcileSession(header, hierarchy)).address.join('')).toBe('1a1')
			expect([...remote.assignments.values()].map(({ key, parentKey }) => [key, parentKey])).toEqual([
				['pi:root', null], ['pi:child', 'pi:root'], ['pi:grandchild', 'pi:child'],
			])
			expect((await reconcileSession(header, hierarchy)).address.join('')).toBe('1a1')
			expect(remote.assignments.size).toBe(3)
		} finally { await rm(directory, { recursive: true, force: true }) }
	})

	test('rejects conflicting remote parentage and malformed root lineage', async () => {
		const directory = await mkdtemp(resolve(tmpdir(), 'zettelkasten-pi-conflict-'))
		try {
			const rootPath = await writeSession(directory, 'root')
			const childPath = await writeSession(directory, 'child', rootPath)
			const remote = remoteService()
			remote.assignments.set('pi:child', { key: 'pi:child', parentKey: null, address: '2' })
			await expect(reconcileSession({ type: 'session', id: 'child', parentSession: rootPath }, new RemoteHierarchy(configuration, remote.request))).rejects.toThrow('conflict')
			const malformed = (async () => Response.json({ key: 'pi:root', parentKey: null, address: '1a' })) as typeof fetch
			await expect(reconcileSession({ type: 'session', id: 'root' }, new RemoteHierarchy(configuration, malformed))).rejects.toThrow('outside')
			void childPath
		} finally { await rm(directory, { recursive: true, force: true }) }
	})

	test('recovers ambiguous committed allocations using the same native ID', async () => {
		for (const failure of ['transport', 'malformed', 'server'] as const) {
			const remote = remoteService()
			let failed = false
			const request = (async (input, init) => {
				const response = await remote.request(input, init)
				if (!failed && !new URL(String(input)).pathname.endsWith('/resolve')) {
					failed = true
					if (failure === 'transport') throw new Error('response lost')
					if (failure === 'malformed') return new Response('{', { status: 201 })
					return Response.json({ code: 'upstream_failure' }, { status: 500 })
				}
				return response
			}) as typeof fetch
			expect((await new RemoteHierarchy(configuration, request).allocate('root', null)).join('')).toBe('1')
			expect(remote.assignments.size).toBe(1)
		}
	})

	test('does not retry definitive allocation failures or accept conflicting recovery', async () => {
		let calls = 0
		const rejected = (async () => { calls += 1; return Response.json({ code: 'parent_conflict' }, { status: 409 }) }) as typeof fetch
		await expect(new RemoteHierarchy(configuration, rejected).allocate('child', 'root')).rejects.toThrow('parent_conflict')
		expect(calls).toBe(1)
		const remote = remoteService()
		remote.assignments.set('pi:child', { key: 'pi:child', parentKey: null, address: '2' })
		const lost = (async (input, init) => {
			if (!new URL(String(input)).pathname.endsWith('/resolve')) throw new Error('response lost')
			return remote.request(input, init)
		}) as typeof fetch
		await expect(new RemoteHierarchy(configuration, lost).allocate('child', 'root')).rejects.toThrow('conflicting parentage')
	})

	test('stores shared configuration and capability in separate private files', async () => {
		const agentDir = await mkdtemp(resolve(tmpdir(), 'zettelkasten-pi-config-'))
		try {
			await saveConfiguration({ PI_CODING_AGENT_DIR: agentDir }, 'https://service.test/', 'shared', 'fake-capability')
			const directory = resolve(agentDir, 'zettelkasten')
			expect((await stat(directory)).mode & 0o777).toBe(0o700)
			for (const file of ['config.json', 'capability']) expect((await stat(resolve(directory, file))).mode & 0o777).toBe(0o600)
			expect(await loadConfiguration({ PI_CODING_AGENT_DIR: agentDir })).toEqual(configuration)
			expect(await readFile(resolve(directory, 'config.json'), 'utf8')).not.toContain('fake-capability')
		} finally { await rm(agentDir, { recursive: true, force: true }) }
	})

	test('partial local configuration never mixes with environment fallback', async () => {
		const agentDir = await mkdtemp(resolve(tmpdir(), 'zettelkasten-pi-partial-'))
		try {
			const directory = resolve(agentDir, 'zettelkasten')
			await Bun.write(resolve(directory, 'config.json'), '{"serviceURL":"https://local.test","namespaceID":"local"}\n', { createPath: true })
			await chmod(directory, 0o700)
			await chmod(resolve(directory, 'config.json'), 0o600)
			expect(await loadConfiguration({
				PI_CODING_AGENT_DIR: agentDir,
				ZETTELKASTEN_SERVICE_URL: 'https://environment.test',
				ZETTELKASTEN_NAMESPACE_ID: 'environment',
				ZETTELKASTEN_NAMESPACE_CAPABILITY: 'environment-capability',
			})).toEqual({ serviceURL: 'https://local.test', namespaceID: 'local', capability: '' })
		} finally { await rm(agentDir, { recursive: true, force: true }) }
	})

	test('blocks model input and leaves metadata unchanged when initialization fails', async () => {
		const handlers = new Map<string, Function>()
		let name: string | undefined
		const pi = {
			on: (event: string, handler: Function) => handlers.set(event, handler),
			registerCommand: () => {}, setSessionName: (value: string) => { name = value }, getSessionName: () => name,
		}
		createIntegration(pi as never, { environment: {} })
		const context = { hasUI: true, cwd: '/tmp', ui: { notify: () => { throw new Error('UI unavailable') } }, sessionManager: { getSessionId: () => 'root', getSessionFile: () => '/tmp/root', getHeader: () => ({ type: 'session', id: 'root' }) } }
		await handlers.get('session_start')?.({}, context)
		expect(await handlers.get('input')?.({}, context)).toEqual({ action: 'handled' })
		expect(await handlers.get('session_before_compact')?.({}, context)).toEqual({ cancel: true })
		expect(await handlers.get('session_before_tree')?.({ preparation: { userWantsSummary: true } }, context)).toEqual({ cancel: true })
		expect(await handlers.get('session_before_tree')?.({ preparation: { userWantsSummary: false } }, context)).toBeUndefined()
		expect(name).toBeUndefined()
	})

	test('names a validated root and launches only a persistent foreground child', async () => {
		const directory = await mkdtemp(resolve(tmpdir(), 'zettelkasten-pi-command-'))
		const rootPath = await writeSession(directory, 'root')
		const handlers = new Map<string, Function>()
		let command: { handler: Function } | undefined
		let name = 'Root task'
		const pi = {
			on: (event: string, handler: Function) => handlers.set(event, handler),
			registerCommand: (_name: string, options: { handler: Function }) => { command = options },
			setSessionName: (value: string) => { name = value }, getSessionName: () => name,
		}
		const remote = remoteService()
		createIntegration(pi as never, {
			environment: {
				ZETTELKASTEN_SERVICE_URL: configuration.serviceURL,
				ZETTELKASTEN_NAMESPACE_ID: configuration.namespaceID,
				ZETTELKASTEN_NAMESPACE_CAPABILITY: configuration.capability,
			},
			request: remote.request,
		})
		const notices: string[] = []
		const sent: string[] = []
		let parentSession = ''
		const context = {
			hasUI: true, cwd: '/tmp', ui: { notify: (message: string) => notices.push(message) },
			sessionManager: { getSessionId: () => 'root', getSessionFile: () => rootPath, getHeader: () => ({ type: 'session', id: 'root' }) },
			waitForIdle: async () => {},
			newSession: async (options: { parentSession: string; withSession: (replacement: { sendUserMessage(message: string): Promise<void> }) => Promise<void> }) => {
				parentSession = options.parentSession
				await options.withSession({ sendUserMessage: async (message) => { sent.push(message) } })
				return { cancelled: false }
			},
		}
		try {
			await handlers.get('session_start')?.({}, context)
			expect(name).toBe('1 Root task')
			expect(await handlers.get('input')?.({}, context)).toEqual({ action: 'continue' })
			expect(await handlers.get('session_before_compact')?.({}, context)).toBeUndefined()
			await handlers.get('session_info_changed')?.({ name: 'Investigate' }, context)
			expect(name).toBe('1 Investigate')
			await command?.handler(' investigate ', context)
			expect({ parentSession, sent }).toEqual({ parentSession: rootPath, sent: ['investigate'] })
			expect(notices).toContain('Zettelkasten address: 1')
		} finally { await rm(directory, { recursive: true, force: true }) }
	})

	test('does not replace the foreground until the lazy parent session exists', async () => {
		const handlers = new Map<string, Function>()
		let command: { handler: Function } | undefined
		const remote = remoteService()
		const pi = {
			on: (event: string, handler: Function) => handlers.set(event, handler),
			registerCommand: (_name: string, options: { handler: Function }) => { command = options },
			setSessionName: () => {}, getSessionName: () => undefined,
		}
		createIntegration(pi as never, {
			environment: { ZETTELKASTEN_SERVICE_URL: configuration.serviceURL, ZETTELKASTEN_NAMESPACE_ID: configuration.namespaceID, ZETTELKASTEN_NAMESPACE_CAPABILITY: configuration.capability },
			request: remote.request,
		})
		let replacements = 0
		const context = {
			hasUI: true, cwd: '/tmp', ui: { notify: () => {} },
			sessionManager: { getSessionId: () => 'root', getSessionFile: () => '/tmp/never-written-pi-root.jsonl', getHeader: () => ({ type: 'session', id: 'root' }) },
			waitForIdle: async () => {}, newSession: async () => { replacements += 1; return { cancelled: false } },
		}
		await handlers.get('session_start')?.({}, context)
		await command?.handler('task', context)
		expect(replacements).toBe(0)
	})
})
