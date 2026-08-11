import { spawnSync } from 'node:child_process'
import { accessSync, constants, readFileSync, realpathSync, unlinkSync } from 'node:fs'
import { delimiter, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
	HierarchyAllocationError,
	RemoteHierarchyAllocator,
	assignmentFileName,
	displayCacheDirectory,
	parseAddress,
} from './index.ts'

interface LauncherEnvironment {
	ZETTELKASTEN_SERVICE_URL?: string
	ZETTELKASTEN_NAMESPACE_ID?: string
	ZETTELKASTEN_NAMESPACE_CAPABILITY?: string
	ZETTELKASTEN_CLAUDE_SESSION_ID?: string
	HOME?: string
	XDG_CACHE_HOME?: string
	PATH?: string
}

interface LauncherDependencies {
	spawn?: (command: string, args: string[]) => { error?: Error; status: number | null; stdout?: string; stderr?: string }
	request?: typeof fetch
	write?: (message: string) => void
	pluginDirectory?: string
	resolveClaude?: (environment: LauncherEnvironment) => string
	validateClaude?: (executable: string) => void
	confirmChild?: (executable: string, shortID: string, environment: LauncherEnvironment) => Promise<string>
	stopChild?: (executable: string, shortID: string) => boolean
	discardReceipt?: (executable: string, shortID: string, environment: LauncherEnvironment) => boolean
}

interface CommandResult {
	status: number | null
	stdout: string
	stderr: string
	error?: Error
}

export interface LaunchResult {
	parentAddress: string
	childAddress: string
}

function runClaude(executable: string, args: string[], timeout: number): CommandResult {
	return spawnSync(executable, args, {
		encoding: 'utf8',
		timeout,
		killSignal: 'SIGKILL',
		maxBuffer: 1024 * 1024,
	})
}

export function resolveClaudeExecutable(environment: LauncherEnvironment): string {
	for (const directory of environment.PATH?.split(delimiter) ?? []) {
		const candidate = resolve(directory, 'claude')
		try {
			accessSync(candidate, constants.X_OK)
			return realpathSync(candidate)
		} catch {
			// Continue to the next PATH entry.
		}
	}
	throw new HierarchyAllocationError('The pinned Claude Code executable is not available on PATH; launch was deferred.')
}

export function validateClaudeRuntime(
	executable: string,
	run: (args: string[]) => CommandResult = (args) => runClaude(executable, args, 3_000),
): void {
	const version = run(['--version'])
	if (version.error || version.status !== 0 || version.stdout.trim() !== '2.1.227 (Claude Code)') {
		throw new HierarchyAllocationError('Claude Code 2.1.227 is required for background-session launching.')
	}
	const daemon = run(['daemon', 'status'])
	if (daemon.error) throw new HierarchyAllocationError('Claude background supervisor status could not be validated; launch was deferred.')
	const runningVersion = daemon.stdout.match(/^version:\s*(\S+)/m)?.[1]
	if (daemon.status === 0 && runningVersion === '2.1.227') return
	if (daemon.status === 1 && daemon.stdout.startsWith('not running\n')) return
	if (runningVersion) {
		throw new HierarchyAllocationError(`Claude's running background supervisor is ${runningVersion}; stop it before launching with 2.1.227.`)
	}
	throw new HierarchyAllocationError('Claude background supervisor status could not be validated; launch was deferred.')
}

