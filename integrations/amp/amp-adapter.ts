import type { Agent, PluginAPI, PluginThread, ShellFunction } from '@ampcode/plugin'

import { logDiagnostic } from './diagnostics'
import type { ThreadAdapter, ThreadSummary } from './service'

interface PrivateThreadRecord {
	id: unknown
	parentThreadID?: unknown
	title?: unknown
	created: unknown
	archived?: unknown
	messages?: unknown
}

export interface PrivateThreadDetails {
	thread: ThreadSummary
	assistantMessageCount: number
}

// The private endpoint currently clamps list responses to 50 records.
const pageSize = 50
const maximumRequestAttempts = 5
let requestTail = Promise.resolve()

function serializeRequest<T>(operation: () => Promise<T>): Promise<T> {
	const result = requestTail.catch(() => undefined).then(operation)
	requestTail = result.then(
		() => undefined,
		() => undefined,
	)
	return result
}

function apiKey(): string {
	const value = process.env.AMP_API_KEY
	if (!value) {
		throw new Error(
			'AMP_API_KEY is not available to the plugin process. Start Amp with that environment variable set.',
		)
	}
	return value
}

export function effectiveParentThreadID(
	record: Pick<PrivateThreadRecord, 'parentThreadID' | 'messages'>,
): `T-${string}` | null {
	if (typeof record.parentThreadID === 'string' && record.parentThreadID.startsWith('T-')) {
		return record.parentThreadID as `T-${string}`
	}
	if (!Array.isArray(record.messages)) return null
	const firstUserMessage = record.messages.find(
		(message) => message && typeof message === 'object' && Reflect.get(message, 'role') === 'user',
	)
	const meta = firstUserMessage && typeof firstUserMessage === 'object'
		? Reflect.get(firstUserMessage, 'meta')
		: undefined
	const fromExecutorThreadID = meta && typeof meta === 'object'
		? Reflect.get(meta, 'fromExecutorThreadID')
		: undefined
	return typeof fromExecutorThreadID === 'string' && fromExecutorThreadID.startsWith('T-')
		? fromExecutorThreadID as `T-${string}`
		: null
}

function parseThread(record: PrivateThreadRecord): ThreadSummary {
	if (typeof record.id !== 'string' || !record.id.startsWith('T-')) {
		throw new Error('Private thread API returned an invalid thread ID')
	}
	if (
		record.parentThreadID !== undefined &&
		record.parentThreadID !== null &&
		(typeof record.parentThreadID !== 'string' || !record.parentThreadID.startsWith('T-'))
	) {
		throw new Error(`Private thread API returned an invalid parent for ${record.id}`)
	}
	if (record.title !== undefined && record.title !== null && typeof record.title !== 'string') {
		throw new Error(`Private thread API returned an invalid title for ${record.id}`)
	}

	const created =
		typeof record.created === 'number' || typeof record.created === 'string'
			? new Date(record.created)
			: new Date(Number.NaN)
	if (Number.isNaN(created.getTime())) {
		throw new Error(`Private thread API returned an invalid creation time for ${record.id}`)
	}

	return {
		id: record.id as `T-${string}`,
		parentThreadID: effectiveParentThreadID(record),
		title: (record.title ?? null) as string | null,
		createdAt: created.toISOString(),
		archived: record.archived === true,
	}
}

function retryDelay(response: Response, attempt: number): number {
	const header = response.headers.get('retry-after')
	if (header) {
		const seconds = Number(header)
		if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000
		const date = Date.parse(header)
		if (Number.isFinite(date)) return Math.max(0, date - Date.now())
	}
	return 500 * 2 ** attempt
}

export class AmpPrivateThreadAdapter implements ThreadAdapter {
	private readonly handles = new Map<`T-${string}`, PluginThread>()

	constructor(
		private readonly amp: PluginAPI,
		private readonly agent: Agent | undefined,
		private readonly shell: ShellFunction,
		private readonly traceID = 'unscoped',
	) {}

	async getThread(threadID: `T-${string}`): Promise<ThreadSummary | undefined> {
		return (await this.getThreadDetails(threadID))?.thread
	}

	async getThreadDetails(threadID: `T-${string}`): Promise<PrivateThreadDetails | undefined> {
		const url = new URL(`/api/threads/${threadID}`, this.amp.system.ampURL)
		const response = await this.fetchWithRetry(url)
		if (response.status === 404) return undefined
		if (!response.ok) {
			throw new Error(`Private thread request failed with HTTP ${response.status}`)
		}
		const body: unknown = await response.json()
		if (!body || typeof body !== 'object' || Array.isArray(body)) {
			throw new Error('Private thread API response is no longer an object')
		}
		const record = body as PrivateThreadRecord
		if (!Array.isArray(record.messages)) {
			throw new Error('Private thread API response no longer contains messages')
		}
		return {
			thread: parseThread(record),
			assistantMessageCount: record.messages.filter(
				(message) => message && typeof message === 'object' && Reflect.get(message, 'role') === 'assistant',
			).length,
		}
	}

