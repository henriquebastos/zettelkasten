import { expect, test } from 'bun:test'

import { effectiveParentThreadID } from './amp-adapter'
import { catchUpFingerprint, selectCatchUpCandidates, waitForSemanticTitle } from './index'
import type { ThreadSummary } from './service'

function summary(id: `T-${string}`, title: string | null, createdAt: string, parentThreadID: `T-${string}` | null = null): ThreadSummary {
	return { id, title, createdAt, parentThreadID }
}

test('uses delegation provenance only when Amp has no structural parent', () => {
	const messages = [{ role: 'user', meta: { fromExecutorThreadID: 'T-source' } }]
	expect(effectiveParentThreadID({ parentThreadID: 'T-structural', messages })).toBe('T-structural')
	expect(effectiveParentThreadID({ parentThreadID: null, messages })).toBe('T-source')
	expect(effectiveParentThreadID({ parentThreadID: null, messages: [{ role: 'user', meta: {} }] })).toBeNull()
})

test('waits for the first nonempty semantic title and unsubscribes', async () => {
	let observer: { next(value: string | null): void } | undefined
	let unsubscribed = false
	const thread = {
		title: {
			get: async () => null,
			subscribe(value: typeof observer) {
				observer = value
				return { unsubscribe: () => (unsubscribed = true) }
			},
		},
	} as any
	const result = waitForSemanticTitle(thread, 100)
	await Bun.sleep(0)
	observer?.next('Semantic title')
	expect(await result).toBe('Semantic title')
	expect(unsubscribed).toBe(true)
})

test('selects at most ten newest changed nonempty catch-up records', () => {
	const records = Array.from({ length: 13 }, (_, index) =>
		summary(`T-${index}`, index === 12 ? ' ' : `Title ${index}`, `2026-01-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`),
	)
	const cache = new Map<`T-${string}`, string>([['T-11', catchUpFingerprint(records[11]!)]] )
	const selected = selectCatchUpCandidates(records, cache)
	expect(selected).toHaveLength(10)
	expect(selected.map((record) => record.id)).toEqual(['T-10', 'T-9', 'T-8', 'T-7', 'T-6', 'T-5', 'T-4', 'T-3', 'T-2', 'T-1'])
})

test('fingerprint changes with listed title or effective parent', () => {
	const original = summary('T-child', 'Title', '2026-01-01T00:00:00.000Z', 'T-parent')
	expect(catchUpFingerprint({ ...original, title: 'Changed' })).not.toBe(catchUpFingerprint(original))
	expect(catchUpFingerprint({ ...original, parentThreadID: null })).not.toBe(catchUpFingerprint(original))
})
