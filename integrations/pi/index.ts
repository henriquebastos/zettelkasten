import { lstat, open, readFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'

export type Address = Array<number | string>

export interface Configuration {
	serviceURL: string
	namespaceID: string
	capability: string
}

export interface RuntimeEnvironment {
	PI_CODING_AGENT_DIR?: string
	HOME?: string
	ZETTELKASTEN_SERVICE_URL?: string
	ZETTELKASTEN_NAMESPACE_ID?: string
	ZETTELKASTEN_NAMESPACE_CAPABILITY?: string
}

export interface SessionHeader {
	type: 'session'
	id: string
	parentSession?: string
}

interface SessionManagerLike {
	getSessionId(): string
	getSessionFile(): string | undefined
	getHeader(): SessionHeader | null
}

interface ExtensionContextLike {
	cwd: string
	hasUI: boolean
	ui: { notify(message: string, level: 'info' | 'error'): void }
	sessionManager: SessionManagerLike
}

interface CommandContextLike extends ExtensionContextLike {
	waitForIdle(): Promise<void>
	newSession(options: {
		parentSession: string
		withSession: (context: { sendUserMessage(message: string): Promise<void> }) => Promise<void>
	}): Promise<{ cancelled: boolean }>
}

interface ExtensionAPILike {
	on(event: 'session_start', handler: (_event: unknown, context: ExtensionContextLike) => Promise<void>): void
	on(event: 'session_info_changed', handler: (event: { name: string | undefined }, context: ExtensionContextLike) => Promise<void>): void
	on(event: 'session_before_compact', handler: (_event: unknown, context: ExtensionContextLike) => Promise<{ cancel: boolean } | undefined>): void
	on(event: 'session_before_tree', handler: (event: { preparation: { userWantsSummary: boolean } }, context: ExtensionContextLike) => Promise<{ cancel: boolean } | undefined>): void
	on(event: 'input', handler: (_event: unknown, context: ExtensionContextLike) => Promise<{ action: 'continue' | 'handled' }>): void
	on(event: 'before_agent_start', handler: (_event: unknown, context: ExtensionContextLike) => Promise<unknown>): void
	registerCommand(name: string, options: { description: string; handler: (args: string, context: CommandContextLike) => Promise<void> }): void
	setSessionName(name: string): void
	getSessionName(): string | undefined
}

interface Assignment {
	key: string
	parentKey: string | null
	address: string
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
	return segments.map((segment) => /^[0-9]/.test(segment) ? Number(segment) : segment) as Address
}

function directChild(parent: Address, child: Address): boolean {
	return child.length === parent.length + 1 && parent.every((segment, index) => child[index] === segment)
}

export function formatSessionName(address: Address, currentName: string | undefined): string {
	const canonical = address.join('')
	const name = currentName?.trim() ?? ''
	if (!name || name === canonical) return canonical
	const separator = name.indexOf(' ')
	const prefix = separator === -1 ? name : name.slice(0, separator)
	let semantic = name
	try { parseAddress(prefix); semantic = separator === -1 ? '' : name.slice(separator + 1).trim() } catch {}
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
				if (this.nativeParent(assignment.parentKey) !== parentNativeID) throw new HierarchyError('Hierarchy service returned conflicting Pi parentage.')
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
		if (!this.configuration.serviceURL || !this.configuration.namespaceID || !this.configuration.capability) throw new HierarchyError('Zettelkasten Pi configuration is incomplete; numbering was deferred.')
		if (!nativeID) throw new HierarchyError('Pi supplied an empty native session ID.')
		return `pi:${nativeID}`
	}

	private nativeParent(parentKey: string | null): string | null {
		if (parentKey === null) return null
		if (!parentKey.startsWith('pi:') || parentKey.length === 3) throw new HierarchyError('Hierarchy service returned a parent outside the Pi identity domain.')
		return parentKey.slice(3)
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
		if (!body || typeof body !== 'object' || Array.isArray(body) || value.key !== key || (value.parentKey !== null && typeof value.parentKey !== 'string') || typeof value.address !== 'string') throw new HierarchyError('Hierarchy service returned a conflicting assignment.')
		try { return { parentKey: value.parentKey, address: parseAddress(value.address) } } catch { throw new HierarchyError('Hierarchy service returned an invalid address.') }
	}
}

