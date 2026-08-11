import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
	CodexAppServer,
	HierarchyError,
	RemoteHierarchy,
	formatThreadName,
	loadLauncherParent,
	loadConfiguration,
	reconcileThread,
	storeLauncherParent,
	type Configuration,
	type NativeThreads,
} from './index.ts'

interface LauncherDependencies {
	native?: NativeThreads & { start(cwd: string): Promise<string>; close?: () => void | Promise<void> }
	configuration?: Configuration
	request?: typeof fetch
	runChild?: (threadID: string, prompt: string) => Promise<number>
	storeParent?: (environment: NodeJS.ProcessEnv, nativeID: string, parentNativeID: string) => Promise<void>
	loadParent?: (environment: NodeJS.ProcessEnv, nativeID: string) => Promise<string | null>
	write?: (message: string) => void
}

export async function runCodexChild(threadID: string, prompt: string): Promise<number> {
	return await new Promise((resolveExit, reject) => {
		const child = spawn('codex', ['exec', 'resume', '--json', threadID, '-'], { stdio: ['pipe', 'pipe', 'pipe'] })
		child.on('error', reject)
		child.on('exit', (code) => resolveExit(code ?? 1))
		child.stdout.resume()
		child.stderr.resume()
		child.stdin.end(prompt)
	})
}

export async function launchChildThread(
	prompt: string,
	environment: NodeJS.ProcessEnv,
	dependencies: LauncherDependencies = {},
): Promise<{ parentAddress: string; childAddress: string }> {
	if (!prompt.trim()) throw new HierarchyError('A child-thread task is required.')
	const parentID = environment.CODEX_THREAD_ID
	if (!parentID) throw new HierarchyError('Codex did not provide CODEX_THREAD_ID; child launch was deferred.')
	const native = dependencies.native ?? new CodexAppServer(true)
	const write = dependencies.write ?? ((message: string) => process.stdout.write(message))
	let closed = false
	try {
		const configuration = dependencies.configuration ?? await loadConfiguration(environment)
		if (!configuration.serviceURL || !configuration.namespaceID || !configuration.capability) throw new HierarchyError('Zettelkasten Codex configuration is incomplete; child launch was deferred.')
		const hierarchy = new RemoteHierarchy(configuration, dependencies.request)
		const parent = await reconcileThread(
			parentID,
			native,
			hierarchy,
			(id) => (dependencies.loadParent ?? loadLauncherParent)(environment, id),
		)
		const childID = await native.start(process.cwd())
		const childAddressValue = await hierarchy.allocate(childID, parentID)
		if (childAddressValue.length !== parent.address.length + 1 || !parent.address.every((segment, index) => childAddressValue[index] === segment)) {
			throw new HierarchyError('Hierarchy service returned an address outside the launcher parent lineage.')
		}
		await (dependencies.storeParent ?? storeLauncherParent)(environment, childID, parentID)
		await native.setName(childID, formatThreadName(childAddressValue, null))
		const parentAddress = parent.address.join('')
		const childAddress = childAddressValue.join('')
		write(`Starting native Codex child ${childAddress} beneath ${parentAddress}.\n`)
		await native.close?.()
		closed = true
		const status = await (dependencies.runChild ?? runCodexChild)(childID, prompt.trim())
		if (status !== 0) throw new HierarchyError(`Codex child ${childAddress} did not complete successfully; its native thread remains resumable.`)
		return { parentAddress, childAddress }
	} finally { if (!closed) await native.close?.() }
}

async function run(): Promise<void> {
	try { await launchChildThread(process.argv.slice(2).join(' '), process.env) }
	catch (error) { process.stderr.write(`${error instanceof Error ? error.message : 'Codex child launch failed safely.'}\n`); process.exitCode = 1 }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined
if (invokedPath === fileURLToPath(import.meta.url)) await run()
