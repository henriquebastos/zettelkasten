import { describe, expect, test } from 'bun:test'

import { parseAddress, type Address } from './address'
import type { HierarchyAllocator } from './hierarchy-client'
import { type ThreadAdapter, type ThreadSummary, ZettelkastenService } from './service'

class FakeAdapter implements ThreadAdapter {
	readonly titleWrites: Array<[`T-${string}`, string, string | undefined]> = []
	constructor(readonly threads: ThreadSummary[]) {}
	async getThread(id: `T-${string}`) { return this.threads.find((thread) => thread.id === id) }
	async setTitle(id: `T-${string}`, title: string, expected?: string) {
		this.titleWrites.push([id, title, expected])
		;(await this.getThread(id))!.title = title
	}
	async createThread(): Promise<ThreadSummary> { throw new Error('not used') }
	async appendInitialPrompt(): Promise<void> { throw new Error('not used') }
}

class FakeAllocator implements HierarchyAllocator {
	readonly calls: Array<[`T-${string}`, `T-${string}` | null]> = []
	constructor(private readonly addresses: Record<string, string>, private readonly failure?: Error) {}
	async allocate(id: `T-${string}`, parent: `T-${string}` | null): Promise<Address> {
		this.calls.push([id, parent])
		if (this.failure) throw this.failure
		return parseAddress(this.addresses[id]!)
	}
}

function thread(id: `T-${string}`, title: string, parentThreadID: `T-${string}` | null): ThreadSummary {
	return { id, title, parentThreadID, createdAt: '2026-01-01T00:00:00.000Z' }
}

describe('service-backed numbering', () => {
	test('ensures an unnumbered effective parent before allocating its child', async () => {
		const parent = thread('T-parent', 'Parent', null)
		const child = thread('T-child', 'Child', parent.id)
		const allocator = new FakeAllocator({ 'T-parent': '400', 'T-child': '400a' })
		const result = await new ZettelkastenService(new FakeAdapter([parent, child]), allocator).numberExisting(child.id)
		expect(result.status).toBe('numbered')
		expect(allocator.calls).toEqual([['T-parent', null], ['T-child', 'T-parent']])
		expect(parent.title).toBe('400 Parent')
		expect(child.title).toBe('400a Child')
	})

	test('verifies a matching parseable address with one allocation and no rename', async () => {
		const existing = thread('T-existing', '400 Existing', null)
		const allocator = new FakeAllocator({ 'T-existing': '400' })
		const result = await new ZettelkastenService(new FakeAdapter([existing]), allocator).numberExisting(existing.id)
		expect(result.status).toBe('already-numbered')
		expect(allocator.calls).toEqual([['T-existing', null]])
		expect(existing.title).toBe('400 Existing')
	})

	test('reconciles a wrong parseable child address and preserves its semantic title', async () => {
		const parent = thread('T-parent', '318 Parent', null)
		const child = thread('T-child', '319a Semantic child', parent.id)
		const allocator = new FakeAllocator({ 'T-parent': '318', 'T-child': '318d' })
		const result = await new ZettelkastenService(new FakeAdapter([parent, child]), allocator).numberExisting(child.id)
		expect(result.status).toBe('numbered')
		expect(allocator.calls).toEqual([['T-parent', null], ['T-child', 'T-parent']])
		expect(child.title).toBe('318d Semantic child')
	})

	test('leaves the title unchanged when remote allocation is unavailable', async () => {
		const target = thread('T-target', 'Semantic title', null)
		const allocator = new FakeAllocator({}, new Error('service unavailable'))
		await expect(new ZettelkastenService(new FakeAdapter([target]), allocator).numberExisting(target.id)).rejects.toThrow('service unavailable')
		expect(target.title).toBe('Semantic title')
	})

	test('does not overwrite a title that changes while the service allocates', async () => {
		const target = thread('T-target', '400 Original', null)
		const allocator: HierarchyAllocator = {
			async allocate() { target.title = 'Newer'; return parseAddress('401') },
		}
		const result = await new ZettelkastenService(new FakeAdapter([target]), allocator).numberExisting(target.id)
		expect(result.status).toBe('invalid')
		expect(target.title).toBe('Newer')
	})

	test('defers without child allocation when its parent changes during parent reconciliation', async () => {
		const parent = thread('T-parent', 'Parent', null)
		const replacement = thread('T-replacement', '9 Replacement', null)
		const child = thread('T-child', 'Child', parent.id)
		const allocator: HierarchyAllocator = {
			async allocate(id) {
				if (id === parent.id) child.parentThreadID = replacement.id
				return parseAddress('4')
			},
		}
		const result = await new ZettelkastenService(new FakeAdapter([parent, replacement, child]), allocator).numberExisting(child.id)
		expect(result.status).toBe('invalid')
		expect(parent.title).toBe('4 Parent')
		expect(child.title).toBe('Child')
	})

	test('defers when its parent changes during child allocation and propagates the expected title', async () => {
		const parent = thread('T-parent', '4 Parent', null)
		const child = thread('T-child', 'Child', parent.id)
		const adapter = new FakeAdapter([parent, child])
		const allocator: HierarchyAllocator = {
			async allocate(id) {
				if (id === child.id) child.parentThreadID = null
				return parseAddress(id === parent.id ? '4' : '4a')
			},
		}
		const result = await new ZettelkastenService(adapter, allocator).numberExisting(child.id)
		expect(result.status).toBe('invalid')
		expect(adapter.titleWrites).toEqual([])
	})

	test('passes the observed title as the rename expectation', async () => {
		const target = thread('T-target', 'Semantic title', null)
		const adapter = new FakeAdapter([target])
		await new ZettelkastenService(adapter, new FakeAllocator({ 'T-target': '7' })).numberExisting(target.id)
		expect(adapter.titleWrites).toEqual([['T-target', '7 Semantic title', 'Semantic title']])
	})

	test('guards effective-parent cycles', async () => {
		const first = thread('T-first', 'First', 'T-second')
		const second = thread('T-second', 'Second', first.id)
		await expect(new ZettelkastenService(new FakeAdapter([first, second]), new FakeAllocator({})).numberExisting(first.id)).rejects.toThrow('cycle')
	})

	test('rejects a service lineage outside the numbered parent', async () => {
		const parent = thread('T-parent', '4 Parent', null)
		const child = thread('T-child', 'Child', parent.id)
		await expect(new ZettelkastenService(new FakeAdapter([parent, child]), new FakeAllocator({ 'T-parent': '4', 'T-child': '8a' })).numberExisting(child.id)).rejects.toThrow('outside')
		expect(child.title).toBe('Child')
	})
})

test('parent allocation failure leaves both titles unchanged', async () => {
	const parent = thread('T-parent', '4 Parent', null)
	const child = thread('T-child', '4a Child', parent.id)
	await expect(new ZettelkastenService(new FakeAdapter([parent, child]), new FakeAllocator({}, new Error('parent conflict'))).numberExisting(child.id)).rejects.toThrow('parent conflict')
	expect(parent.title).toBe('4 Parent')
	expect(child.title).toBe('4a Child')
})
