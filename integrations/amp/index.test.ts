import { expect, test } from 'bun:test'

import { effectiveParentThreadID } from './amp-adapter'
import { waitForSemanticTitle } from './index'

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
