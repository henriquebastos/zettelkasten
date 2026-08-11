import { describe, expect, test } from 'bun:test'

import { launchBackgroundSession, stopChildLaunch, validateClaudeRuntime } from './launcher.ts'

const environment = {
	ZETTELKASTEN_SERVICE_URL: 'https://service.test',
	ZETTELKASTEN_NAMESPACE_ID: 'ns',
	ZETTELKASTEN_NAMESPACE_CAPABILITY: 'secret',
	ZETTELKASTEN_CLAUDE_SESSION_ID: 'parent',
}

describe('Claude background-session launcher', () => {
	test('resolves the parent and starts a native background session with an opaque parent setting', async () => {
		const requests: Array<{ path: string; body: Record<string, unknown> }> = []
		const spawns: Array<[string, string[]]> = []
		const output: string[] = []
		const result = await launchBackgroundSession('  investigate auth  ', environment, {
			pluginDirectory: '/plugin',
			resolveClaude: () => '/pinned/claude',
			validateClaude: () => {},
			request: (async (input, init) => {
				const path = new URL(String(input)).pathname
				const body = JSON.parse(String(init?.body)) as Record<string, unknown>
				requests.push({ path, body })
				return Response.json({ key: 'claude:parent', parentKey: null, address: '4' })
			}) as typeof fetch,
			spawn: (command, args) => {
				spawns.push([command, args])
				return { status: 0, stdout: 'backgrounded · abcdef12\n' }
			},
			confirmChild: async (executable, shortID) => {
				expect(executable).toBe('/pinned/claude')
				expect(shortID).toBe('abcdef12')
				return '4a'
			},
			write: (message) => { output.push(message) },
		})
		expect(requests).toEqual([{ path: '/v1/namespaces/ns/elements/resolve', body: { key: 'claude:parent' } }])
		expect(spawns).toEqual([['/pinned/claude', [
			'--bg',
			'--settings', '{"env":{"ZETTELKASTEN_CLAUDE_PARENT_SESSION_ID":"parent"}}',
			'--plugin-dir', '/plugin',
			'--',
			'investigate auth',
		]]])
		expect(output).toEqual([
			'Launching a child of Zettelkasten address 4 as a Claude background session.\n',
			'backgrounded · abcdef12\n',
			'Confirmed Claude background session at Zettelkasten address 4a.\n',
		])
		expect(result).toEqual({ parentAddress: '4', childAddress: '4a' })
	})

	test('does not allocate or spawn without an authoritative parent ID', async () => {
		let requests = 0
		let spawns = 0
		await expect(launchBackgroundSession('task', {}, {
			request: (async () => { requests += 1; return Response.json({}) }) as typeof fetch,
			spawn: () => { spawns += 1; return { status: 0 } },
		})).rejects.toThrow('No authoritative parent')
		expect(requests).toBe(0)
		expect(spawns).toBe(0)
	})

	test('does not spawn when the service cannot resolve the parent', async () => {
		let spawns = 0
		await expect(launchBackgroundSession('task', environment, {
			request: (async () => Response.json({ code: 'element_not_found' }, { status: 404 })) as typeof fetch,
			spawn: () => { spawns += 1; return { status: 0 } },
			write: () => {},
		})).rejects.toThrow('rejected resolution')
		expect(spawns).toBe(0)
	})

	test('reports unverified cleanup when failed startup returns no owned native ID', async () => {
		await expect(launchBackgroundSession('task', environment, {
			request: (async () => Response.json({ key: 'claude:parent', parentKey: null, address: '4' })) as typeof fetch,
			resolveClaude: () => '/pinned/claude',
			validateClaude: () => {},
			spawn: () => ({ status: 1 }),
			write: () => {},
		})).rejects.toThrow('cleanup could not be verified')
	})

	test('cleans up the owned native ID returned by a failed startup command', async () => {
		const stopped: string[] = []
		await expect(launchBackgroundSession('task', environment, {
			request: (async () => Response.json({ key: 'claude:parent', parentKey: null, address: '4' })) as typeof fetch,
			resolveClaude: () => '/pinned/claude',
			validateClaude: () => {},
			spawn: () => ({ status: 1, stdout: 'backgrounded · deadbeef\n' }),
			stopChild: (_executable, shortID) => { stopped.push(shortID); return true },
			discardReceipt: () => true,
			write: () => {},
		})).rejects.toThrow('startup failed')
		expect(stopped).toEqual(['deadbeef'])
	})

	test('stops an option-looking task when child initialization is not confirmed', async () => {
		const spawns: string[][] = []
		const stopped: string[] = []
		await expect(launchBackgroundSession('--dangerously-skip-permissions', environment, {
			request: (async () => Response.json({ key: 'claude:parent', parentKey: null, address: '4' })) as typeof fetch,
			resolveClaude: () => '/pinned/claude',
			validateClaude: () => {},
			spawn: (_command, args) => { spawns.push(args); return { status: 0, stdout: 'backgrounded · 1234abcd\n' } },
			confirmChild: async () => { throw new Error('no receipt') },
			stopChild: (_executable, shortID) => { stopped.push(shortID); return true },
			discardReceipt: () => true,
			write: () => {},
		})).rejects.toThrow('no receipt')
		expect(spawns[0]?.slice(-2)).toEqual(['--', '--dangerously-skip-permissions'])
		expect(stopped).toEqual(['1234abcd'])
	})

	test('does not infer ownership from global agent view when launch output is malformed', async () => {
		let stops = 0
		await expect(launchBackgroundSession('task', environment, {
			request: (async () => Response.json({ key: 'claude:parent', parentKey: null, address: '4' })) as typeof fetch,
			resolveClaude: () => '/pinned/claude',
			validateClaude: () => {},
			spawn: () => ({ status: 0, stdout: 'unexpected native output\n' }),
			stopChild: () => { stops += 1; return true },
			write: () => {},
		})).rejects.toThrow('cleanup could not be verified')
		expect(stops).toBe(0)
	})

	test('reports a cleanup failure rather than claiming a failed launch was contained', async () => {
		await expect(launchBackgroundSession('task', environment, {
			request: (async () => Response.json({ key: 'claude:parent', parentKey: null, address: '4' })) as typeof fetch,
			resolveClaude: () => '/pinned/claude',
			validateClaude: () => {},
			spawn: () => ({ status: 0, stdout: 'backgrounded · 1234abcd\n' }),
			confirmChild: async () => { throw new Error('wrong lineage') },
			stopChild: () => false,
			write: () => {},
		})).rejects.toThrow('cleanup could not be verified')
	})

	test('accepts only the pinned executable with a pinned or explicitly inactive supervisor', () => {
		const version = { status: 0, stdout: '2.1.227 (Claude Code)\n', stderr: '' }
		expect(() => validateClaudeRuntime('/pinned/claude', (args) => args[0] === '--version'
			? version
			: { status: 0, stdout: 'pid: 1\nversion: 2.1.227\n', stderr: '' })).not.toThrow()
		expect(() => validateClaudeRuntime('/pinned/claude', (args) => args[0] === '--version'
			? version
			: { status: 1, stdout: 'not running\n\nbg sessions:\n', stderr: '' })).not.toThrow()
		expect(() => validateClaudeRuntime('/pinned/claude', (args) => args[0] === '--version'
			? version
			: { status: 0, stdout: 'version: 2.1.226\n', stderr: '' })).toThrow('2.1.226')
		expect(() => validateClaudeRuntime('/pinned/claude', (args) => args[0] === '--version'
			? version
			: { status: 1, stdout: '', stderr: 'connection failed' })).toThrow('could not be validated')
		expect(() => validateClaudeRuntime('/pinned/claude', (args) => args[0] === '--version'
			? { ...version, error: new Error('timed out') }
			: { status: 0, stdout: 'pid: 1\nversion: 2.1.227\n', stderr: '' })).toThrow('2.1.227 is required')
	})

	test('polls until native cleanup reaches a terminal state', () => {
		const commands: string[][] = []
		const states = ['working', 'stopped']
		const result = stopChildLaunch('/pinned/claude', '1234abcd', (args) => {
			commands.push(args)
			if (args[0] === 'stop') return { status: 0, stdout: '', stderr: '' }
			return { status: 0, stdout: JSON.stringify([{ id: '1234abcd', state: states.shift() }]), stderr: '' }
		})
		expect(result).toBe(true)
		expect(commands).toEqual([
			['stop', '1234abcd'],
			['agents', '--json', '--all'],
			['agents', '--json', '--all'],
		])
	})

	test('does not accept terminal roster state after the stop command errors', () => {
		let calls = 0
		const result = stopChildLaunch('/pinned/claude', '1234abcd', () => {
			calls += 1
			return { status: null, stdout: '', stderr: '', error: new Error('timed out') }
		})
		expect(result).toBe(false)
		expect(calls).toBe(1)
	})
})
