import type { PluginAPI, PluginCommandContext, PluginThread } from '@ampcode/plugin'

import { parseThreadTitle, type Address } from './address'
import { AmpPrivateThreadAdapter } from './amp-adapter'
import { hierarchyCapability, hierarchyNamespaceID, hierarchyServiceURL } from './credentials'
import { diagnosticLogPath, logDiagnostic, newTraceID } from './diagnostics'
import { RemoteHierarchyAllocator } from './hierarchy-client'
import { ZettelkastenService, type ThreadSummary } from './service'

export const description =
	'Assigns service-backed Luhmann-style addresses to visible roots and child threads automatically.'

export async function waitForSemanticTitle(
	thread: Pick<PluginThread, 'title'>,
	timeoutMs = 60_000,
): Promise<string | undefined> {
	const current = await thread.title.get()
	if (current?.trim()) return current

	return new Promise<string | undefined>((resolve, reject) => {
		let settled = false
		let subscription: { unsubscribe(): void } | undefined
		const finish = (title?: string, error?: unknown) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			subscription?.unsubscribe()
			if (error) reject(error)
			else resolve(title)
		}
		const timer = setTimeout(() => finish(), timeoutMs)
		subscription = thread.title.subscribe({
			next(title) {
				if (title?.trim()) finish(title)
			},
			error(error) {
				finish(undefined, error)
			},
		})
		if (settled) subscription.unsubscribe()
	})
}

async function requestDetails(ctx: PluginCommandContext) {
	const semanticTitle = await ctx.ui.input({
		title: 'Semantic title',
		helpText: 'The Zettelkasten address will be added automatically.',
		submitButtonText: 'Next',
	})
	if (!semanticTitle?.trim()) return
	const initialPrompt = await ctx.ui.input({
		title: 'Initial prompt',
		helpText: 'This message starts the new Amp thread.',
		submitButtonText: 'Create thread',
	})
	if (!initialPrompt?.trim()) return
	return { semanticTitle: semanticTitle.trim(), initialPrompt: initialPrompt.trim() }
}

function warningSummary(warnings: readonly string[]): string {
	const shown = warnings.slice(0, 5)
	const remaining = warnings.length - shown.length
	return `${shown.join('\n')}${remaining > 0 ? `\n… and ${remaining} more.` : ''}`
}

async function safeNotify(
	ui: { notify(message: string): Promise<unknown> },
	message: string,
	traceID: string,
): Promise<void> {
	try {
		await ui.notify(message)
	} catch (error) {
		await logDiagnostic('ui.notify_failed', {
			traceID,
			error: error instanceof Error ? error.stack ?? error.message : String(error),
		})
	}
}