export function configurationDirectory(environment: RuntimeEnvironment): string {
	assertSupportedPlatform()
	if (environment.PI_CODING_AGENT_DIR) {
		if (!isAbsolute(environment.PI_CODING_AGENT_DIR)) throw new HierarchyError('PI_CODING_AGENT_DIR must be an absolute path for Zettelkasten configuration.')
		return resolve(environment.PI_CODING_AGENT_DIR, 'zettelkasten')
	}
	const home = environment.HOME && isAbsolute(environment.HOME) ? environment.HOME : homedir()
	return resolve(home, '.pi', 'agent', 'zettelkasten')
}

export function assertSupportedPlatform(platform: NodeJS.Platform = process.platform): void {
	if (platform === 'win32') throw new HierarchyError('Native Windows is unsupported because Pi Zettelkasten requires POSIX file permissions and no-follow session reads; use WSL, Linux, or macOS.')
}

async function readPrivate(path: string, directory: boolean): Promise<string | undefined> {
	let value
	try { value = await lstat(path) }
	catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
		throw error
	}
	const expectedType = directory ? value.isDirectory() : value.isFile()
	const owned = process.getuid === undefined || value.uid === process.getuid()
	if (value.isSymbolicLink() || !expectedType || !owned || (value.mode & 0o077) !== 0) throw new HierarchyError(`Pi Zettelkasten ${directory ? 'directory' : 'file'} is not private and user-owned.`)
	return directory ? '' : await readFile(path, 'utf8')
}

export async function loadConfiguration(environment: RuntimeEnvironment): Promise<Configuration> {
	const directory = configurationDirectory(environment)
	if (await readPrivate(directory, true) !== undefined) {
		const settingsText = await readPrivate(resolve(directory, 'config.json'), false)
		const capabilityText = await readPrivate(resolve(directory, 'capability'), false)
		if (settingsText !== undefined || capabilityText !== undefined) {
			let settings: Partial<Configuration> = {}
			try { settings = JSON.parse(settingsText ?? '{}') as Partial<Configuration> } catch { throw new HierarchyError('Pi Zettelkasten configuration is invalid.') }
			return { serviceURL: settings.serviceURL?.trim() ?? '', namespaceID: settings.namespaceID?.trim() ?? '', capability: capabilityText?.trim() ?? '' }
		}
	}
	return {
		serviceURL: environment.ZETTELKASTEN_SERVICE_URL?.trim() ?? '',
		namespaceID: environment.ZETTELKASTEN_NAMESPACE_ID?.trim() ?? '',
		capability: environment.ZETTELKASTEN_NAMESPACE_CAPABILITY?.trim() ?? '',
	}
}

export async function readSessionHeader(path: string): Promise<SessionHeader> {
	if (!isAbsolute(path)) throw new HierarchyError('Pi returned a non-absolute parent session path.')
	let file
	try { file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)) }
	catch { throw new HierarchyError('Pi parent session provenance is unavailable or not user-owned.') }
	try {
		const metadata = await file.stat()
		if (!metadata.isFile() || (process.getuid !== undefined && metadata.uid !== process.getuid())) throw new HierarchyError('Pi parent session provenance is unavailable or not user-owned.')
		const buffer = Buffer.alloc(64 * 1024)
		const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
		const line = buffer.subarray(0, bytesRead).toString('utf8').split('\n', 1)[0]
		const value = JSON.parse(line) as Partial<SessionHeader>
		if (value.type !== 'session' || typeof value.id !== 'string' || !value.id || (value.parentSession !== undefined && typeof value.parentSession !== 'string')) throw new Error()
		return value as SessionHeader
	} catch { throw new HierarchyError('Pi parent session header is invalid.') }
	finally { await file.close() }
}

function validateLineage(parent: { address: Address } | null, address: Address): void {
	if (parent === null ? address.length !== 1 : !directChild(parent.address, address)) throw new HierarchyError('Hierarchy service returned an address outside the native Pi parent lineage.')
}

export async function reconcileSession(
	header: SessionHeader,
	hierarchy: RemoteHierarchy,
	visiting = new Set<string>(),
): Promise<{ address: Address }> {
	if (visiting.has(header.id) || visiting.size >= 64) throw new HierarchyError('Pi returned cyclic or over-deep native ancestry.')
	visiting.add(header.id)
	try {
		const parentHeader = header.parentSession ? await readSessionHeader(header.parentSession) : null
		const parent = parentHeader ? await reconcileSession(parentHeader, hierarchy, visiting) : null
		const parentID = parentHeader?.id ?? null
		let address: Address
		try {
			const existing = await hierarchy.resolve(header.id)
			if (existing.parentNativeID !== parentID) throw new HierarchyError('Remote and native Pi parentage conflict.')
			address = existing.address
		} catch (error) {
			if (!(error instanceof HierarchyError && error.status === 404 && error.code === 'element_not_found')) throw error
			address = await hierarchy.allocate(header.id, parentID)
		}
		validateLineage(parent, address)
		return { address }
	} finally { visiting.delete(header.id) }
}

