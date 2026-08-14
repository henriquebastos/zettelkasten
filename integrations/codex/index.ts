import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { chmod, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * True when this module is the process entry point. Node resolves symlinks for `import.meta.url`
 * while `argv[1]` keeps the caller's lexical path, so a plugin root reached through a symlink makes
 * a lexical comparison disagree and silently skip the hook. Both sides are resolved to real paths
 * so that installation shape cannot decide whether a hook runs.
 */
export function invokedDirectly(moduleURL: string): boolean {
	const invoked = process.argv[1]
	if (!invoked) return false
	try {
		return realpathSync(resolve(invoked)) === realpathSync(fileURLToPath(moduleURL))
	} catch {
		return false
	}
}

export type Address = readonly [number, ...(number | string)[]]

interface Assignment {
	key: string
	parentKey: string | null
	address: string
}

export interface NativeThread {
	id: string
	parentThreadId: string | null
	forkedFromId: string | null
	name: string | null
}

export interface NativeThreads {
	read(threadID: string): Promise<NativeThread>
	setName(threadID: string, name: string): Promise<void>
}

export type LauncherParent = (nativeID: string) => Promise<string | null>

interface RuntimeEnvironment {
	CODEX_HOME?: string
	HOME?: string
	ZETTELKASTEN_SERVICE_URL?: string
	ZETTELKASTEN_NAMESPACE_ID?: string
	ZETTELKASTEN_NAMESPACE_CAPABILITY?: string
}

export interface Configuration {
	serviceURL: string
	namespaceID: string
	capability: string
}

interface SessionStartInput {
	hook_event_name: 'SessionStart'
	session_id: string
}

interface SubagentInput {
	hook_event_name: 'SubagentStart' | 'SubagentStop'
	session_id: string
	agent_id: string
}

export type HookInput = SessionStartInput | SubagentInput

interface HookOutput {
	continue?: boolean
	stopReason?: string
	systemMessage?: string
	hookSpecificOutput?: {
		hookEventName: 'SessionStart' | 'SubagentStart'
		additionalContext: string
	}
}

interface HookDependencies {
	request?: typeof fetch
	native?: NativeThreads
	configuration?: Configuration
	signal?: AbortSignal
	deferName?: (nativeID: string, name: string) => Promise<void>
}

export class HierarchyError extends Error {
	readonly status?: number
	readonly code?: string

	constructor(message: string, status?: number, code?: string) {
		super(message)
		this.name = 'HierarchyError'
		this.status = status
		this.code = code
	}
}

export function parseAddress(value: string): Address {
	if (!/^[1-9][0-9]*(?:[a-z]+[1-9][0-9]*)*(?:[a-z]+)?$/.test(value)) throw new Error('invalid address')
	const segments = value.match(/[0-9]+|[a-z]+/g) ?? []
	for (const segment of segments) {
		if (/^[0-9]/.test(segment) && !Number.isSafeInteger(Number(segment))) throw new Error('invalid address')
		if (/^[a-z]/.test(segment)) {
			let ordinal = 0
			for (const character of segment) {
				ordinal = ordinal * 26 + character.charCodeAt(0) - 96
				if (!Number.isSafeInteger(ordinal)) throw new Error('invalid address')
			}
		}
	}
	return segments.map((segment) => /^[0-9]/.test(segment) ? Number(segment) : segment) as unknown as Address
}

function directChild(parent: Address, child: Address): boolean {
	return child.length === parent.length + 1 && parent.every((segment, index) => child[index] === segment)
}

export function formatThreadName(address: Address, currentName: string | null): string {
	const canonical = address.join('')
	const name = currentName?.trim() ?? ''
	if (!name) return canonical
	if (name === canonical) return canonical
	const separator = name.indexOf(' ')
	const prefix = separator === -1 ? name : name.slice(0, separator)
	const semantic = prefix === canonical ? name.slice(separator + 1).trim() : name
	return semantic ? `${canonical} ${semantic}` : canonical
}

export class RemoteHierarchy {
	private readonly configuration: Configuration
	private readonly request: typeof fetch
	private readonly signal?: AbortSignal

	constructor(
		configuration: Configuration,
		request: typeof fetch = fetch,
		signal?: AbortSignal,
	) {
		this.configuration = configuration
		this.request = request
		this.signal = signal
	}

	async resolve(nativeID: string): Promise<{ parentNativeID: string | null; address: Address }> {
		const assignment = await this.call(nativeID)
		return { parentNativeID: this.nativeParent(assignment.parentKey), address: assignment.address }
	}

	async allocate(nativeID: string, parentNativeID: string | null): Promise<Address> {
		let failure: unknown
		for (let attempt = 0; attempt < 2; attempt += 1) {
			try {
				const assignment = await this.call(nativeID, parentNativeID)
				if (this.nativeParent(assignment.parentKey) !== parentNativeID) throw new HierarchyError('Hierarchy service returned conflicting Codex parentage.')
				return assignment.address
			} catch (error) {
				if (!(error instanceof HierarchyError) || (error.status !== undefined && error.status >= 400 && error.status < 500)) throw error
				failure = error
			}
			try {
				const recovered = await this.resolve(nativeID)
				if (recovered.parentNativeID !== parentNativeID) throw new HierarchyError('Recovered hierarchy assignment has conflicting parentage.')
				return recovered.address
			} catch (error) {
				if (!(error instanceof HierarchyError && error.status === 404 && error.code === 'element_not_found')) throw error
			}
		}
		throw failure
	}

	private key(nativeID: string): string {
		if (!this.configuration.serviceURL || !this.configuration.namespaceID || !this.configuration.capability) {
			throw new HierarchyError('Zettelkasten Codex configuration is incomplete; numbering was deferred.')
		}
		if (!nativeID) throw new HierarchyError('Codex supplied an empty native thread ID.')
		return `codex:${nativeID}`
	}

	private nativeParent(parentKey: string | null): string | null {
		if (parentKey === null) return null
		if (!parentKey.startsWith('codex:') || parentKey.length === 6) throw new HierarchyError('Hierarchy service returned a parent outside the Codex identity domain.')
		return parentKey.slice(6)
	}

	private async call(nativeID: string, parentNativeID?: string | null): Promise<{ parentKey: string | null; address: Address }> {
		const key = this.key(nativeID)
		const resolving = parentNativeID === undefined
		let response: Response
		try {
			response = await this.request(`${this.configuration.serviceURL}/v1/namespaces/${this.configuration.namespaceID}/elements${resolving ? '/resolve' : ''}`, {
				method: 'POST',
				headers: { authorization: `Bearer ${this.configuration.capability}`, 'content-type': 'application/json' },
				body: JSON.stringify(resolving ? { key } : { key, parentKey: parentNativeID === null ? null : this.key(parentNativeID) }),
				signal: this.signal ?? AbortSignal.timeout(7_000),
			})
		} catch {
			throw new HierarchyError('Hierarchy service is unavailable; numbering was deferred.')
		}
		let body: unknown
		try { body = await response.json() } catch { throw new HierarchyError('Hierarchy service returned an invalid response.', response.status) }
		if (response.status !== 200 && (resolving || response.status !== 201)) {
			const code = body && typeof body === 'object' && typeof Reflect.get(body, 'code') === 'string' ? Reflect.get(body, 'code') as string : undefined
			throw new HierarchyError(`Hierarchy service rejected ${resolving ? 'resolution' : 'allocation'}${code ? ` (${code})` : ''}.`, response.status, code)
		}
		const value = body as Partial<Assignment>
		if (!body || typeof body !== 'object' || Array.isArray(body) || value.key !== key || (value.parentKey !== null && typeof value.parentKey !== 'string') || typeof value.address !== 'string') {
			throw new HierarchyError('Hierarchy service returned a conflicting assignment.')
		}
		try { return { parentKey: value.parentKey, address: parseAddress(value.address) } } catch { throw new HierarchyError('Hierarchy service returned an invalid address.') }
	}
}

export class CodexAppServer implements NativeThreads {
	private readonly process: ChildProcessWithoutNullStreams
	private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
	private nextID = 0
	private readonly initialized: Promise<void>

	constructor(disableHooks = false, signal?: AbortSignal) {
		this.process = spawn('codex', ['app-server', ...(disableHooks ? ['--disable', 'hooks'] : [])], { stdio: ['pipe', 'pipe', 'pipe'] })
		this.process.stderr.resume()
		createInterface({ input: this.process.stdout }).on('line', (line) => {
			let message: { id?: number; result?: unknown; error?: { message: string } }
			try { message = JSON.parse(line) as typeof message }
			catch {
				this.fail(new HierarchyError('Codex app-server returned malformed JSON.'))
				return
			}
			if (message.id === undefined) return
			const pending = this.pending.get(message.id)
			if (!pending) return
			this.pending.delete(message.id)
			message.error ? pending.reject(new HierarchyError(`Codex app-server rejected a request: ${message.error.message}`)) : pending.resolve(message.result)
		})
		this.process.on('error', (error) => this.rejectAll(error))
		this.process.on('exit', () => this.rejectAll(new HierarchyError('Codex app-server exited unexpectedly.')))
		if (signal) {
			const abort = () => this.fail(new HierarchyError('Codex hierarchy reconciliation exceeded its internal deadline.'))
			signal.aborted ? abort() : signal.addEventListener('abort', abort, { once: true })
		}
		this.initialized = this.request('initialize', { clientInfo: { name: 'zettelkasten_hierarchy', title: 'Zettelkasten hierarchy', version: '0.1.0' } })
			.then(() => { this.notify('initialized') })
	}

	async read(threadID: string): Promise<NativeThread> {
		await this.initialized
		const result = await this.request('thread/read', { threadId: threadID, includeTurns: false }) as { thread: NativeThread }
		const thread = result?.thread
		if (!thread || thread.id !== threadID) throw new HierarchyError('Codex app-server returned a conflicting thread record.')
		return { id: thread.id, parentThreadId: thread.parentThreadId ?? null, forkedFromId: thread.forkedFromId ?? null, name: thread.name ?? null }
	}

	async setName(threadID: string, name: string): Promise<void> {
		await this.initialized
		await this.request('thread/name/set', { threadId: threadID, name })
	}

	async fork(threadID: string): Promise<string> {
		await this.initialized
		const result = await this.request('thread/fork', { threadId: threadID }) as { thread: { id: string } }
		if (!result.thread.id) throw new HierarchyError('Codex did not return an owned fork ID.')
		return result.thread.id
	}

	async start(cwd: string): Promise<string> {
		await this.initialized
		const result = await this.request('thread/start', { cwd, serviceName: 'zettelkasten_launcher' }) as { thread: { id: string } }
		if (!result.thread.id) throw new HierarchyError('Codex did not return an owned root thread ID.')
		return result.thread.id
	}

	async close(): Promise<void> {
		if (this.process.exitCode !== null) return
		await new Promise<void>((resolveClose) => {
			const timer = setTimeout(() => { this.process.kill('SIGKILL'); resolveClose() }, 2_000)
			this.process.once('close', () => { clearTimeout(timer); resolveClose() })
			this.process.stdin.end()
		})
	}

	private request(method: string, params: unknown): Promise<unknown> {
		const id = ++this.nextID
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id)
				this.fail(new HierarchyError(`Codex app-server timed out during ${method}.`))
				reject(new HierarchyError(`Codex app-server timed out during ${method}.`))
			}, 6_000)
			this.pending.set(id, {
				resolve: (value) => { clearTimeout(timer); resolve(value) },
				reject: (error) => { clearTimeout(timer); reject(error) },
			})
			this.process.stdin.write(`${JSON.stringify({ method, id, params })}\n`, (error) => {
				if (error) this.fail(error)
			})
		})
	}

	private notify(method: string): void { this.process.stdin.write(`${JSON.stringify({ method, params: {} })}\n`) }
	private rejectAll(error: Error): void { for (const pending of this.pending.values()) pending.reject(error); this.pending.clear() }
	private fail(error: Error): void { this.rejectAll(error); if (this.process.exitCode === null) this.process.kill('SIGKILL') }
}

