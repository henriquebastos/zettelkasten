import { directChildSuffix, formatThreadTitle, parseThreadTitle, type Address } from './address'
import type { HierarchyAllocator } from './hierarchy-client'

export interface ThreadSummary {
	id: `T-${string}`
	parentThreadID: `T-${string}` | null
	title: string | null
	createdAt: string
	archived?: boolean
}

export interface ThreadAdapter {
	getThread(threadID: `T-${string}`): Promise<ThreadSummary | undefined>
	createThread(parentThreadID: `T-${string}` | null): Promise<ThreadSummary>
	setTitle(threadID: `T-${string}`, title: string): Promise<void>
	appendInitialPrompt(threadID: `T-${string}`, prompt: string): Promise<void>
}

export interface CreateRequest {
	semanticTitle: string
	initialPrompt: string
}

export interface NumberExistingResult {
	status: 'numbered' | 'already-numbered' | 'invalid'
	warnings: string[]
}

export class ZettelkastenService {
	constructor(
		private readonly adapter: ThreadAdapter,
		private readonly allocator: HierarchyAllocator,
	) {}

	async createRoot(request: CreateRequest): Promise<ThreadSummary> {
		const created = await this.adapter.createThread(null)
		await this.adapter.appendInitialPrompt(created.id, request.initialPrompt)
		const address = await this.allocator.allocate(created.id, null)
		if (address.length !== 1) throw new Error('Hierarchy service returned a non-root address for a root thread')
		await this.adapter.setTitle(created.id, formatThreadTitle(address, request.semanticTitle))
		return created
	}

	async createChild(parentThreadID: `T-${string}`, request: CreateRequest): Promise<ThreadSummary> {
		const result = await this.numberExisting(parentThreadID)
		if (result.status === 'invalid') throw new Error(result.warnings[0])
		const parent = await this.adapter.getThread(parentThreadID)
		if (!parent?.title) throw new Error(`Effective parent ${parentThreadID} was not found`)
		const displayed = parseThreadTitle(parent.title).address
		const assigned = await this.allocator.allocate(parent.id, parent.parentThreadID)
		if (displayed.length !== assigned.length || displayed.some((part, index) => part !== assigned[index])) {
			throw new Error('Effective parent service assignment does not match its display title')
		}
		const created = await this.adapter.createThread(parent.id)
		await this.adapter.appendInitialPrompt(created.id, request.initialPrompt)
		const address = await this.allocator.allocate(created.id, parent.id)
		this.requireDirectChild(parent, address)
		await this.adapter.setTitle(created.id, formatThreadTitle(address, request.semanticTitle))
		return created
	}

	async numberExisting(threadID: `T-${string}`): Promise<NumberExistingResult> {
		return this.numberExistingRecursive(threadID, new Set())
	}

	private async numberExistingRecursive(threadID: `T-${string}`, visiting: Set<`T-${string}`>): Promise<NumberExistingResult> {
		if (visiting.has(threadID)) throw new Error(`Effective parent cycle contains ${threadID}`)
		visiting.add(threadID)
		try {
			let thread = await this.adapter.getThread(threadID)
			if (!thread?.title?.trim()) throw new Error(`Thread ${threadID} does not have a semantic title yet`)

			let parent: ThreadSummary | undefined
			if (thread.parentThreadID !== null) {
				parent = await this.adapter.getThread(thread.parentThreadID)
				if (!parent) throw new Error(`Effective parent ${thread.parentThreadID} was not found`)
				const parentResult = await this.numberExistingRecursive(parent.id, visiting)
				if (parentResult.status === 'invalid') {
					return { status: 'invalid', warnings: [`Cannot number ${threadID}: effective parent ${parent.id} has an invalid prefix.`] }
				}
				parent = await this.adapter.getThread(parent.id)
			}

			const existing = this.existingAddressStatus(thread, parent)
			if (existing !== 'unnumbered') return existing

			thread = await this.adapter.getThread(threadID)
			if (!thread?.title?.trim()) throw new Error(`Thread ${threadID} does not have a semantic title yet`)
			if (thread.parentThreadID !== null) parent = await this.adapter.getThread(thread.parentThreadID)
			const refreshed = this.existingAddressStatus(thread, parent)
			if (refreshed !== 'unnumbered') return refreshed

			const observedTitle = thread.title
			const address = await this.allocator.allocate(threadID, thread.parentThreadID)
			if (parent) this.requireDirectChild(parent, address)
			else if (address.length !== 1) throw new Error('Hierarchy service returned a non-root address for a root thread')
			const latest = await this.adapter.getThread(threadID)
			if (latest?.title !== observedTitle) {
				return { status: 'invalid', warnings: [`Thread ${threadID} changed title during allocation; automatic numbering will retry later.`] }
			}
			await this.adapter.setTitle(threadID, formatThreadTitle(address, observedTitle))
			return { status: 'numbered', warnings: [] }
		} finally {
			visiting.delete(threadID)
		}
	}

	private existingAddressStatus(thread: ThreadSummary, parent: ThreadSummary | undefined): NumberExistingResult | 'unnumbered' {
		let address: Address
		try {
			address = parseThreadTitle(thread.title ?? '').address
		} catch {
			return 'unnumbered'
		}
		const valid = thread.parentThreadID === null
			? address.length === 1
			: parent?.title
				? directChildSuffix(parseThreadTitle(parent.title).address, address) !== undefined
				: false
		if (valid) return { status: 'already-numbered', warnings: [] }
		return { status: 'invalid', warnings: [`Thread ${thread.id} has a valid-looking prefix that conflicts with its effective parent; no automatic rename was performed.`] }
	}

	private requireDirectChild(parent: ThreadSummary, address: Address): void {
		if (!parent.title || directChildSuffix(parseThreadTitle(parent.title).address, address) === undefined) {
			throw new Error('Hierarchy service returned an address outside the effective parent lineage')
		}
	}
}