export interface IntegrationDependencies {
	environment?: RuntimeEnvironment
	request?: typeof fetch
	signal?: AbortSignal
}

export function createIntegration(pi: ExtensionAPILike, dependencies: IntegrationDependencies = {}): void {
	let status: { kind: 'pending' } | { kind: 'ready'; address: Address } | { kind: 'failed'; message: string } = { kind: 'pending' }
	const notify = (context: ExtensionContextLike, message: string, level: 'info' | 'error') => {
		if (context.hasUI) { try { context.ui.notify(message, level) } catch {} }
	}

	pi.on('session_start', async (_event, context) => {
		status = { kind: 'pending' }
		try {
			const sessionFile = context.sessionManager.getSessionFile()
			const header = context.sessionManager.getHeader()
			if (!sessionFile || !header) throw new HierarchyError('Zettelkasten requires a persistent Pi session; --no-session is unsupported.')
			if (header.id !== context.sessionManager.getSessionId()) throw new HierarchyError('Pi returned a conflicting native session ID.')
			const configuration = await loadConfiguration(dependencies.environment ?? process.env)
			if (!configuration.serviceURL || !configuration.namespaceID || !configuration.capability) throw new HierarchyError('Zettelkasten Pi configuration is incomplete; run the configure command before starting Pi.')
			const result = await reconcileSession(header, new RemoteHierarchy(configuration, dependencies.request, dependencies.signal))
			pi.setSessionName(formatSessionName(result.address, pi.getSessionName()))
			status = { kind: 'ready', address: result.address }
			notify(context, `Zettelkasten address: ${result.address.join('')}`, 'info')
		} catch (error) {
			const message = error instanceof HierarchyError ? error.message : 'Zettelkasten numbering was deferred because the Pi integration failed safely.'
			status = { kind: 'failed', message }
			notify(context, message, 'error')
		}
	})

	pi.on('input', async (_event, context) => {
		if (status.kind === 'ready') return { action: 'continue' }
		notify(context, status.kind === 'failed' ? status.message : 'Zettelkasten initialization has not completed.', 'error')
		return { action: 'handled' }
	})

	pi.on('session_before_compact', async () => status.kind === 'ready' ? undefined : { cancel: true })

	pi.on('session_before_tree', async (event) => status.kind !== 'ready' && event.preparation.userWantsSummary ? { cancel: true } : undefined)

	pi.on('session_info_changed', async (event) => {
		if (status.kind !== 'ready') return
		const canonical = formatSessionName(status.address, event.name)
		if (canonical !== event.name) pi.setSessionName(canonical)
	})

	pi.on('before_agent_start', async () => status.kind === 'ready'
		? { message: { customType: 'zettelkasten-address', content: `Zettelkasten address: ${status.address.join('')}`, display: false } }
		: undefined)

	pi.registerCommand('zk-child', {
		description: 'Create and enter a persistent native child session',
		handler: async (args, context) => {
			const task = args.trim()
			if (!task) { context.ui.notify('Usage: /zk-child <task>', 'error'); return }
			if (status.kind !== 'ready') { context.ui.notify(status.kind === 'failed' ? status.message : 'Zettelkasten initialization has not completed.', 'error'); return }
			await context.waitForIdle()
			const parentSession = context.sessionManager.getSessionFile()
			if (!parentSession) { context.ui.notify('A persistent parent session is required.', 'error'); return }
			let parentHeader: SessionHeader
			try { parentHeader = await readSessionHeader(parentSession) }
			catch { context.ui.notify('The parent session has not been saved yet; complete its first assistant turn before creating a child.', 'error'); return }
			if (parentHeader.id !== context.sessionManager.getSessionId()) { context.ui.notify('Pi returned conflicting parent-session provenance.', 'error'); return }
			const result = await context.newSession({
				parentSession,
				withSession: async (replacement) => { await replacement.sendUserMessage(task) },
			})
			if (result.cancelled) context.ui.notify('Pi cancelled child-session creation.', 'error')
		},
	})
}

export default function zettelkastenPiExtension(pi: ExtensionAPILike): void {
	createIntegration(pi)
}
