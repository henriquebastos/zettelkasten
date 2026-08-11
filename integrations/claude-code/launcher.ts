import { spawnSync } from 'node:child_process'
import { accessSync, constants, readFileSync, realpathSync, unlinkSync } from 'node:fs'
import { delimiter, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
	HierarchyAllocationError,
	assignmentFileName,
	displayCacheDirectory,
	parseAddress,
} from './index.ts'

interface LauncherEnvironment {
	ZETTELKASTEN_CLAUDE_SESSION_ID?: string
	ZETTELKASTEN_CLAUDE_ADDRESS?: string
	ZETTELKASTEN_CLAUDE_USE_INSTALLED_PLUGIN?: string
	HOME?: string
	XDG_CACHE_HOME?: string
	PATH?: string
}

interface LauncherDependencies {
	spawn?: (command: string, args: string[]) => { error?: Error; status: number | null; stdout?: string; stderr?: string }
	write?: (message: string) => void
	pluginDirectory?: string
	resolveClaude?: (environment: LauncherEnvironment) => string
	validateClaude?: (executable: string) => void
	confirmChild?: (
		executable: string,
		shortID: string,
		environment: LauncherEnvironment,
		observeSessionID: (sessionID: string) => void,
	) => Promise<string>
	stopChild?: (executable: string, shortID: string) => boolean
	discardReceipt?: (sessionID: string, environment: LauncherEnvironment) => boolean
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
		env: claudeSubprocessEnvironment(process.env),
		timeout,
		killSignal: 'SIGKILL',
		maxBuffer: 1024 * 1024,
	})
}

export function claudeSubprocessEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const normalized = { ...environment }
	delete normalized.FORCE_COLOR
	delete normalized.NO_COLOR
	if (normalized.ZETTELKASTEN_CLAUDE_USE_INSTALLED_PLUGIN === '1') {
		delete normalized.ZETTELKASTEN_SERVICE_URL
		delete normalized.ZETTELKASTEN_NAMESPACE_ID
		delete normalized.ZETTELKASTEN_NAMESPACE_CAPABILITY
		delete normalized.CLAUDE_PLUGIN_OPTION_SERVICE_URL
		delete normalized.CLAUDE_PLUGIN_OPTION_NAMESPACE_ID
		delete normalized.CLAUDE_PLUGIN_OPTION_NAMESPACE_CAPABILITY
	}
	return normalized
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

function commandTimedOut(error?: Error): boolean {
	return error instanceof Error && 'code' in error && error.code === 'ETIMEDOUT'
}

export async function confirmChildLaunch(
	executable: string,
	shortID: string,
	environment: LauncherEnvironment,
	observeSessionID: (sessionID: string) => void = () => {},
): Promise<string> {
	const cacheDirectory = displayCacheDirectory(environment)
	if (!cacheDirectory) throw new HierarchyAllocationError('No user cache directory is available for launch confirmation.')
	const deadline = Date.now() + 30_000
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
					observeSessionID(sessionID)
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
	throw new HierarchyAllocationError('Claude background session did not confirm hierarchy initialization within 30 seconds.')
}