export function configurationDirectory(environment: RuntimeEnvironment): string | undefined {
	if (environment.CODEX_HOME && isAbsolute(environment.CODEX_HOME)) return resolve(environment.CODEX_HOME, 'zettelkasten')
	return environment.HOME && isAbsolute(environment.HOME) ? resolve(environment.HOME, '.codex', 'zettelkasten') : undefined
}

function provenancePath(directory: string, nativeID: string): string {
	return resolve(directory, 'launcher-provenance', Buffer.from(nativeID).toString('base64url'))
}

async function verifyPrivatePath(path: string, directory: boolean): Promise<boolean> {
	let value
	try { value = await lstat(path) }
	catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
		throw error
	}
	const expectedType = directory ? value.isDirectory() : value.isFile()
	const owned = process.getuid === undefined || value.uid === process.getuid()
	if (value.isSymbolicLink() || !expectedType || !owned || (value.mode & 0o077) !== 0) {
		throw new HierarchyError(`Codex Zettelkasten ${directory ? 'directory' : 'file'} is not private and user-owned.`)
	}
	return true
}

export async function storeLauncherParent(environment: RuntimeEnvironment, nativeID: string, parentNativeID: string): Promise<void> {
	const directory = configurationDirectory(environment)
	if (!directory) throw new HierarchyError('No private Codex configuration directory is available for launcher provenance.')
	const parent = resolve(directory, 'launcher-provenance')
	await mkdir(parent, { recursive: true, mode: 0o700 })
	await chmod(parent, 0o700)
	const destination = provenancePath(directory, nativeID)
	const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`
	await writeFile(temporary, `${parentNativeID}\n`, { mode: 0o600, flag: 'wx' })
	await rename(temporary, destination)
}

export async function loadLauncherParent(environment: RuntimeEnvironment, nativeID: string): Promise<string | null> {
	const directory = configurationDirectory(environment)
	if (!directory) return null
	if (!await verifyPrivatePath(directory, true)) return null
	const parentDirectory = resolve(directory, 'launcher-provenance')
	if (!await verifyPrivatePath(parentDirectory, true)) return null
	const path = provenancePath(directory, nativeID)
	try {
		if (!await verifyPrivatePath(path, false)) return null
		const value = (await readFile(path, 'utf8')).trim()
		return value || null
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
		throw error
	}
}

export async function loadConfiguration(environment: RuntimeEnvironment): Promise<Configuration> {
	const directory = configurationDirectory(environment)
	if (directory && await verifyPrivatePath(directory, true)) {
		const readOptional = async (path: string): Promise<string | undefined> => {
			if (!await verifyPrivatePath(path, false)) return undefined
			return await readFile(path, 'utf8')
		}
		const settingsText = await readOptional(resolve(directory, 'config.json'))
		const capabilityText = await readOptional(resolve(directory, 'capability'))
		if (settingsText !== undefined || capabilityText !== undefined) {
			const settings = settingsText === undefined ? {} : JSON.parse(settingsText) as { serviceURL?: unknown; namespaceID?: unknown }
			return {
				serviceURL: typeof settings.serviceURL === 'string' ? settings.serviceURL.trim() : '',
				namespaceID: typeof settings.namespaceID === 'string' ? settings.namespaceID.trim() : '',
				capability: capabilityText?.trim() ?? '',
			}
		}
	}
	return {
		serviceURL: environment.ZETTELKASTEN_SERVICE_URL?.trim() ?? '',
		namespaceID: environment.ZETTELKASTEN_NAMESPACE_ID?.trim() ?? '',
		capability: environment.ZETTELKASTEN_NAMESPACE_CAPABILITY?.trim() ?? '',
	}
}

function nativeParent(thread: NativeThread): string | null {
	if (thread.parentThreadId && thread.forkedFromId && thread.parentThreadId !== thread.forkedFromId) {
		throw new HierarchyError('Codex returned conflicting native parent provenance.')
	}
	return thread.parentThreadId ?? thread.forkedFromId
}

function validateLineage(parent: { address: Address } | null, address: Address): void {
	if (parent === null ? address.length !== 1 : !directChild(parent.address, address)) {
		throw new HierarchyError('Hierarchy service returned an address outside the native Codex parent lineage.')
	}
}

export async function deferThreadName(nativeID: string, name: string): Promise<void> {
	await new Promise<void>((resolveWrite, reject) => {
		const child = spawn(process.execPath, [fileURLToPath(new URL('deferred-name.ts', import.meta.url))], {
			detached: true,
			stdio: ['pipe', 'ignore', 'ignore'],
		})
		child.once('error', reject)
		child.stdin.end(JSON.stringify({ nativeID, name }), () => {
			child.unref()
			resolveWrite()
		})
	})
}

export async function reconcileThread(
	nativeID: string,
	native: NativeThreads,
	hierarchy: RemoteHierarchy,
	launcherParent: LauncherParent = async () => null,
	visiting = new Set<string>(),
): Promise<{ address: Address; thread: NativeThread }> {
	if (visiting.has(nativeID) || visiting.size >= 64) throw new HierarchyError('Codex returned cyclic or over-deep native ancestry.')
	visiting.add(nativeID)
	try {
		const thread = await native.read(nativeID)
		const nativeParentID = nativeParent(thread)
		let address: Address
		let parentID: string | null
		try {
			const existing = await hierarchy.resolve(nativeID)
			if (nativeParentID !== null && existing.parentNativeID !== nativeParentID) throw new HierarchyError('Remote and native Codex parentage conflict.')
			if (nativeParentID === null && existing.parentNativeID !== null) {
				const trustedParentID = await launcherParent(nativeID)
				if (trustedParentID !== existing.parentNativeID) throw new HierarchyError('Remote Codex parentage has no matching launcher provenance.')
			}
			parentID = nativeParentID ?? existing.parentNativeID
			address = existing.address
		} catch (error) {
			if (!(error instanceof HierarchyError && error.status === 404 && error.code === 'element_not_found')) throw error
			parentID = nativeParentID
			const parent = parentID === null ? null : await reconcileThread(parentID, native, hierarchy, launcherParent, visiting)
			address = await hierarchy.allocate(nativeID, parentID)
			validateLineage(parent, address)
			return { address, thread }
		}
		const parent = parentID === null ? null : await reconcileThread(parentID, native, hierarchy, launcherParent, visiting)
		validateLineage(parent, address)
		return { address, thread }
	} finally { visiting.delete(nativeID) }
}

export async function handleHook(input: HookInput, environment: RuntimeEnvironment, dependencies: HookDependencies = {}): Promise<HookOutput> {
	const nativeID = input.hook_event_name === 'SessionStart' ? input.session_id : input.agent_id
	let native = dependencies.native
	try {
		const signal = dependencies.signal ?? AbortSignal.timeout(14_000)
		const configuration = dependencies.configuration ?? await loadConfiguration(environment)
		if (!configuration.serviceURL || !configuration.namespaceID || !configuration.capability) throw new HierarchyError('Zettelkasten Codex configuration is incomplete; run the installed configure command before starting a session.')
		native ??= new CodexAppServer(false, signal)
		const result = await reconcileThread(
			nativeID,
			native,
			new RemoteHierarchy(configuration, dependencies.request, signal),
			(id) => loadLauncherParent(environment, id),
		)
		const address = result.address.join('')
		const name = formatThreadName(result.address, result.thread.name)
		await native.setName(nativeID, name)
		if (input.hook_event_name === 'SubagentStop') {
			await (dependencies.deferName ?? deferThreadName)(nativeID, name)
			return { systemMessage: `Zettelkasten address: ${address}` }
		}
		return {
			systemMessage: `Zettelkasten address: ${address}`,
			hookSpecificOutput: {
				hookEventName: input.hook_event_name,
				additionalContext: input.hook_event_name === 'SessionStart'
					? `Zettelkasten address: ${address}. To create a native child thread, run node "${fileURLToPath(new URL('launcher.ts', import.meta.url))}" "<task>" outside the tool sandbox (request explicit elevation when required), because Codex must write its own user-local history. The launcher uses CODEX_THREAD_ID and never model-supplied identity.`
					: `Zettelkasten address: ${address}.`,
			},
		}
	} catch (error) {
		const message = error instanceof HierarchyError ? error.message : 'Zettelkasten numbering was deferred because the Codex integration failed safely.'
		return input.hook_event_name === 'SessionStart'
			? { continue: false, stopReason: message, systemMessage: message }
			: { systemMessage: message }
	} finally {
		if (native instanceof CodexAppServer) await native.close()
	}
}

async function run(): Promise<void> {
	let raw = ''
	for await (const chunk of process.stdin) raw += chunk
	try { process.stdout.write(JSON.stringify(await handleHook(JSON.parse(raw) as HookInput, process.env))) }
	catch { process.stdout.write(JSON.stringify({ continue: false, stopReason: 'Codex supplied invalid hook input.' })) }
}

if (invokedDirectly(import.meta.url)) await run()