	async listRecentThreads(): Promise<ThreadSummary[]> {
		return this.fetchPage(0)
	}

	async createThread(parentThreadID: `T-${string}` | null): Promise<ThreadSummary> {
		await logDiagnostic('thread.create.started', {
			traceID: this.traceID,
			parentThreadID,
		})
		if (!this.agent) throw new Error('Thread creation requires an Amp agent')
		const createOptions: { parentThreadID?: `T-${string}` } = {}
		if (parentThreadID !== null) createOptions.parentThreadID = parentThreadID
		const handle = await this.agent.createThread(createOptions)
		this.handles.set(handle.id, handle)
		await logDiagnostic('thread.create.completed', {
			traceID: this.traceID,
			threadID: handle.id,
			parentThreadID,
		})
		return {
			id: handle.id,
			parentThreadID,
			title: null,
			createdAt: new Date().toISOString(),
		}
	}

	async setTitle(threadID: `T-${string}`, title: string, expectedCurrentTitle?: string): Promise<void> {
		await logDiagnostic('thread.rename.started', { traceID: this.traceID, threadID })
		let lastError = ''
		for (let attempt = 0; attempt < 3; attempt += 1) {
			if (expectedCurrentTitle !== undefined) {
				const latest = await this.getThread(threadID)
				if (latest?.title !== expectedCurrentTitle) {
					throw new Error(`Thread ${threadID} changed title before rename; automatic numbering will retry later`)
				}
			}
			try {
				const result = await this.shell`amp threads rename ${threadID} ${title}`
				await logDiagnostic('thread.rename.attempt', {
					traceID: this.traceID,
					threadID,
					attempt: attempt + 1,
					exitCode: result.exitCode,
				})
				if (result.exitCode === 0) {
					await logDiagnostic('thread.rename.completed', { traceID: this.traceID, threadID })
					return
				}
				lastError = (result.stderr.trim() || result.stdout.trim()).replaceAll(title, '[title]')
			} catch (error) {
				lastError = (error instanceof Error ? error.message : String(error)).replaceAll(title, '[title]')
				await logDiagnostic('thread.rename.attempt_failed', {
					traceID: this.traceID,
					threadID,
					attempt: attempt + 1,
					error: lastError,
				})
			}
			await Bun.sleep(150 * (attempt + 1))
		}
		throw new Error(`Failed to rename ${threadID}: ${lastError || 'unknown Amp CLI error'}`)
	}

	async appendInitialPrompt(threadID: `T-${string}`, prompt: string): Promise<void> {
		await logDiagnostic('thread.prompt_append.started', { traceID: this.traceID, threadID })
		const handle = this.handles.get(threadID) ?? this.amp.threads.get(threadID)
		await handle.appendUserMessage({ type: 'user-message', content: prompt })
		await logDiagnostic('thread.prompt_append.completed', { traceID: this.traceID, threadID })
	}

	private async fetchPage(offset: number): Promise<ThreadSummary[]> {
		const url = new URL('/api/threads', this.amp.system.ampURL)
		url.searchParams.set('includeArchived', 'true')
		url.searchParams.set('includeEmpty', 'true')
		url.searchParams.set('limit', String(pageSize))
		url.searchParams.set('offset', String(offset))

		const response = await this.fetchWithRetry(url)
		if (!response.ok) {
			throw new Error(`Private thread list request failed with HTTP ${response.status}`)
		}
		const body: unknown = await response.json()
		if (!Array.isArray(body)) throw new Error('Private thread API response is no longer an array')
		return body.map((record) => parseThread(record as PrivateThreadRecord))
	}

	private async fetchWithRetry(url: URL): Promise<Response> {
		return serializeRequest(() => this.fetchWithRetrySerialized(url))
	}

	private async fetchWithRetrySerialized(url: URL): Promise<Response> {
		let response: Response | undefined
		for (let attempt = 0; attempt < maximumRequestAttempts; attempt += 1) {
			const startedAt = performance.now()
			try {
				response = await fetch(url, {
					headers: { Authorization: `Bearer ${apiKey()}` },
				})
			} catch (error) {
				await logDiagnostic('api.request.failed', {
					traceID: this.traceID,
					path: url.pathname,
					offset: url.searchParams.get('offset'),
					attempt: attempt + 1,
					durationMs: Math.round(performance.now() - startedAt),
					error: error instanceof Error ? error.message : String(error),
				})
				throw error
			}
			await logDiagnostic('api.request.completed', {
				traceID: this.traceID,
				path: url.pathname,
				offset: url.searchParams.get('offset'),
				attempt: attempt + 1,
				status: response.status,
				durationMs: Math.round(performance.now() - startedAt),
			})
			if (response.status !== 429) break
			const delayMs = retryDelay(response, attempt)
			await logDiagnostic('api.request.rate_limited', {
				traceID: this.traceID,
				path: url.pathname,
				attempt: attempt + 1,
				delayMs,
			})
			if (attempt + 1 < maximumRequestAttempts) await Bun.sleep(delayMs)
		}
		if (!response) throw new Error('Private thread request did not produce a response')
		return response
	}
}