export function stopChildLaunch(
	executable: string,
	shortID: string,
	run: (args: string[], timeout: number) => CommandResult = (args, timeout) => runClaude(executable, args, timeout),
): boolean {
	const deadline = Date.now() + 5_000
	const stopped = run(['stop', shortID], 2_000)
	const exactStopOutput = stopped.stdout === `stopped ${shortID}\n` || stopped.stdout === `stopped ${shortID}`
	const stopAcknowledged = (!stopped.error && stopped.status === 0)
		|| (commandTimedOut(stopped.error) && exactStopOutput)
	if (!stopAcknowledged) return false
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

export function discardLaunchReceipt(sessionID: string, environment: LauncherEnvironment): boolean {
	const cacheDirectory = displayCacheDirectory(environment)
	if (!cacheDirectory) return false
	try {
		unlinkSync(resolve(cacheDirectory, 'launch-receipts', assignmentFileName(sessionID)))
		return true
	} catch (error) {
		return error instanceof Error && 'code' in error && error.code === 'ENOENT'
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
	const parentAddress = environment.ZETTELKASTEN_CLAUDE_ADDRESS ?? ''
	let parsedParentAddress
	try {
		parsedParentAddress = parseAddress(parentAddress)
	} catch {
		throw new HierarchyAllocationError('No authoritative parent Zettelkasten address is available; launch was deferred.')
	}
	const write = dependencies.write ?? ((message: string) => { process.stdout.write(message) })
	write(`Launching a child of Zettelkasten address ${parentAddress} as a Claude background session.\n`)
	const pluginDirectory = dependencies.pluginDirectory ?? fileURLToPath(new URL('.', import.meta.url))
	const executable = (dependencies.resolveClaude ?? resolveClaudeExecutable)(environment)
	const validate = dependencies.validateClaude ?? validateClaudeRuntime
	validate(executable)
	const launchSettings = JSON.stringify({ env: { ZETTELKASTEN_CLAUDE_PARENT_SESSION_ID: parentSessionID } })
	const pluginArguments = environment.ZETTELKASTEN_CLAUDE_USE_INSTALLED_PLUGIN === '1'
		? []
		: ['--plugin-dir', pluginDirectory]
	const spawned = (dependencies.spawn ?? ((command, args) => runClaude(command, args, 12_000)))(
		executable,
		['--bg', '--settings', launchSettings, ...pluginArguments, '--', prompt.trim()],
	)
	const outputLines = spawned.stdout?.split(/\r?\n/) ?? []
	const dispatchAcknowledgments = outputLines
		.map((line) => line.match(/^backgrounded · ([0-9a-f]{8})$/)?.[1])
		.filter((id): id is string => id !== undefined)
	let shortID = outputLines[0]?.match(/^backgrounded · ([0-9a-f]{8})$/)?.[1]
	if (dispatchAcknowledgments.length !== 1) shortID = undefined
	let childSessionID: string | undefined
	try {
		if (spawned.stdout) write(spawned.stdout)
		if (spawned.stderr) (dependencies.write ? write(spawned.stderr) : process.stderr.write(spawned.stderr))
		const timedOutAfterDispatch = shortID && commandTimedOut(spawned.error)
		const dispatchAccepted = (!spawned.error && spawned.status === 0) || timedOutAfterDispatch
		if (!shortID) throw new HierarchyAllocationError('Claude did not return an identifiable background-session ID; launch confirmation failed.')
		const childAddress = await (dependencies.confirmChild ?? confirmChildLaunch)(
			executable,
			shortID,
			environment,
			(sessionID) => { childSessionID = sessionID },
		)
		const parsedChildAddress = parseAddress(childAddress)
		if (
			parsedChildAddress.length !== parsedParentAddress.length + 1
			|| !parsedParentAddress.every((segment, index) => parsedChildAddress[index] === segment)
		) {
			throw new HierarchyAllocationError('Claude background session confirmed an address outside the launcher parent lineage.')
		}
		if (!dispatchAccepted) throw new HierarchyAllocationError('Claude background-session startup failed.')
		write(`Confirmed Claude background session at Zettelkasten address ${childAddress}.\n`)
		return { parentAddress, childAddress }
	} catch (error) {
		const stop = dependencies.stopChild ?? stopChildLaunch
		if (!shortID || !stop(executable, shortID)) {
			throw new HierarchyAllocationError('Claude background-session launch failed and cleanup could not be verified.')
		}
		if (!childSessionID || !(dependencies.discardReceipt ?? discardLaunchReceipt)(childSessionID, environment)) {
			throw new HierarchyAllocationError('Claude background-session launch failed and receipt cleanup could not be verified.')
		}
		const reason = error instanceof Error ? error.message : 'Claude background-session launch failed safely.'
		throw new HierarchyAllocationError(`${reason} Native child cleanup was verified.`)
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
