import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { appendFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * True when this module is the process entry point. Node resolves symlinks for `import.meta.url`
 * while `argv[1]` keeps the caller's lexical path, so a plugin root reached through a symlink—for
 * example a `~/.claude` that points into a dotfiles checkout—makes a lexical comparison disagree
 * and silently skip the hook. Both sides are resolved to real paths so that installation shape
 * cannot decide whether a hook runs.
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

interface HierarchyAssignment {
	key: string
	parentKey: string | null
	address: string
}

export interface ResolvedHierarchyAssignment {
	nativeID: string
	parentNativeID: string | null
	address: Address
}

interface SessionStartInput {
	hook_event_name: 'SessionStart'
	session_id: string
	source: 'startup' | 'resume' | 'clear' | 'compact' | 'fork'
	session_title?: string
}

interface SubagentStartInput {
	hook_event_name: 'SubagentStart'
	session_id: string
	agent_id?: string
	agent_type?: string
}

interface UserPromptSubmitInput {
	hook_event_name: 'UserPromptSubmit'
	session_id: string
	prompt: string
}

export type HookInput = SessionStartInput | SubagentStartInput | UserPromptSubmitInput

interface HookOutput {
	continue?: boolean
	stopReason?: string
	systemMessage?: string
	hookSpecificOutput?: {
		hookEventName: 'SessionStart' | 'SubagentStart' | 'UserPromptSubmit'
		sessionTitle?: string
		additionalContext?: string
	}
}

interface RuntimeEnvironment {
	ZETTELKASTEN_SERVICE_URL?: string
	ZETTELKASTEN_NAMESPACE_ID?: string
	ZETTELKASTEN_NAMESPACE_CAPABILITY?: string
	CLAUDE_PLUGIN_OPTION_SERVICE_URL?: string
	CLAUDE_PLUGIN_OPTION_NAMESPACE_ID?: string
	CLAUDE_PLUGIN_OPTION_NAMESPACE_CAPABILITY?: string
	HOME?: string
	XDG_CACHE_HOME?: string
	CLAUDE_ENV_FILE?: string
	ZETTELKASTEN_CLAUDE_PARENT_SESSION_ID?: string
}

interface HookDependencies {
	request?: typeof fetch
	storeAssignment?: (cacheDirectory: string, nativeID: string, address: string) => Promise<void>
	storeLaunchReceipt?: (cacheDirectory: string, nativeID: string, address: string) => Promise<void>
	storePendingTitle?: (cacheDirectory: string, nativeID: string, address: string) => Promise<void>
	consumePendingTitle?: (cacheDirectory: string, nativeID: string) => Promise<string | undefined>
	configureLauncher?: (
		environmentFile: string,
		nativeID: string,
		address: string,
		launcherPath: string,
		useInstalledPlugin: boolean,
	) => Promise<void>
}

export class HierarchyAllocationError extends Error {
	readonly status?: number
	readonly code?: string

	constructor(
		message: string,
		status?: number,
		code?: string,
	) {
		super(message)
		this.name = 'HierarchyAllocationError'
		this.status = status
		this.code = code
	}
}

export class RemoteHierarchyAllocator {
	private readonly serviceURL: string
	private readonly namespaceID: string
	private readonly capability: string
	private readonly request: typeof fetch
	private readonly requestSignal?: AbortSignal

	constructor(
		serviceURL: string,
		namespaceID: string,
		capability: string,
		request: typeof fetch = fetch,
		requestSignal?: AbortSignal,
	) {
		this.serviceURL = serviceURL
		this.namespaceID = namespaceID
		this.capability = capability
		this.request = request
		this.requestSignal = requestSignal
	}

	async allocate(nativeID: string, parentNativeID: string | null): Promise<Address> {
		const key = this.key(nativeID)
		const parentKey = parentNativeID === null ? null : this.key(parentNativeID)
		const assignment = await this.requestAssignment(key, parentKey)
		if (assignment.parentKey !== parentKey) {
			throw new HierarchyAllocationError('Hierarchy service returned a conflicting assignment; numbering was deferred.')
		}
		return assignment.address
	}

	async resolve(nativeID: string, parentNativeID: string | null): Promise<Address> {
		const assignment = await this.resolveAssignment(nativeID)
		if (assignment.parentNativeID !== parentNativeID) {
			throw new HierarchyAllocationError('Hierarchy service returned a conflicting assignment; numbering was deferred.')
		}
		return assignment.address
	}

	async resolveAssignment(nativeID: string): Promise<ResolvedHierarchyAssignment> {
		const key = this.key(nativeID)
		const assignment = await this.requestAssignment(key)
		let parentNativeID: string | null
		if (assignment.parentKey === null) {
			parentNativeID = null
		} else if (assignment.parentKey.startsWith('claude:') && assignment.parentKey.length > 'claude:'.length) {
			parentNativeID = assignment.parentKey.slice('claude:'.length)
		} else {
			throw new HierarchyAllocationError('Hierarchy service returned a parent outside the Claude Code identity domain.')
		}
		return { nativeID, parentNativeID, address: assignment.address }
	}

	private key(nativeID: string): string {
		if (!this.serviceURL || !this.namespaceID || !this.capability) {
			throw new HierarchyAllocationError(
				'Zettelkasten configuration is incomplete. Set ZETTELKASTEN_SERVICE_URL, ZETTELKASTEN_NAMESPACE_ID, and ZETTELKASTEN_NAMESPACE_CAPABILITY.',
			)
		}
		if (!nativeID) throw new HierarchyAllocationError('Claude Code supplied an empty native identifier.')
		return `claude:${nativeID}`
	}

	private async requestAssignment(key: string, parentKey?: string | null): Promise<{ parentKey: string | null; address: Address }> {
		const resolveOnly = parentKey === undefined
		let response: Response
		try {
			response = await this.request(
				`${this.serviceURL}/v1/namespaces/${this.namespaceID}/elements${resolveOnly ? '/resolve' : ''}`,
				{
					method: 'POST',
					headers: {
						authorization: `Bearer ${this.capability}`,
						'content-type': 'application/json',
					},
					body: JSON.stringify(resolveOnly ? { key } : { key, parentKey }),
					signal: this.requestSignal ?? AbortSignal.timeout(7_000),
				},
			)
		} catch {
			throw new HierarchyAllocationError('Hierarchy service is unavailable; numbering was deferred.')
		}

		let body: unknown
		try {
			body = await response.json()
		} catch {
			throw new HierarchyAllocationError('Hierarchy service returned an invalid response; numbering was deferred.', response.status)
		}
		if (response.status !== 200 && (resolveOnly || response.status !== 201)) {
			const code = body && typeof body === 'object' && typeof Reflect.get(body, 'code') === 'string'
				? Reflect.get(body, 'code') as string
				: undefined
			throw new HierarchyAllocationError(
				`Hierarchy service rejected ${resolveOnly ? 'resolution' : 'allocation'}${code ? ` (${code})` : ''}; numbering was deferred.`,
				response.status,
				code,
			)
		}
		if (!body || typeof body !== 'object' || Array.isArray(body)) {
			throw new HierarchyAllocationError('Hierarchy service returned an invalid assignment; numbering was deferred.')
		}
		const assignment = body as Partial<HierarchyAssignment>
		if (
			assignment.key !== key
			|| (assignment.parentKey !== null && typeof assignment.parentKey !== 'string')
			|| typeof assignment.address !== 'string'
		) {
			throw new HierarchyAllocationError('Hierarchy service returned a conflicting assignment; numbering was deferred.')
		}
		try {
			return { parentKey: assignment.parentKey, address: parseAddress(assignment.address) }
		} catch {
			throw new HierarchyAllocationError('Hierarchy service returned an invalid address; numbering was deferred.')
		}
	}
}

export function parseAddress(value: string): Address {
	if (value.length === 0 || value[0] < '1' || value[0] > '9') throw new Error('invalid root segment')
	const segments: Array<number | string> = []
	let position = 0
	while (position < value.length) {
		const expectsDecimal = segments.length % 2 === 0
		const start = position
		while (position < value.length) {
			const character = value[position]!
			if (expectsDecimal ? character >= '0' && character <= '9' : character >= 'a' && character <= 'z') position += 1
			else break
		}
		if (position === start) throw new Error('invalid segment')
		const segment = value.slice(start, position)
		if (expectsDecimal) {
			if (segment[0] === '0') throw new Error('non-canonical decimal segment')
			const parsed = Number(segment)
			if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error('decimal segment outside safe range')
			segments.push(parsed)
		} else {
			let parsed = 0
			for (const character of segment) {
				parsed = parsed * 26 + character.charCodeAt(0) - 96
				if (!Number.isSafeInteger(parsed)) throw new Error('letter segment outside safe range')
			}
			segments.push(segment)
		}
	}
	return segments as unknown as Address
}

function formatAddress(address: Address): string {
	return address.join('')
}

function directChildOf(parent: Address, child: Address): boolean {
	return child.length === parent.length + 1 && parent.every((segment, index) => child[index] === segment)
}

export function formatSessionTitle(address: Address, currentTitle?: string): string {
	const canonicalAddress = formatAddress(address)
	const normalized = currentTitle?.trim() ?? ''
	if (!normalized) return canonicalAddress

	const separator = normalized.indexOf(' ')
	const prefix = separator === -1 ? normalized : normalized.slice(0, separator)
	const semanticTitle = prefix === canonicalAddress
		? (separator === -1 ? '' : normalized.slice(separator + 1).trim())
		: normalized
	return semanticTitle ? `${canonicalAddress} ${semanticTitle}` : canonicalAddress
}

export function displayCacheDirectory(environment: Pick<RuntimeEnvironment, 'HOME' | 'XDG_CACHE_HOME'>): string | undefined {
	const base = environment.XDG_CACHE_HOME && isAbsolute(environment.XDG_CACHE_HOME)
		? environment.XDG_CACHE_HOME
		: environment.HOME && isAbsolute(environment.HOME)
			? resolve(environment.HOME, '.cache')
			: undefined
	return base ? resolve(base, 'zettelkasten', 'claude-code') : undefined
}

export function assignmentFileName(nativeID: string): string {
	return Buffer.from(nativeID).toString('base64url')
}

export function hierarchyConfiguration(environment: RuntimeEnvironment): {
	serviceURL: string
	namespaceID: string
	capability: string
	useInstalledPlugin: boolean
} {
	const pluginKeys = [
		'CLAUDE_PLUGIN_OPTION_SERVICE_URL',
		'CLAUDE_PLUGIN_OPTION_NAMESPACE_ID',
		'CLAUDE_PLUGIN_OPTION_NAMESPACE_CAPABILITY',
	] as const
	const usePluginConfiguration = pluginKeys.some((key) => key in environment)
	return usePluginConfiguration
		? {
			serviceURL: environment.CLAUDE_PLUGIN_OPTION_SERVICE_URL?.trim() ?? '',
			namespaceID: environment.CLAUDE_PLUGIN_OPTION_NAMESPACE_ID?.trim() ?? '',
			capability: environment.CLAUDE_PLUGIN_OPTION_NAMESPACE_CAPABILITY?.trim() ?? '',
			useInstalledPlugin: true,
		}
		: {
			serviceURL: environment.ZETTELKASTEN_SERVICE_URL?.trim() ?? '',
			namespaceID: environment.ZETTELKASTEN_NAMESPACE_ID?.trim() ?? '',
			capability: environment.ZETTELKASTEN_NAMESPACE_CAPABILITY?.trim() ?? '',
			useInstalledPlugin: false,
		}
}

export async function storeAssignment(cacheDirectory: string, nativeID: string, address: string): Promise<void> {
	const directory = resolve(cacheDirectory, 'assignments')
	await mkdir(directory, { recursive: true, mode: 0o700 })
	const destination = resolve(directory, assignmentFileName(nativeID))
	const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`
	await writeFile(temporary, `${address}\n`, { mode: 0o600 })
	await rename(temporary, destination)
}

export async function storeLaunchReceipt(cacheDirectory: string, nativeID: string, address: string): Promise<void> {
	const directory = resolve(cacheDirectory, 'launch-receipts')
	await mkdir(directory, { recursive: true, mode: 0o700 })
	const destination = resolve(directory, assignmentFileName(nativeID))
	const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`
	await writeFile(temporary, `${address}\n`, { mode: 0o600 })
	await rename(temporary, destination)
}

export async function storePendingTitle(cacheDirectory: string, nativeID: string, address: string): Promise<void> {
	const directory = resolve(cacheDirectory, 'pending-titles')
	await mkdir(directory, { recursive: true, mode: 0o700 })
	const destination = resolve(directory, assignmentFileName(nativeID))
	const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`
	await writeFile(temporary, `${address}\n`, { mode: 0o600 })
	await rename(temporary, destination)
}

export async function consumePendingTitle(cacheDirectory: string, nativeID: string): Promise<string | undefined> {
	const path = resolve(cacheDirectory, 'pending-titles', assignmentFileName(nativeID))
	let address: string
	try {
		address = (await readFile(path, 'utf8')).trim()
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
		throw error
	}
	parseAddress(address)
	await unlink(path)
	return address
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`
}

export async function configureLauncher(
	environmentFile: string,
	nativeID: string,
	address: string,
	launcherPath: string,
	useInstalledPlugin: boolean,
): Promise<void> {
	await appendFile(
		environmentFile,
		`export ZETTELKASTEN_CLAUDE_SESSION_ID=${shellQuote(nativeID)}\nexport ZETTELKASTEN_CLAUDE_ADDRESS=${shellQuote(address)}\nexport ZETTELKASTEN_CLAUDE_LAUNCHER=${shellQuote(launcherPath)}\n${useInstalledPlugin ? 'export ZETTELKASTEN_CLAUDE_USE_INSTALLED_PLUGIN=1' : 'unset ZETTELKASTEN_CLAUDE_USE_INSTALLED_PLUGIN'}\nunset ZETTELKASTEN_CLAUDE_PARENT_SESSION_ID\n`,
	)
}

function warning(error: unknown): HookOutput {
	const message = error instanceof HierarchyAllocationError
		? error.message
		: 'Zettelkasten numbering was deferred because the integration failed safely.'
	return { systemMessage: message }
}

export async function handleHook(
	input: HookInput,
	environment: RuntimeEnvironment,
	dependencies: HookDependencies = {},
): Promise<HookOutput | undefined> {
	if (input.hook_event_name === 'UserPromptSubmit') {
		const cacheDirectory = displayCacheDirectory(environment)
		if (!cacheDirectory) return undefined
		try {
			const sessionTitle = await (dependencies.consumePendingTitle ?? consumePendingTitle)(cacheDirectory, input.session_id)
			return sessionTitle ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', sessionTitle } } : undefined
		} catch (error) {
			return warning(error)
		}
	}

	if (input.hook_event_name === 'SessionStart' && input.source === 'fork') {
		return {
			systemMessage: 'Zettelkasten numbering was deferred: Claude Code identifies this session as a fork but does not expose its source session ID to hooks.',
		}
	}

	const requestSignal = AbortSignal.timeout(7_000)
	const configuration = hierarchyConfiguration(environment)
	const allocator = new RemoteHierarchyAllocator(
		configuration.serviceURL,
		configuration.namespaceID,
		configuration.capability,
		dependencies.request,
		requestSignal,
	)

	try {
		if (!configuration.serviceURL || !configuration.namespaceID || !configuration.capability) {
			throw new HierarchyAllocationError(configuration.useInstalledPlugin
				? 'Zettelkasten plugin configuration is incomplete. Open /plugin, select zettelkasten-hierarchy, and use Configure options for the service URL, namespace ID, and namespace capability.'
				: 'Zettelkasten configuration is incomplete. Set ZETTELKASTEN_SERVICE_URL, ZETTELKASTEN_NAMESPACE_ID, and ZETTELKASTEN_NAMESPACE_CAPABILITY.')
		}
		if (input.hook_event_name === 'SessionStart') {
			let assignment: ResolvedHierarchyAssignment
			let lineageValidated = false
			const launchParentID = input.source === 'startup'
				? environment.ZETTELKASTEN_CLAUDE_PARENT_SESSION_ID
				: undefined
			if (launchParentID) {
				const parent = await allocator.resolveAssignment(launchParentID)
				const address = await allocator.allocate(input.session_id, launchParentID)
				if (!directChildOf(parent.address, address)) {
					throw new HierarchyAllocationError('Hierarchy service returned an address outside the launcher parent Claude Code session lineage.')
				}
				assignment = { nativeID: input.session_id, parentNativeID: launchParentID, address }
				lineageValidated = true
			} else {
				try {
					assignment = await allocator.resolveAssignment(input.session_id)
				} catch (error) {
					if (!(error instanceof HierarchyAllocationError && error.status === 404 && error.code === 'element_not_found')) throw error
					assignment = { nativeID: input.session_id, parentNativeID: null, address: await allocator.allocate(input.session_id, null) }
				}
			}
			if (assignment.parentNativeID !== null && !lineageValidated) {
				const parent = await allocator.resolveAssignment(assignment.parentNativeID)
				if (!directChildOf(parent.address, assignment.address)) {
					throw new HierarchyAllocationError('Hierarchy service returned an address outside the parent Claude Code session lineage.')
				}
			}
			if (!environment.CLAUDE_ENV_FILE) {
				throw new HierarchyAllocationError('Claude Code did not provide session environment storage; background-session launching was deferred.')
			}
			const launcherPath = fileURLToPath(new URL('launcher.ts', import.meta.url))
			const formattedAddress = formatAddress(assignment.address)
			await (dependencies.configureLauncher ?? configureLauncher)(
				environment.CLAUDE_ENV_FILE,
				input.session_id,
				formattedAddress,
				launcherPath,
				configuration.useInstalledPlugin,
			)
			if (launchParentID && input.source === 'startup') {
				const cacheDirectory = displayCacheDirectory(environment)
				if (!cacheDirectory) {
					throw new HierarchyAllocationError('Claude Code did not provide a user cache directory; background-session launch confirmation failed.')
				}
				await (dependencies.storeLaunchReceipt ?? storeLaunchReceipt)(
					cacheDirectory,
					input.session_id,
					formattedAddress,
				)
			}
			if (input.source === 'clear') {
				const cacheDirectory = displayCacheDirectory(environment)
				if (!cacheDirectory) {
					throw new HierarchyAllocationError('Claude Code did not provide a user cache directory; the cleared session title was deferred.')
				}
				await (dependencies.storePendingTitle ?? storePendingTitle)(
					cacheDirectory,
					input.session_id,
					formattedAddress,
				)
			}
			return {
				hookSpecificOutput: {
					hookEventName: 'SessionStart',
					sessionTitle: input.source === 'clear'
						? formattedAddress
						: formatSessionTitle(assignment.address, input.session_title),
					additionalContext: 'When creating an independent Claude Code background session, run `node "$ZETTELKASTEN_CLAUDE_LAUNCHER" "<task>"` instead of invoking `claude --bg` directly. The launcher preserves authoritative Zettelkasten parentage and the child remains visible in Claude agent view.',
				},
			}
		}

		if (!input.agent_id || !input.agent_type?.trim()) return undefined
		const cacheDirectory = displayCacheDirectory(environment)
		if (!cacheDirectory) {
			throw new HierarchyAllocationError('Claude Code did not provide a user cache directory; subagent numbering was deferred.')
		}
		const parent = await allocator.resolveAssignment(input.session_id)
		if (parent.parentNativeID !== null) {
			const grandparent = await allocator.resolveAssignment(parent.parentNativeID)
			if (!directChildOf(grandparent.address, parent.address)) {
				throw new HierarchyAllocationError('Hierarchy service returned an invalid parent Claude Code session lineage.')
			}
		}
		const address = await allocator.allocate(input.agent_id, input.session_id)
		if (!directChildOf(parent.address, address)) {
			throw new HierarchyAllocationError('Hierarchy service returned an address outside the parent Claude Code session lineage.')
		}
		const formattedAddress = formatAddress(address)
		await (dependencies.storeAssignment ?? storeAssignment)(cacheDirectory, input.agent_id, formattedAddress)
		return {
			systemMessage: `Zettelkasten address: ${formattedAddress}`,
			hookSpecificOutput: {
				hookEventName: 'SubagentStart',
				additionalContext: `Zettelkasten address: ${formattedAddress}.`,
			},
		}
	} catch (error) {
		const output = warning(error)
		if (
			input.hook_event_name === 'SessionStart'
			&& input.source === 'startup'
			&& environment.ZETTELKASTEN_CLAUDE_PARENT_SESSION_ID
		) {
			return { ...output, continue: false, stopReason: output.systemMessage }
		}
		return output
	}
}

async function run(): Promise<void> {
	const chunks: Buffer[] = []
	for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
	let input: HookInput
	try {
		input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as HookInput
	} catch {
		process.stdout.write(JSON.stringify({ systemMessage: 'Zettelkasten numbering was deferred because Claude Code supplied invalid hook input.' }))
		return
	}
	const output = await handleHook(input, process.env)
	if (output) process.stdout.write(JSON.stringify(output))
}

if (invokedDirectly(import.meta.url)) await run()
