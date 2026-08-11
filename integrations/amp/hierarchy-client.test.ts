import { describe, expect, test } from 'bun:test'

import { HierarchyAllocationError, RemoteHierarchyAllocator } from './hierarchy-client'

const thread = 'T-child' as const
const parent = 'T-parent' as const

function response(status: number, body: unknown): typeof fetch {
	return (async () => Response.json(body, { status })) as typeof fetch
}

describe('remote hierarchy allocation', () => {
	test('rejects incomplete configuration before making a request', async () => {
		let calls = 0
		const request = (async () => {
			calls += 1
			return Response.json({})
		}) as typeof fetch
		const allocator = new RemoteHierarchyAllocator('https://service.test', '', '', request)
		await expect(allocator.allocate(thread, parent)).rejects.toThrow('configuration is incomplete')
		expect(calls).toBe(0)
	})

	test.each([200, 201])('accepts HTTP %s as the same successful assignment', async (status) => {
		const allocator = new RemoteHierarchyAllocator('https://service.test', 'ns_test', 'secret', response(status, {
			key: `amp:${thread}`,
			parentKey: `amp:${parent}`,
			address: '4b',
		}))
		expect(await allocator.allocate(thread, parent)).toEqual([4, 'b'])
	})

	test('delegates concurrent same-parent allocation to the service', async () => {
		let calls = 0
		const request = (async (_input, init) => {
			const body = JSON.parse(String(init?.body))
			calls += 1
			return Response.json({ ...body, address: calls === 1 ? '4a' : '4b' }, { status: 201 })
		}) as typeof fetch
		const allocator = new RemoteHierarchyAllocator('https://service.test', 'ns_test', 'secret', request)
		const addresses = await Promise.all([
			allocator.allocate('T-first', parent),
			allocator.allocate('T-second', parent),
		])
		expect(calls).toBe(2)
		expect(addresses).toEqual([[4, 'a'], [4, 'b']])
	})

	test('surfaces immutable parent conflicts without fallback', async () => {
		const allocator = new RemoteHierarchyAllocator('https://service.test', 'ns_test', 'secret', response(409, { code: 'parent_conflict' }))
		await expect(allocator.allocate(thread, parent)).rejects.toMatchObject({ status: 409, code: 'parent_conflict' })
	})

	test('rejects malformed and conflicting successful assignments', async () => {
		const malformed = new RemoteHierarchyAllocator('https://service.test', 'ns_test', 'secret', response(200, {
			key: `amp:${thread}`, parentKey: `amp:${parent}`, address: '01',
		}))
		await expect(malformed.allocate(thread, parent)).rejects.toThrow('invalid address')

		const conflicting = new RemoteHierarchyAllocator('https://service.test', 'ns_test', 'secret', response(201, {
			key: 'amp:T-other', parentKey: `amp:${parent}`, address: '4b',
		}))
		await expect(conflicting.allocate(thread, parent)).rejects.toThrow('conflicting assignment')
	})

	test.each([
		[409, 'namespace_initializing'],
		[503, 'unavailable'],
	])('defers HTTP %s failures without local fallback', async (status, code) => {
		const allocator = new RemoteHierarchyAllocator('https://service.test', 'ns_test', 'secret', response(status as number, { code }))
		await expect(allocator.allocate(thread, parent)).rejects.toBeInstanceOf(HierarchyAllocationError)
	})

	test('defers network failures without local fallback', async () => {
		const request = (async () => { throw new Error('offline') }) as typeof fetch
		const allocator = new RemoteHierarchyAllocator('https://service.test', 'ns_test', 'secret', request)
		await expect(allocator.allocate(thread, parent)).rejects.toMatchObject({ status: undefined })
	})
})
