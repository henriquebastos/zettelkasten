import { env, exports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'

const ADMIN_TOKEN = 'test-admin-token'
const worker = exports as unknown as {
  default: {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>
  }
}
const bindings = env as unknown as {
  HIERARCHIES: DurableObjectNamespace
}

interface Namespace {
  namespaceID: string
  capabilityToken: string
}

interface ElementRecord {
  key: string
  parentKey: string | null
  ordinal: number
  ordinalPath: number[]
  address: string
}

describe('namespaced hierarchy service', () => {
  it('requires service administration credentials to create namespaces', async () => {
    const response = await post('/v1/admin/namespaces', { name: 'private' }, 'wrong')

    expect(response.status).toBe(401)
  })

  it('keeps initializing namespaces closed until activation', async () => {
    const namespace = await createNamespace('initializing')
    const response = await createElement(namespace, 'amp:T-1', null)

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'namespace_initializing' })
  })

  it('recovers namespace metadata and rotates a lost capability by Durable Object ID', async () => {
    const namespace = await createNamespace('recovery')
    const objectID = bindings.HIERARCHIES
      .idFromName(`namespace-v1:${namespace.namespaceID}`)
      .toString()

    const recovered = await admin(
      `/v1/admin/recovery/objects/${objectID}/token:rotate`,
      {},
    )
    expect(recovered.status).toBe(200)
    const body = await recovered.json() as Namespace & { name: string; state: string }
    expect(body).toMatchObject({
      namespaceID: namespace.namespaceID,
      name: 'recovery',
      state: 'initializing',
    })
    expect(body.capabilityToken).not.toBe(namespace.capabilityToken)

    await activate(body)
    expect((await createElement(namespace, 'old-token', null)).status).toBe(401)
    expect((await createElement(body, 'new-token', null)).status).toBe(201)
  })

  it('allocates and renders a hierarchy from opaque cross-system keys', async () => {
    const namespace = await activeNamespace('shared-research')

    expect(await element(await createElement(namespace, 'amp:T-1', null))).toMatchObject({
      ordinalPath: [1],
      address: '1',
    })
    expect(await element(await createElement(namespace, 'claude-code:run-1', 'amp:T-1'))).toMatchObject({
      ordinalPath: [1, 1],
      address: '1a',
    })
    expect(
      await element(await createElement(namespace, 'sha256:abc123', 'claude-code:run-1')),
    ).toMatchObject({ ordinalPath: [1, 1, 1], address: '1a1' })
  })

  it('returns the same assignment for idempotent retries', async () => {
    const namespace = await activeNamespace('retry')
    const first = await createElement(namespace, 'document:stable-id', null)
    const retry = await createElement(namespace, 'document:stable-id', null)

    expect(first.status).toBe(201)
    expect(retry.status).toBe(200)
    expect(await retry.json()).toEqual(await first.json())
  })

  it('requires parents to exist and keeps parentage immutable', async () => {
    const namespace = await activeNamespace('parents')
    expect((await createElement(namespace, 'child', 'missing')).status).toBe(404)

    await createElement(namespace, 'root-1', null)
    await createElement(namespace, 'root-2', null)
    await createElement(namespace, 'child', 'root-1')
    const conflict = await createElement(namespace, 'child', 'root-2')

    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({ code: 'parent_conflict' })
  })

  it('allocates unique contiguous ordinals to concurrent siblings', async () => {
    const namespace = await activeNamespace('concurrency')
    await createElement(namespace, 'parent', null)

    const responses = await Promise.all(
      Array.from({ length: 50 }, (_, index) => createElement(namespace, `client:${index}`, 'parent')),
    )
    expect(responses.every((response) => response.status === 201)).toBe(true)

    const records = await Promise.all(responses.map(element))
    expect(records.map(({ ordinal }) => ordinal).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 50 }, (_, index) => index + 1),
    )
  })

  it('isolates namespace credentials and ordinal sequences', async () => {
    const first = await activeNamespace('first')
    const second = await activeNamespace('second')

    expect((await createElement(first, 'same-key', null)).status).toBe(201)
    expect((await createElement(second, 'same-key', null)).status).toBe(201)
    expect((await post(elementsPath(second), { key: 'intruder', parentKey: null }, first.capabilityToken)).status)
      .toBe(401)
  })

  it('imports and verifies established addresses before activation', async () => {
    const namespace = await createNamespace('amp-existing')
    const response = await admin(
      `/v1/admin/namespaces/${namespace.namespaceID}/imports`,
      {
        elements: [
          { key: 'amp:T-root', parentKey: null, ordinal: 3, address: '3' },
          { key: 'amp:T-child', parentKey: 'amp:T-root', ordinal: 1, address: '3a' },
          { key: 'amp:T-grandchild', parentKey: 'amp:T-child', ordinal: 2, address: '3a2' },
        ],
      },
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ imported: 3 })
    await activate(namespace)
    const created = await element(await createElement(namespace, 'amp:T-next-root', null))
    expect(created).toMatchObject({ ordinal: 4, address: '4' })
  })

  it('rolls back an entire import batch when address verification fails', async () => {
    const namespace = await createNamespace('rollback')
    const failed = await admin(
      `/v1/admin/namespaces/${namespace.namespaceID}/imports`,
      {
        elements: [
          { key: 'root', parentKey: null, ordinal: 1, address: '1' },
          { key: 'child', parentKey: 'root', ordinal: 1, address: 'wrong' },
        ],
      },
    )
    expect(failed.status).toBe(409)

    const retry = await admin(
      `/v1/admin/namespaces/${namespace.namespaceID}/imports`,
      { elements: [{ key: 'root', parentKey: null, ordinal: 1, address: '1' }] },
    )
    expect(await retry.json()).toEqual({ imported: 1 })
  })

  it('rejects and rolls back imports beyond the maximum depth', async () => {
    const namespace = await createNamespace('depth')
    const elements = Array.from({ length: 65 }, (_, index) => ({
      key: `level-${index + 1}`,
      parentKey: index === 0 ? null : `level-${index}`,
      ordinal: 1,
    }))

    const failed = await admin(
      `/v1/admin/namespaces/${namespace.namespaceID}/imports`,
      { elements },
    )
    expect(failed.status).toBe(409)
    expect(await failed.json()).toMatchObject({ code: 'maximum_depth_exceeded' })

    const retry = await admin(
      `/v1/admin/namespaces/${namespace.namespaceID}/imports`,
      { elements: [elements[0]] },
    )
    expect(await retry.json()).toEqual({ imported: 1 })
  })
})

async function createNamespace(name: string): Promise<Namespace> {
  const response = await admin('/v1/admin/namespaces', { name })
  expect(response.status).toBe(201)
  return response.json() as Promise<Namespace>
}

async function activeNamespace(name: string): Promise<Namespace> {
  const namespace = await createNamespace(name)
  await activate(namespace)
  return namespace
}

async function activate(namespace: Namespace): Promise<void> {
  const response = await admin(`/v1/admin/namespaces/${namespace.namespaceID}/activate`, {})
  expect(response.status).toBe(200)
}

function createElement(namespace: Namespace, key: string, parentKey: string | null): Promise<Response> {
  return post(elementsPath(namespace), { key, parentKey }, namespace.capabilityToken)
}

function elementsPath(namespace: Namespace): string {
  return `/v1/namespaces/${namespace.namespaceID}/elements`
}

function admin(path: string, body: unknown): Promise<Response> {
  return post(path, body, ADMIN_TOKEN)
}

function post(path: string, body: unknown, token: string): Promise<Response> {
  return worker.default.fetch(`https://hierarchy.test${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

async function element(response: Response): Promise<ElementRecord> {
  expect([200, 201]).toContain(response.status)
  return response.json() as Promise<ElementRecord>
}
