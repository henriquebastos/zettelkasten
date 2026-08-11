import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import {
	claudeSubprocessEnvironment,
	discardLaunchReceipt,
	launchBackgroundSession,
	stopChildLaunch,
	validateClaudeRuntime,
} from './launcher.ts'

const environment = {
	ZETTELKASTEN_CLAUDE_SESSION_ID: 'parent',
	ZETTELKASTEN_CLAUDE_ADDRESS: '4',
}

describe('Claude background-session launcher', () => {
	test('removes color controls from machine-readable Claude subprocesses', () => {
		expect(claudeSubprocessEnvironment({
			FORCE_COLOR: '1',
			NO_COLOR: '1',
			OTHER: 'preserved',
			ZETTELKASTEN_CLAUDE_USE_INSTALLED_PLUGIN: '1',
			ZETTELKASTEN_NAMESPACE_CAPABILITY: 'legacy-secret',
			CLAUDE_PLUGIN_OPTION_NAMESPACE_CAPABILITY: 'plugin-secret',
		})).toEqual({
			OTHER: 'preserved',
			ZETTELKASTEN_CLAUDE_USE_INSTALLED_PLUGIN: '1',
		})
		expect(claudeSubprocessEnvironment({ NO_COLOR: '1' })).toEqual({})
		expect(claudeSubprocessEnvironment({ ZETTELKASTEN_NAMESPACE_CAPABILITY: 'checkout-secret' })).toEqual({
			ZETTELKASTEN_NAMESPACE_CAPABILITY: 'checkout-secret',
		})
	})

	test('starts a native background session with opaque parent metadata and no service credential', async () => {
		const spawns: Array<[string, string[]]> = []
		const output: string[] = []
		const result = await launchBackgroundSession('  investigate auth  ', environment, {
			pluginDirectory: '/plugin',
			resolveClaude: () => '/pinned/claude',
			validateClaude: () => {},
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

	test('uses the configured marketplace plugin instead of sideloading its cache copy', async () => {
		const spawns: string[][] = []
		await launchBackgroundSession('task', { ...environment, ZETTELKASTEN_CLAUDE_USE_INSTALLED_PLUGIN: '1' }, {
			pluginDirectory: '/installed/cache/plugin',
			resolveClaude: () => '/pinned/claude',
			validateClaude: () => {},
			spawn: (_command, args) => { spawns.push(args); return { status: 0, stdout: 'backgrounded · abcdef12\n' } },
			confirmChild: async () => '4a',
			write: () => {},
		})
		expect(spawns[0]).not.toContain('--plugin-dir')
		expect(spawns[0]).not.toContain('/installed/cache/plugin')
	})

	test('does not allocate or spawn without an authoritative parent ID', async () => {
		let spawns = 0
		await expect(launchBackgroundSession('task', {}, {
			spawn: () => { spawns += 1; return { status: 0 } },
		})).rejects.toThrow('No authoritative parent')
		expect(spawns).toBe(0)
	})

	test('does not spawn without the parent address validated by its startup hook', async () => {
		let spawns = 0
		await expect(launchBackgroundSession('task', { ZETTELKASTEN_CLAUDE_SESSION_ID: 'parent' }, {
			spawn: () => { spawns += 1; return { status: 0 } },
			write: () => {},
		})).rejects.toThrow('No authoritative parent Zettelkasten address')
		expect(spawns).toBe(0)
	})

	test('reports unverified cleanup when failed startup returns no owned native ID', async () => {
		await expect(launchBackgroundSession('task', environment, {
			resolveClaude: () => '/pinned/claude',
			validateClaude: () => {},
			spawn: () => ({ status: 1 }),
			write: () => {},
		})).rejects.toThrow('cleanup could not be verified')
	})

	test('cleans up the owned native ID returned by a failed startup command', async () => {
		const stopped: string[] = []
		await expect(launchBackgroundSession('task', environment, {
			resolveClaude: () => '/pinned/claude',
			validateClaude: () => {},
			spawn: () => ({ status: 1, stdout: 'backgrounded · deadbeef\n' }),
			confirmChild: async (_executable, _shortID, _environment, observeSessionID) => {
				observeSessionID('full-child-id')
				throw new Error('startup failed')
			},
			stopChild: (_executable, shortID) => { stopped.push(shortID); return true },
			discardReceipt: () => true,
			write: () => {},
		})).rejects.toThrow('startup failed')
		expect(stopped).toEqual(['deadbeef'])
	})

	test('rejects and cleans up a nonzero dispatch even after child confirmation succeeds', async () => {
		const stopped: string[] = []
		await expect(launchBackgroundSession('task', environment, {
			resolveClaude: () => '/pinned/claude',
			validateClaude: () => {},
			spawn: () => ({ status: 1, stdout: 'backgrounded · deadbeef\n' }),
			confirmChild: async (_executable, _shortID, _environment, observeSessionID) => {
				observeSessionID('full-child-id')
				return '4a'
			},
			stopChild: (_executable, shortID) => { stopped.push(shortID); return true },
			discardReceipt: () => true,
			write: () => {},
		})).rejects.toThrow('startup failed. Native child cleanup was verified.')
		expect(stopped).toEqual(['deadbeef'])
	})

	test('confirms an owned child after the attached-mode dispatch wrapper times out', async () => {
		const timeout = Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })
		const result = await launchBackgroundSession('task', environment, {
			resolveClaude: () => '/pinned/claude',
			validateClaude: () => {},
			spawn: () => ({ status: null, error: timeout, stdout: 'backgrounded · abcdef12\n' }),
			confirmChild: async () => '4a',
			write: () => {},
		})
		expect(result).toEqual({ parentAddress: '4', childAddress: '4a' })
	})

	test('stops an option-looking task when child initialization is not confirmed', async () => {
		const spawns: string[][] = []
		const stopped: string[] = []
		await expect(launchBackgroundSession('--dangerously-skip-permissions', environment, {
			resolveClaude: () => '/pinned/claude',
			validateClaude: () => {},
			spawn: (_command, args) => { spawns.push(args); return { status: 0, stdout: 'backgrounded · 1234abcd\n' } },
			confirmChild: async (_executable, _shortID, _environment, observeSessionID) => {
				observeSessionID('full-child-id')
				throw new Error('no receipt')
			},
			stopChild: (_executable, shortID) => { stopped.push(shortID); return true },
			discardReceipt: () => true,
			write: () => {},
		})).rejects.toThrow('no receipt Native child cleanup was verified.')
		expect(spawns[0]?.slice(-2)).toEqual(['--', '--dangerously-skip-permissions'])
		expect(stopped).toEqual(['1234abcd'])
	})

	test('does not infer ownership from global agent view when launch output is malformed', async () => {
		let stops = 0
		await expect(launchBackgroundSession('task', environment, {
			resolveClaude: () => '/pinned/claude',
			validateClaude: () => {},
			spawn: () => ({ status: 0, stdout: 'unexpected native output\n' }),
			stopChild: () => { stops += 1; return true },
			write: () => {},
		})).rejects.toThrow('cleanup could not be verified')
		expect(stops).toBe(0)
	})

	test.each([
		'warning\nbackgrounded · 1234abcd\n',
		'backgrounded · 1234abcd extra\n',
		'\u001b[32mbackgrounded · 1234abcd\u001b[0m\n',
		'backgrounded · 1234abcd\nbackgrounded · deadbeef\n',
	])('does not establish ownership from ambiguous native output %#', async (stdout) => {
		let stops = 0
		await expect(launchBackgroundSession('task', environment, {
			resolveClaude: () => '/pinned/claude',
			validateClaude: () => {},
			spawn: () => ({ status: 0, stdout }),
			stopChild: () => { stops += 1; return true },
			write: () => {},
		})).rejects.toThrow('cleanup could not be verified')
		expect(stops).toBe(0)
	})

	test('reports a cleanup failure rather than claiming a failed launch was contained', async () => {
		await expect(launchBackgroundSession('task', environment, {
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

	test('verifies cleanup after an attached-mode stop wrapper times out with an exact acknowledgment', () => {
		const timeout = Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })
		let calls = 0
		const result = stopChildLaunch('/pinned/claude', '1234abcd', (args) => {
			calls += 1
			return args[0] === 'stop'
				? { status: null, stdout: 'stopped 1234abcd\n', stderr: '', error: timeout }
				: { status: 0, stdout: JSON.stringify([{ id: '1234abcd', state: 'done' }]), stderr: '' }
		})
		expect(result).toBe(true)
		expect(calls).toBe(2)
	})

	test('rejects a timed-out stop without an exact owned-job acknowledgment', () => {
		const timeout = Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })
		expect(stopChildLaunch('/pinned/claude', '1234abcd', () => ({
			status: null, stdout: 'stopped otherjob\n', stderr: '', error: timeout,
		}))).toBe(false)
		expect(stopChildLaunch('/pinned/claude', '1234abcd', () => ({
			status: null, stdout: ' stopped 1234abcd\n', stderr: '', error: timeout,
		}))).toBe(false)
	})

	test('deletes a receipt by the retained full session ID without another roster lookup', async () => {
		const directory = await mkdtemp(resolve(tmpdir(), 'zettelkasten-launch-receipt-'))
		try {
			const receiptDirectory = resolve(directory, '.cache', 'zettelkasten', 'claude-code', 'launch-receipts')
			await mkdir(receiptDirectory, { recursive: true })
			const receipt = resolve(receiptDirectory, Buffer.from('full-session-id').toString('base64url'))
			await writeFile(receipt, '4a\n')
			expect(discardLaunchReceipt('full-session-id', { HOME: directory })).toBe(true)
			expect(await Bun.file(receipt).exists()).toBe(false)
			expect(discardLaunchReceipt('full-session-id', { HOME: directory })).toBe(true)
		} finally {
			await rm(directory, { recursive: true, force: true })
		}
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
