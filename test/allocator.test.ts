import { exports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'

const TOKEN = 'test-token'
const worker = exports as unknown as {
  default: {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>
  }
}

describe('Zettelkasten allocator', () => {
  it('requires authentication', async () => {
    const response = await reserve(threadID(1), null, '')

    expect(response.status).toBe(401)
  })

  it('returns the same reservation when a request is retried', async () => {
    const thread = threadID(2)
    const parent = threadID(3)

    const first = await reserve(thread, parent)
    const retry = await reserve(thread.toLowerCase(), parent.toUpperCase())

    expect(first.status).toBe(201)
    expect(retry.status).toBe(200)
    expect(await retry.json()).toEqual(await first.json())
  })

  it('rejects case-varied self-parenting', async () => {
    const thread = threadID(10)
    const response = await reserve(thread, thread.toLowerCase())

    expect(response.status).toBe(400)
  })

  it('rejects changing the parent of an existing reservation', async () => {
    const thread = threadID(4)

    expect((await reserve(thread, threadID(5))).status).toBe(201)
    const response = await reserve(thread, threadID(6))

    expect(response.status).toBe(409)
  })

  it('allocates unique contiguous ordinals to concurrent siblings', async () => {
    const parent = threadID(7)
    const responses = await Promise.all(
      Array.from({ length: 50 }, (_, index) => reserve(threadID(100 + index), parent)),
    )

    expect(responses.every((response) => response.status === 201)).toBe(true)
    const reservations = await Promise.all(
      responses.map((response) => response.json() as Promise<{ ordinal: number }>),
    )
    expect(reservations.map(({ ordinal }) => ordinal).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 50 }, (_, index) => index + 1),
    )
  })

  it('coalesces concurrent retries for one thread', async () => {
    const thread = threadID(8)
    const parent = threadID(9)
    const responses = await Promise.all(Array.from({ length: 20 }, () => reserve(thread, parent)))
    const reservations = await Promise.all(
      responses.map((response) => response.json() as Promise<{ ordinal: number }>),
    )

    expect(new Set(reservations.map(({ ordinal }) => ordinal)).size).toBe(1)
    expect(responses.filter((response) => response.status === 201)).toHaveLength(1)
    expect(responses.filter((response) => response.status === 200)).toHaveLength(19)
  })
})

function reserve(threadID: string, parentThreadID: string | null, token = TOKEN): Promise<Response> {
  return worker.default.fetch('https://allocator.test/v1/allocations', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ threadID, parentThreadID }),
  })
}

function threadID(value: number): string {
  return `T-00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`
}
