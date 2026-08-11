import { describe, expect, test } from 'bun:test'

import { parseAddress, type Address } from './address'
import type { HierarchyAllocator } from './hierarchy-client'
import { type ThreadAdapter, type ThreadSummary, ZettelkastenService } from './service'

class FakeAdapter implements ThreadAdapter {
	constructor(readonly threads: ThreadSummary[]) {}
	async getThread(id: `T-${string}`) { return this.threads.find((thread) => thread.id === id) }
	async setTitle(id: `T-${string}`, title: string) { (await this.getThread(id))!.title = title }
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

	test('keeps an existing valid address idempotent without allocating', async () => {
		const existing = thread('T-existing', '400 Existing', null)
		const allocator = new FakeAllocator({})
		const result = await new ZettelkastenService(new FakeAdapter([existing]), allocator).numberExisting(existing.id)
		expect(result.status).toBe('already-numbered')
		expect(allocator.calls).toEqual([])
		expect(existing.title).toBe('400 Existing')
	})

	test('leaves the title unchanged when remote allocation is unavailable', async () => {
		const target = thread('T-target', 'Semantic title', null)
		const allocator = new FakeAllocator({}, new Error('service unavailable'))
		await expect(new ZettelkastenService(new FakeAdapter([target]), allocator).numberExisting(target.id)).rejects.toThrow('service unavailable')
		expect(target.title).toBe('Semantic title')
	})

	test('does not overwrite a title that changes while the service allocates', async () => {
		const target = thread('T-target', 'Original', null)
		const allocator: HierarchyAllocator = {
			async allocate() { target.title = 'Newer'; return parseAddress('401') },
		}
		const result = await new ZettelkastenService(new FakeAdapter([target]), allocator).numberExisting(target.id)
		expect(result.status).toBe('invalid')
		expect(target.title).toBe('Newer')
	})

	test('guards effective-parent cycles', async () => {
		const first = thread('T-first', 'First', 'T-second')
		const second = thread('T-second', 'Second', first.id)
		await expect(new ZettelkastenService(new FakeAdapter([first, second]), new FakeAllocator({})).numberExisting(first.id)).rejects.toThrow('cycle')
	})

	test('rejects a service lineage outside the numbered parent', async () => {
		const parent = thread('T-parent', '4 Parent', null)
		const child = thread('T-child', 'Child', parent.id)
		await expect(new ZettelkastenService(new FakeAdapter([parent, child]), new FakeAllocator({ 'T-child': '8a' })).numberExisting(child.id)).rejects.toThrow('outside')
		expect(child.title).toBe('Child')
	})
})

test('create child verifies the exact parent service assignment before creating', async () => {
	const parent = thread('T-parent', '4 Parent', null)
	let created = false
	const adapter = new FakeAdapter([parent])
	adapter.createThread = async () => { created = true; throw new Error('should not create') }
	await expect(new ZettelkastenService(adapter, new FakeAllocator({ 'T-parent': '5' })).createChild(parent.id, {
		semanticTitle: 'Child', initialPrompt: 'Prompt',
	})).rejects.toThrow('does not match')
	expect(created).toBe(false)
})
