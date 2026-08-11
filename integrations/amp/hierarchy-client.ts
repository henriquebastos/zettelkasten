import { parseAddress, type Address } from './address'

export interface HierarchyAssignment {
	key: string
	parentKey: string | null
	address: string
}

export interface HierarchyAllocator {
	allocate(threadID: `T-${string}`, parentThreadID: `T-${string}` | null): Promise<Address>
}

export class HierarchyAllocationError extends Error {
	constructor(
		message: string,
		readonly status?: number,
		readonly code?: string,
	) {
		super(message)
		this.name = 'HierarchyAllocationError'
	}
}

export class RemoteHierarchyAllocator implements HierarchyAllocator {
	constructor(
		private readonly serviceURL: string,
		private readonly namespaceID: string,
		private readonly capability: string,
		private readonly request: typeof fetch = fetch,
	) {}

	async allocate(threadID: `T-${string}`, parentThreadID: `T-${string}` | null): Promise<Address> {
		if (!this.serviceURL || !this.namespaceID || !this.capability) {
			throw new HierarchyAllocationError(
				'Zettelkasten configuration is incomplete. Set ZETTELKASTEN_SERVICE_URL, ZETTELKASTEN_NAMESPACE_ID, and ZETTELKASTEN_NAMESPACE_CAPABILITY.',
			)
		}
		const key = `amp:${threadID}`
		const parentKey = parentThreadID === null ? null : `amp:${parentThreadID}`
		let response: Response
		try {
			response = await this.request(
				`${this.serviceURL}/v1/namespaces/${this.namespaceID}/elements`,
				{
					method: 'POST',
					headers: {
						authorization: `Bearer ${this.capability}`,
						'content-type': 'application/json',
					},
					body: JSON.stringify({ key, parentKey }),
				},
			)
		} catch {
			throw new HierarchyAllocationError('Hierarchy service is unavailable; numbering was deferred.')
		}

		let body: unknown
		try {
			body = await response.json()
		} catch {
			throw new HierarchyAllocationError(
				`Hierarchy service returned an invalid response; numbering was deferred.`,
				response.status,
			)
		}
		if (response.status !== 200 && response.status !== 201) {
			const code = body && typeof body === 'object' && typeof Reflect.get(body, 'code') === 'string'
				? Reflect.get(body, 'code') as string
				: undefined
			throw new HierarchyAllocationError(
				`Hierarchy service rejected allocation${code ? ` (${code})` : ''}; numbering was deferred.`,
				response.status,
				code,
			)
		}
		if (!body || typeof body !== 'object' || Array.isArray(body)) {
			throw new HierarchyAllocationError('Hierarchy service returned an invalid assignment; numbering was deferred.')
		}
		const assignment = body as Partial<HierarchyAssignment>
		if (assignment.key !== key || assignment.parentKey !== parentKey || typeof assignment.address !== 'string') {
			throw new HierarchyAllocationError('Hierarchy service returned a conflicting assignment; numbering was deferred.')
		}
		try {
			return parseAddress(assignment.address)
		} catch {
			throw new HierarchyAllocationError('Hierarchy service returned an invalid address; numbering was deferred.')
		}
	}
}