export default function zettelkastenPlugin(amp: PluginAPI): void {
	void logDiagnostic('plugin.loaded', { logPath: diagnosticLogPath() })
	const hierarchy = new RemoteHierarchyAllocator(
		hierarchyServiceURL,
		hierarchyNamespaceID,
		hierarchyCapability,
	)
	const inFlight = new Map<`T-${string}`, Promise<void>>()
	const ensureAutomaticallyNumbered = async (
		adapter: AmpPrivateThreadAdapter,
		threadID: `T-${string}`,
		observedTitle: string,
		traceID: string,
	): Promise<{ address: Address; renamed: boolean }> => {
		let existingAddress: Address | undefined
		try {
			existingAddress = parseThreadTitle(observedTitle).address
		} catch {
			// A semantic title without an address remains eligible whenever it is observed.
		}
		if (existingAddress) {
			return { address: existingAddress, renamed: false }
		}
		const result = await new ZettelkastenService(adapter, hierarchy).numberExisting(threadID)
		if (result.status === 'invalid') throw new Error(result.warnings[0])
		const latest = await adapter.getThread(threadID)
		if (!latest?.title) throw new Error(`Thread ${threadID} was not found after allocation`)
		const address = parseThreadTitle(latest.title).address
		await logDiagnostic('automatic.thread_numbered', {
			traceID,
			threadID,
			address: address.join(''),
		})
		return { address, renamed: result.status === 'numbered' }
	}
	const automaticallyNumber = (
		thread: PluginThread,
		source: 'agent.end' | 'session.start.activation-fallback' | 'recent.scan.catch-up',
	): Promise<void> => {
		const threadID = thread.id
		const traceID = newTraceID()
		const existing = inFlight.get(threadID)
		if (existing) {
			void logDiagnostic('automatic.skipped_in_flight', { traceID, threadID, source })
			return existing
		}
		const task = (async () => {
			const startedAt = performance.now()
			await logDiagnostic('automatic.started', {
				traceID,
				threadID,
				source,
			})
			const adapter = new AmpPrivateThreadAdapter(amp, undefined, amp.$, traceID)
			const summary = await adapter.getThread(threadID)
			if (!summary) {
				await logDiagnostic('automatic.skipped_missing_thread', { traceID, threadID })
				return
			}
			const assistantMessages = await thread.messages({
				full: true,
				from: 'start',
				limit: 2,
				roles: ['assistant'],
			})
			if (source !== 'agent.end' && assistantMessages.length === 0) {
				await logDiagnostic('automatic.skipped_before_first_turn', { traceID, threadID })
				return
			}

			const title = await waitForSemanticTitle(thread)
			if (!title) {
				await logDiagnostic('automatic.skipped_title_timeout', { traceID, threadID })
				return
			}
			const result = await ensureAutomaticallyNumbered(adapter, threadID, title, traceID)
			if (!result.renamed) {
				await logDiagnostic('automatic.skipped_numbered_title', {
					traceID,
					threadID,
					address: result.address.join(''),
				})
				return
			}
			await logDiagnostic('automatic.completed', {
				traceID,
				threadID,
				address: result.address.join(''),
				durationMs: Math.round(performance.now() - startedAt),
			})
		})()
			.catch(async (error) => {
				const detail = error instanceof Error ? error.stack ?? error.message : String(error)
				console.error(`[zettelkasten] Automatic numbering failed for ${threadID}: ${detail}`)
				await logDiagnostic('automatic.failed', { traceID, threadID, source, error: detail })
				if (source !== 'recent.scan.catch-up') {
					await safeNotify(
						amp.ui,
						`Automatic Zettelkasten numbering failed for ${threadID} (trace ${traceID}): ${error instanceof Error ? error.message : String(error)}`,
						traceID,
					)
				}
			})
			.finally(async () => {
				try {
					await logDiagnostic('automatic.settled', { traceID, threadID })
				} finally {
					inFlight.delete(threadID)
				}
			})
		inFlight.set(threadID, task)
		return task
	}
	const automaticallyCatchUp = async (summary: ThreadSummary): Promise<void> => {
		const existing = inFlight.get(summary.id)
		if (existing) return existing
		const threadID = summary.id
		const traceID = newTraceID()
		const task = (async () => {
				const startedAt = performance.now()
				await logDiagnostic('automatic.started', {
					traceID,
					threadID,
					source: 'recent.scan.catch-up',
				})
				const adapter = new AmpPrivateThreadAdapter(amp, undefined, amp.$, traceID)
				const details = await adapter.getThreadDetails(threadID)
				if (!details) return
				if (details.assistantMessageCount === 0) {
					await logDiagnostic('automatic.skipped_before_first_turn', { traceID, threadID })
					return
				}
				const title = details.thread.title?.trim()
				if (!title) {
					await logDiagnostic('automatic.skipped_title_timeout', { traceID, threadID })
					return
				}
				const result = await ensureAutomaticallyNumbered(adapter, threadID, title, traceID)
				await logDiagnostic(result.renamed ? 'automatic.completed' : 'automatic.skipped_numbered_title', {
					traceID,
					threadID,
					address: result.address.join(''),
					durationMs: Math.round(performance.now() - startedAt),
				})
			})()
			.catch(async (error) => {
				await logDiagnostic('automatic.failed', {
					traceID,
					threadID,
					source: 'recent.scan.catch-up',
					error: error instanceof Error ? error.stack ?? error.message : String(error),
				})
			})
			.finally(async () => {
				try {
					await logDiagnostic('automatic.settled', { traceID, threadID })
				} finally {
					if (inFlight.get(threadID) === task) inFlight.delete(threadID)
				}
			})
		inFlight.set(threadID, task)
		await task
	}
	let catchUp: Promise<void> | undefined
	let lastCatchUpAt = 0
	const requestCatchUp = (): Promise<void> => {
		if (catchUp) return catchUp
		if (Date.now() - lastCatchUpAt < 60_000) return Promise.resolve()
		catchUp = (async () => {
			const traceID = newTraceID()
			await logDiagnostic('recent.scan.started', { traceID })
			const adapter = new AmpPrivateThreadAdapter(amp, undefined, amp.$, traceID)
			const recent = await adapter.listRecentThreads()
			let candidateCount = 0
			for (const summary of recent
				.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))) {
				try {
					parseThreadTitle(summary.title ?? '')
					continue
				} catch {
					candidateCount += 1
				}
				await automaticallyCatchUp(summary)
			}
			lastCatchUpAt = Date.now()
			await logDiagnostic('recent.scan.completed', { traceID, threadCount: recent.length, candidateCount })
		})()
			.catch(async (error) => {
				await logDiagnostic('recent.scan.failed', {
					error: error instanceof Error ? error.stack ?? error.message : String(error),
				})
			})
			.finally(() => {
				catchUp = undefined
			})
		return catchUp
	}

	amp.on('session.start', async (_event, ctx) => {
		await logDiagnostic('trigger.session_start', { threadID: ctx.thread.id })
		await automaticallyNumber(ctx.thread, 'session.start.activation-fallback')
		void requestCatchUp()
	})

	amp.on('agent.end', async (event, ctx) => {
		await logDiagnostic('trigger.agent_end', { threadID: event.thread.id })
		if (event.status === 'done') await automaticallyNumber(ctx.thread, 'agent.end')
		void requestCatchUp()
	})

	amp.registerCommand(
		'zettelkasten-number-current-thread',
		{
			category: 'Zettelkasten',
			title: 'Number current thread',
			description: 'Number or validate the active thread and any unnumbered effective parent.',
		},
		async (ctx) => {
			const traceID = newTraceID()
			if (!ctx.thread) {
				await logDiagnostic('command.number_current.cancelled', { traceID, reason: 'no-active-thread' })
				await safeNotify(ctx.ui, 'Open the thread you want to number, then run this command again.', traceID)
				return
			}
			await logDiagnostic('command.number_current.started', { traceID, threadID: ctx.thread.id })
			try {
				const adapter = new AmpPrivateThreadAdapter(amp, undefined, ctx.$, traceID)
				const result = await new ZettelkastenService(adapter, hierarchy).numberExisting(ctx.thread.id)
				await logDiagnostic('command.number_current.completed', {
					traceID,
					threadID: ctx.thread.id,
					status: result.status,
					warningCount: result.warnings.length,
				})
				const message =
					result.status === 'numbered'
						? 'Numbered the current thread.'
						: result.status === 'already-numbered'
							? 'The current thread already has a valid Zettelkasten address.'
							: warningSummary(result.warnings)
				await safeNotify(ctx.ui, message, traceID)
			} catch (error) {
				const detail = error instanceof Error ? error.stack ?? error.message : String(error)
				await logDiagnostic('command.number_current.failed', {
					traceID,
					threadID: ctx.thread.id,
					error: detail,
				})
				await safeNotify(
					ctx.ui,
					`Zettelkasten numbering failed (trace ${traceID}): ${error instanceof Error ? error.message : String(error)}`,
					traceID,
				)
			}
		},
	)

	amp.registerCommand(
		'zettelkasten-create-child',
		{
			category: 'Zettelkasten',
			title: 'Create child',
			description: 'Create and number a direct child of the active thread.',
		},
		async (ctx) => {
			const traceID = newTraceID()
			await logDiagnostic('command.create_child.started', { traceID, threadID: ctx.thread?.id ?? null })
			if (!ctx.thread) {
				await logDiagnostic('command.create_child.cancelled', { traceID, reason: 'invalid-parent' })
				await ctx.ui.notify('Open the intended parent thread before running this command.')
				return
			}
			const request = await requestDetails(ctx)
			if (!request) {
				await logDiagnostic('command.create_child.cancelled', { traceID, reason: 'input-cancelled' })
				return
			}
			try {
				const adapter = new AmpPrivateThreadAdapter(
					amp,
					amp.getBuiltinAgent('medium'),
					ctx.$,
					traceID,
				)
				const created = await new ZettelkastenService(adapter, hierarchy).createChild(ctx.thread.id, request)
				await logDiagnostic('command.create_child.completed', {
					traceID,
					threadID: created.id,
				})
			} catch (error) {
				const detail = error instanceof Error ? error.stack ?? error.message : String(error)
				await logDiagnostic('command.create_child.failed', { traceID, error: detail })
				await ctx.ui.notify(`Zettelkasten creation failed (trace ${traceID}): ${error instanceof Error ? error.message : String(error)}`)
			}
		},
	)

	amp.registerCommand(
		'zettelkasten-create-root',
		{
			category: 'Zettelkasten',
			title: 'Create root',
			description: 'Create and number a new root thread.',
		},
		async (ctx) => {
			const traceID = newTraceID()
			await logDiagnostic('command.create_root.started', { traceID, threadID: ctx.thread?.id ?? null })
			const request = await requestDetails(ctx)
			if (!request) {
				await logDiagnostic('command.create_root.cancelled', { traceID, reason: 'input-cancelled' })
				return
			}
			try {
				const adapter = new AmpPrivateThreadAdapter(
					amp,
					amp.getBuiltinAgent('medium'),
					ctx.$,
					traceID,
				)
				const created = await new ZettelkastenService(adapter, hierarchy).createRoot(request)
				await logDiagnostic('command.create_root.completed', {
					traceID,
					threadID: created.id,
				})
			} catch (error) {
				const detail = error instanceof Error ? error.stack ?? error.message : String(error)
				await logDiagnostic('command.create_root.failed', { traceID, error: detail })
				await ctx.ui.notify(`Zettelkasten creation failed (trace ${traceID}): ${error instanceof Error ? error.message : String(error)}`)
			}
		},
	)

}