function sleep(milliseconds: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

export async function confirmChildLaunch(
	executable: string,
	shortID: string,
	environment: LauncherEnvironment,
): Promise<string> {
	const cacheDirectory = displayCacheDirectory(environment)
	if (!cacheDirectory) throw new HierarchyAllocationError('No user cache directory is available for launch confirmation.')
	const deadline = Date.now() + 10_000
	while (Date.now() < deadline) {
		const remaining = deadline - Date.now()
		const listed = runClaude(executable, ['agents', '--json', '--all'], Math.max(1, Math.min(1_000, remaining)))
		if (!listed.error && listed.status === 0) {
			let rows: Array<{ id?: string; sessionId?: string }> | undefined
			try {
				rows = JSON.parse(listed.stdout) as Array<{ id?: string; sessionId?: string }>
			} catch {
				// Agent-view output is not ready yet.
			}
			if (rows) {
				const sessionID = rows.find((row) => row.id === shortID)?.sessionId
				if (sessionID) {
					const path = resolve(cacheDirectory, 'launch-receipts', assignmentFileName(sessionID))
					try {
						const address = readFileSync(path, 'utf8').trim()
						try {
							parseAddress(address)
						} catch {
							try { unlinkSync(path) } catch { /* Report the invalid receipt below. */ }
							throw new HierarchyAllocationError('Claude background session wrote an invalid hierarchy receipt.')
						}
						try {
							unlinkSync(path)
						} catch {
							throw new HierarchyAllocationError('Claude background-session hierarchy receipt could not be consumed.')
						}
						return address
					} catch (error) {
						if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
						// The worker exists but has not completed its hierarchy hook yet.
					}
				}
			}
		}
		sleep(Math.min(100, Math.max(1, deadline - Date.now())))
	}
	throw new HierarchyAllocationError('Claude background session did not confirm hierarchy initialization within 10 seconds.')
}

export function stopChildLaunch(
	executable: string,
	shortID: string,
	run: (args: string[], timeout: number) => CommandResult = (args, timeout) => runClaude(executable, args, timeout),
): boolean {
	const deadline = Date.now() + 5_000
	const stopped = run(['stop', shortID], 2_000)
	if (stopped.error || stopped.status !== 0) return false
	while (Date.now() < deadline) {
		const listed = run(['agents', '--json', '--all'], Math.max(1, Math.min(1_000, deadline - Date.now())))
		if (!listed.error && listed.status === 0) {
			try {
				const rows = JSON.parse(listed.stdout) as Array<{ id?: string; state?: string }>
				const child = rows.find((row) => row.id === shortID)
				if (!child || child.state === 'stopped' || child.state === 'failed' || child.state === 'done') return true
			} catch {
				// Retry malformed or transitional native state until the cleanup deadline.
			}
		}
		sleep(Math.min(100, Math.max(1, deadline - Date.now())))
	}
	return false
}

export function discardLaunchReceipt(executable: string, shortID: string, environment: LauncherEnvironment): boolean {
	const cacheDirectory = displayCacheDirectory(environment)
	if (!cacheDirectory) return false
	const listed = runClaude(executable, ['agents', '--json', '--all'], 1_000)
	if (listed.error || listed.status !== 0) return false
	try {
		const rows = JSON.parse(listed.stdout) as Array<{ id?: string; sessionId?: string }>
		const sessionID = rows.find((row) => row.id === shortID)?.sessionId
		if (!sessionID) return true
		try {
			unlinkSync(resolve(cacheDirectory, 'launch-receipts', assignmentFileName(sessionID)))
			return true
		} catch (error) {
			return error instanceof Error && 'code' in error && error.code === 'ENOENT'
		}
	} catch {
		return false
	}
}

export async function launchBackgroundSession(
	prompt: string,
	environment: LauncherEnvironment,
	dependencies: LauncherDependencies = {},
): Promise<LaunchResult> {
	if (!prompt.trim()) throw new HierarchyAllocationError('A background-session task is required.')
	const parentSessionID = environment.ZETTELKASTEN_CLAUDE_SESSION_ID
	if (!parentSessionID) {
		throw new HierarchyAllocationError('No authoritative parent Claude session ID is available; launch was deferred.')
	}
	const allocator = new RemoteHierarchyAllocator(
		environment.ZETTELKASTEN_SERVICE_URL ?? '',
		environment.ZETTELKASTEN_NAMESPACE_ID ?? '',
		environment.ZETTELKASTEN_NAMESPACE_CAPABILITY ?? '',
		dependencies.request,
	)
	const parent = await allocator.resolveAssignment(parentSessionID)
	const parentAddress = parent.address.join('')
	const write = dependencies.write ?? ((message: string) => { process.stdout.write(message) })
	write(`Launching a child of Zettelkasten address ${parentAddress} as a Claude background session.\n`)
	const pluginDirectory = dependencies.pluginDirectory ?? fileURLToPath(new URL('.', import.meta.url))
	const executable = (dependencies.resolveClaude ?? resolveClaudeExecutable)(environment)
	const validate = dependencies.validateClaude ?? validateClaudeRuntime
	validate(executable)
	const launchSettings = JSON.stringify({ env: { ZETTELKASTEN_CLAUDE_PARENT_SESSION_ID: parentSessionID } })
	const spawned = (dependencies.spawn ?? ((command, args) => runClaude(command, args, 12_000)))(
		executable,
		['--bg', '--settings', launchSettings, '--plugin-dir', pluginDirectory, '--', prompt.trim()],
	)
	let shortID = spawned.stdout?.match(/backgrounded\s+·\s+([0-9a-f]{8})/)?.[1]
	try {
		if (spawned.stdout) write(spawned.stdout)
		if (spawned.stderr) (dependencies.write ? write(spawned.stderr) : process.stderr.write(spawned.stderr))
		if (spawned.error || spawned.status !== 0) {
			throw new HierarchyAllocationError('Claude background-session startup failed.')
		}
		if (!shortID) throw new HierarchyAllocationError('Claude did not return an identifiable background-session ID; launch confirmation failed.')
		const childAddress = await (dependencies.confirmChild ?? confirmChildLaunch)(executable, shortID, environment)
		const parsedChildAddress = parseAddress(childAddress)
		if (
			parsedChildAddress.length !== parent.address.length + 1
			|| !parent.address.every((segment, index) => parsedChildAddress[index] === segment)
		) {
			throw new HierarchyAllocationError('Claude background session confirmed an address outside the launcher parent lineage.')
		}
		write(`Confirmed Claude background session at Zettelkasten address ${childAddress}.\n`)
		return { parentAddress, childAddress }
	} catch (error) {
		const stop = dependencies.stopChild ?? stopChildLaunch
		if (!shortID || !stop(executable, shortID)) {
			throw new HierarchyAllocationError('Claude background-session launch failed and cleanup could not be verified.')
		}
		if (!(dependencies.discardReceipt ?? discardLaunchReceipt)(executable, shortID, environment)) {
			throw new HierarchyAllocationError('Claude background-session launch failed and receipt cleanup could not be verified.')
		}
		throw error
	}
}

async function run(): Promise<void> {
	try {
		await launchBackgroundSession(process.argv.slice(2).join(' '), process.env)
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Claude background-session launch failed safely.'
		process.stderr.write(`${message}\n`)
		process.exitCode = 1
	}
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined
if (invokedPath === fileURLToPath(import.meta.url)) await run()
